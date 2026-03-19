/**
 * SessionRouter - Routes worker epochs through CREATE/DELIVER/EVALUATE sessions
 *
 * Replaces the old processOnce() in the worker main loop.
 * Per epoch, schedules sessions to meet minimum requirements for OLAS staking.
 *
 * Part of JINN-457: Invariant Restoration Marketplace on EIP-8183
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../logging/index.js';
import { EventPoller } from '../polling/EventPoller.js';
import {
  RestorationMarketplace,
} from '../contracts/RestorationMarketplace.js';
import {
  SessionType,
  EpochProgress,
  SessionConfig,
  SessionResult,
  DEFAULT_SESSION_CONFIG,
} from './types.js';

const log = logger.child({ component: 'SESSION-ROUTER' });

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SessionRouterConfig {
  marketplace: RestorationMarketplace;
  poller: EventPoller;
  sessionConfig?: SessionConfig;
  /** Service multisig (Safe) address */
  multisigAddress: string;
  /** Function to execute an agent session with a prompt and get results */
  executeSession: (prompt: string, sessionType: SessionType, tools: string[]) => Promise<SessionResult>;
}

export class SessionRouter {
  private marketplace: RestorationMarketplace;
  private poller: EventPoller;
  private config: SessionConfig;
  private multisigAddress: string;
  private executeSession: SessionRouterConfig['executeSession'];
  private progress: EpochProgress;

  // Loaded prompts
  private prompts: Map<SessionType, string> = new Map();

  constructor(config: SessionRouterConfig) {
    this.marketplace = config.marketplace;
    this.poller = config.poller;
    this.config = config.sessionConfig ?? DEFAULT_SESSION_CONFIG;
    this.multisigAddress = config.multisigAddress;
    this.executeSession = config.executeSession;
    this.progress = {
      creates: 0,
      delivers: 0,
      evaluates: 0,
      epochStart: Math.floor(Date.now() / 1000),
    };

    this.loadPrompts();
  }

  /**
   * Get the next session type needed to meet epoch requirements.
   * Returns null if all requirements are met.
   */
  getNextSessionType(): SessionType | null {
    if (this.progress.creates < this.config.minCreatesPerEpoch) {
      return SessionType.CREATE;
    }
    if (this.progress.delivers < this.config.minDeliversPerEpoch) {
      return SessionType.DELIVER;
    }
    if (this.progress.evaluates < this.config.minEvaluatesPerEpoch) {
      return SessionType.EVALUATE;
    }
    return null;
  }

  /**
   * Check if there's work available for a given session type.
   * DELIVER needs funded jobs; EVALUATE needs submitted jobs.
   * CREATE can always run (it creates new jobs).
   */
  async hasWorkAvailable(sessionType: SessionType): Promise<boolean> {
    switch (sessionType) {
      case SessionType.CREATE:
        return true; // CREATE can always run

      case SessionType.DELIVER:
        // Trust the EventPoller cache — no on-chain fallback scanning
        return this.poller.getFundedJobs().length > 0;

      case SessionType.EVALUATE:
        return this.poller.getSubmittedJobs().length > 0;
    }
  }

  /**
   * Run one session cycle. Returns the result or null if no work needed/available.
   */
  async processOnce(): Promise<SessionResult | null> {
    // Poll for new events first
    await this.poller.poll();

    // Determine what session type is needed
    const sessionType = this.getNextSessionType();
    if (!sessionType) {
      log.debug('All epoch requirements met, nothing to do');
      return null;
    }

    // Check if there's work available for this type
    // For DELIVER/EVALUATE, skip if no jobs exist yet
    const hasWork = await this.hasWorkAvailable(sessionType);
    if (!hasWork) {
      log.info({ sessionType }, 'No work available for session type, trying next');
      // Try the next type that has work
      for (const fallback of [SessionType.CREATE, SessionType.DELIVER, SessionType.EVALUATE]) {
        if (fallback === sessionType) continue;
        if (this.getProgressForType(fallback) >= this.getMinForType(fallback)) continue;
        if (await this.hasWorkAvailable(fallback)) {
          return this.runSession(fallback);
        }
      }
      // Nothing has work — CREATE always works, fall back to it
      if (this.progress.creates < this.config.minCreatesPerEpoch) {
        return this.runSession(SessionType.CREATE);
      }
      return null;
    }

    return this.runSession(sessionType);
  }

  /**
   * Run a specific session type.
   */
  private async runSession(sessionType: SessionType): Promise<SessionResult> {
    const prompt = this.prompts.get(sessionType);
    if (!prompt) {
      throw new Error(`No prompt loaded for session type: ${sessionType}`);
    }

    const tools = this.getToolsForSession(sessionType);

    log.info({ sessionType, tools }, 'Starting session');
    const startTime = Date.now();

    try {
      const result = await this.executeSession(prompt, sessionType, tools);

      // Update epoch progress
      this.incrementProgress(sessionType);

      log.info({
        sessionType,
        success: result.success,
        jobId: result.jobId,
        durationMs: result.durationMs,
        documents: result.documentCIDs?.length ?? 0,
      }, 'Session completed');

      return result;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      log.error({ sessionType, err, durationMs }, 'Session failed');
      return {
        type: sessionType,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    }
  }

  /**
   * Reset epoch progress (called at epoch boundary).
   */
  resetEpoch(): void {
    this.progress = {
      creates: 0,
      delivers: 0,
      evaluates: 0,
      epochStart: Math.floor(Date.now() / 1000),
    };
    log.info('Epoch progress reset');
  }

  /**
   * Get current epoch progress.
   */
  getProgress(): EpochProgress {
    return { ...this.progress };
  }

  /**
   * Check if all epoch requirements are met.
   */
  isEpochComplete(): boolean {
    return this.getNextSessionType() === null;
  }

  // ============ Internal ============

  private getToolsForSession(sessionType: SessionType): string[] {
    switch (sessionType) {
      case SessionType.CREATE:
        return ['search_8004_documents', 'create_restoration_job'];
      case SessionType.DELIVER:
        return ['list_available_jobs', 'claim_job', 'submit_deliverable', 'search_8004_documents', 'create_8004_document'];
      case SessionType.EVALUATE:
        return ['list_submitted_jobs', 'get_deliverable', 'search_8004_documents', 'create_8004_document', 'complete_job', 'reject_job'];
    }
  }

  private incrementProgress(sessionType: SessionType): void {
    switch (sessionType) {
      case SessionType.CREATE: this.progress.creates++; break;
      case SessionType.DELIVER: this.progress.delivers++; break;
      case SessionType.EVALUATE: this.progress.evaluates++; break;
    }
  }

  private getProgressForType(sessionType: SessionType): number {
    switch (sessionType) {
      case SessionType.CREATE: return this.progress.creates;
      case SessionType.DELIVER: return this.progress.delivers;
      case SessionType.EVALUATE: return this.progress.evaluates;
    }
  }

  private getMinForType(sessionType: SessionType): number {
    switch (sessionType) {
      case SessionType.CREATE: return this.config.minCreatesPerEpoch;
      case SessionType.DELIVER: return this.config.minDeliversPerEpoch;
      case SessionType.EVALUATE: return this.config.minEvaluatesPerEpoch;
    }
  }

  private loadPrompts(): void {
    const promptDir = join(__dirname, 'prompts');
    for (const [type, file] of [
      [SessionType.CREATE, 'create.md'],
      [SessionType.DELIVER, 'deliver.md'],
      [SessionType.EVALUATE, 'evaluate.md'],
    ] as const) {
      const content = readFileSync(join(promptDir, file), 'utf-8');
      if (!content.trim()) {
        throw new Error(`Session prompt ${file} is empty`);
      }
      this.prompts.set(type, content);
      log.debug({ type, length: content.length }, 'Loaded session prompt');
    }
  }
}
