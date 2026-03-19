/**
 * EventPoller - Lightweight ethers.js event polling for 8183 + 8004
 *
 * No Ponder, no indexer — just periodic getLogs() calls with block range tracking.
 * Checkpoints to a JSON file on disk for restart resilience.
 *
 * Part of JINN-457: Invariant Restoration Marketplace on EIP-8183
 */

import { JsonRpcProvider, Interface, Log, ethers } from 'ethers';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRpcProvider } from '../../config/index.js';
import { logger } from '../../logging/index.js';
import { ACP_CORE_ABI, ACP_CORE_ADDRESS } from '../contracts/RestorationMarketplace.js';
import type {
  PolledEvent,
  MarketplaceEvent,
  DocumentEvent,
  PollerCheckpoint,
  JobCreatedEvent,
  JobFundedEvent,
  JobSubmittedEvent,
  JobCompletedEvent,
  JobRejectedEvent,
  JobExpiredEvent,
  DocumentRegisteredEvent,
} from './types.js';

const log = logger.child({ component: 'EVENT-POLLER' });

// ADW Registry on Base
const ADW_REGISTRY_ADDRESS = '0x40Eac2B201D12b13b442c330eED0A2aB04b06DeE';

const ADW_REGISTRY_ABI = [
  'event Registered(uint256 indexed documentId, string documentURI, bytes32 contentHash, string documentType)',
];

/** Maximum blocks per getLogs request (avoid RPC limits) */
const MAX_BLOCK_RANGE = 10_000;

/** Default start block (approximate ACPCore deployment block on Base) */
const DEFAULT_START_BLOCK = 29_000_000;

export interface EventPollerConfig {
  /** ACPCore contract address */
  acpAddress?: string;
  /** ADW Registry contract address */
  adwAddress?: string;
  /** Path to checkpoint file */
  checkpointPath?: string;
  /** Custom RPC provider */
  provider?: JsonRpcProvider;
  /** Block to start from if no checkpoint exists */
  startBlock?: number;
}

export class EventPoller {
  private provider: JsonRpcProvider;
  private acpIface: Interface;
  private adwIface: Interface;
  private acpAddress: string;
  private adwAddress: string;
  private checkpointPath: string | null;
  private lastBlock: number;

  // In-memory event cache (most recent events for quick lookup)
  private recentEvents: PolledEvent[] = [];
  private maxCacheSize = 1000;

  constructor(config: EventPollerConfig = {}) {
    this.provider = config.provider ?? createRpcProvider();
    this.acpAddress = config.acpAddress ?? ACP_CORE_ADDRESS;
    this.adwAddress = config.adwAddress ?? ADW_REGISTRY_ADDRESS;
    this.checkpointPath = config.checkpointPath ?? null;
    this.acpIface = new Interface(ACP_CORE_ABI);
    this.adwIface = new Interface(ADW_REGISTRY_ABI);

    // Load checkpoint or use default
    this.lastBlock = config.startBlock ?? DEFAULT_START_BLOCK;
    if (this.checkpointPath) {
      this.loadCheckpoint();
    }
  }

  /**
   * Poll for new events since last checkpoint.
   * Returns all new events found.
   */
  async poll(): Promise<PolledEvent[]> {
    const currentBlock = await this.provider.getBlockNumber();

    if (currentBlock <= this.lastBlock) {
      return [];
    }

    const allEvents: PolledEvent[] = [];

    // Process in chunks to avoid RPC limits
    let fromBlock = this.lastBlock + 1;
    while (fromBlock <= currentBlock) {
      const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE - 1, currentBlock);

      try {
        // Fetch 8183 + 8004 events in parallel
        const [acpLogs, adwLogs] = await Promise.all([
          this.provider.getLogs({ address: this.acpAddress, fromBlock, toBlock }),
          this.provider.getLogs({ address: this.adwAddress, fromBlock, toBlock }),
        ]);

        for (const eventLog of acpLogs) {
          const parsed = this.parseAcpLog(eventLog);
          if (parsed) allEvents.push(parsed);
        }
        for (const eventLog of adwLogs) {
          const parsed = this.parseAdwLog(eventLog);
          if (parsed) allEvents.push(parsed);
        }
      } catch (err) {
        log.warn({ fromBlock, toBlock, err }, 'Error fetching logs, will retry next poll');
        break; // Don't advance lastBlock on error
      }

      fromBlock = toBlock + 1;
    }

    // Update checkpoint
    if (allEvents.length > 0 || fromBlock > this.lastBlock + 1) {
      this.lastBlock = Math.min(fromBlock - 1, currentBlock);
      this.saveCheckpoint();
    }

    // Update cache
    this.recentEvents.push(...allEvents);
    if (this.recentEvents.length > this.maxCacheSize) {
      this.recentEvents = this.recentEvents.slice(-this.maxCacheSize);
    }

    if (allEvents.length > 0) {
      log.info({ count: allEvents.length, lastBlock: this.lastBlock }, 'Polled new events');
    }

    return allEvents;
  }

  // ============ Convenience Filters ============

  /** Get all funded (available) jobs from cache */
  getFundedJobs(): JobFundedEvent[] {
    return this.recentEvents.filter((e): e is JobFundedEvent => e.type === 'JobFunded');
  }

  /** Get all submitted (awaiting evaluation) jobs from cache */
  getSubmittedJobs(): JobSubmittedEvent[] {
    return this.recentEvents.filter((e): e is JobSubmittedEvent => e.type === 'JobSubmitted');
  }

  /** Get all created jobs from cache */
  getCreatedJobs(): JobCreatedEvent[] {
    return this.recentEvents.filter((e): e is JobCreatedEvent => e.type === 'JobCreated');
  }

  /** Get all document registration events from cache */
  getDocuments(): DocumentRegisteredEvent[] {
    return this.recentEvents.filter((e): e is DocumentRegisteredEvent => e.type === 'DocumentRegistered');
  }

  /** Get all events for a specific job */
  getJobEvents(jobId: number): MarketplaceEvent[] {
    return this.recentEvents.filter(
      (e): e is MarketplaceEvent => 'jobId' in e && (e as any).jobId === jobId,
    );
  }

  /** Get the latest block that was polled */
  getLastBlock(): number {
    return this.lastBlock;
  }

  // ============ Log Parsing ============

  private parseAcpLog(eventLog: Log): MarketplaceEvent | null {
    try {
      const parsed = this.acpIface.parseLog({
        topics: eventLog.topics as string[],
        data: eventLog.data,
      });
      if (!parsed) return null;

      const base = {
        blockNumber: eventLog.blockNumber,
        transactionHash: eventLog.transactionHash,
        logIndex: eventLog.index,
      };

      switch (parsed.name) {
        case 'JobCreated':
          return {
            ...base,
            type: 'JobCreated',
            jobId: Number(parsed.args.jobId),
            client: parsed.args.client,
            evaluator: parsed.args.evaluator,
            provider: parsed.args.provider,
            hook: parsed.args.hook,
            expiredAt: parsed.args.expiredAt,
          } satisfies JobCreatedEvent;

        case 'JobFunded':
          return {
            ...base,
            type: 'JobFunded',
            jobId: Number(parsed.args.jobId),
            amount: parsed.args.amount,
          } satisfies JobFundedEvent;

        case 'JobSubmitted':
          return {
            ...base,
            type: 'JobSubmitted',
            jobId: Number(parsed.args.jobId),
            deliverable: ethers.toUtf8String(parsed.args.deliverable),
          } satisfies JobSubmittedEvent;

        case 'JobCompleted':
          return {
            ...base,
            type: 'JobCompleted',
            jobId: Number(parsed.args.jobId),
            reason: ethers.toUtf8String(parsed.args.reason),
          } satisfies JobCompletedEvent;

        case 'JobRejected':
          return {
            ...base,
            type: 'JobRejected',
            jobId: Number(parsed.args.jobId),
            reason: ethers.toUtf8String(parsed.args.reason),
          } satisfies JobRejectedEvent;

        case 'JobExpired':
          return {
            ...base,
            type: 'JobExpired',
            jobId: Number(parsed.args.jobId),
          } satisfies JobExpiredEvent;

        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private parseAdwLog(eventLog: Log): DocumentEvent | null {
    try {
      const parsed = this.adwIface.parseLog({
        topics: eventLog.topics as string[],
        data: eventLog.data,
      });
      if (!parsed || parsed.name !== 'Registered') return null;

      return {
        blockNumber: eventLog.blockNumber,
        transactionHash: eventLog.transactionHash,
        logIndex: eventLog.index,
        type: 'DocumentRegistered',
        documentId: parsed.args.documentId,
        documentURI: parsed.args.documentURI,
        contentHash: parsed.args.contentHash,
        documentType: parsed.args.documentType,
      } satisfies DocumentRegisteredEvent;
    } catch {
      return null;
    }
  }

  // ============ Checkpoint Persistence ============

  private loadCheckpoint(): void {
    if (!this.checkpointPath || !existsSync(this.checkpointPath)) return;
    try {
      const raw = readFileSync(this.checkpointPath, 'utf-8');
      const checkpoint: PollerCheckpoint = JSON.parse(raw);
      this.lastBlock = checkpoint.lastBlock;
      log.info({ lastBlock: this.lastBlock }, 'Loaded poller checkpoint');
    } catch (err) {
      log.warn({ err }, 'Failed to load poller checkpoint, using default');
    }
  }

  private saveCheckpoint(): void {
    if (!this.checkpointPath) return;
    try {
      const checkpoint: PollerCheckpoint = {
        lastBlock: this.lastBlock,
        updatedAt: Date.now(),
      };
      writeFileSync(this.checkpointPath, JSON.stringify(checkpoint, null, 2));
    } catch (err) {
      log.warn({ err }, 'Failed to save poller checkpoint');
    }
  }
}
