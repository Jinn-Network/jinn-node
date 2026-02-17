/**
 * Venture Watcher — periodic check of venture dispatch schedules.
 *
 * Runs inside the worker main loop (every N cycles when ENABLE_VENTURE_WATCHER=1).
 * For each active venture with a non-empty dispatch_schedule:
 *   1. Parse each cron entry → compute when the last dispatch should have occurred
 *   2. Build a deterministic jobDefinitionId from ventureId + entryId + cron tick
 *   3. Check Ponder for that exact jobDefinitionId (fast-path)
 *   4. Claim each dispatch slot atomically via Control API (correctness layer)
 *   5. Dispatch if the slot is still open
 *
 * Double-dispatch prevention: Two-layer.
 *   - Layer 1 (fast-path): Ponder check by deterministic jobDefinitionId.
 *   - Layer 2 (correctness): Supabase unique constraint via claimVentureDispatch
 *     ensures only one worker dispatches per entry per cron tick, even if Ponder
 *     has indexing lag.
 */

import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { workerLogger } from '../../logging/index.js';
import { listVentures, type Venture } from '../../data/ventures.js';
import { graphQLRequest } from '../../http/client.js';
import { getPonderGraphqlUrl } from '../../agent/mcp/tools/shared/env.js';
import { dispatchFromTemplate } from './ventureDispatch.js';
import { claimVentureDispatch } from '../control_api_client.js';
import type { ScheduleEntry } from '../../data/types/scheduleEntry.js';

const PONDER_GRAPHQL_URL = getPonderGraphqlUrl();

/**
 * In-memory dispatch tracking to prevent double-dispatches
 * caused by Ponder indexing lag (10-30s).
 * Key: `${ventureId}:${templateId}`, Value: timestamp of last dispatch.
 */
const recentDispatches = new Map<string, Date>();

/** Record a successful dispatch in the in-memory tracker. */
export function recordDispatch(ventureId: string, templateId: string): void {
  recentDispatches.set(`${ventureId}:${templateId}`, new Date());
}

/** Check if a dispatch was recorded in-memory since the given timestamp. */
function hasInMemoryDispatch(ventureId: string, templateId: string, since: Date): boolean {
  const key = `${ventureId}:${templateId}`;
  const lastDispatch = recentDispatches.get(key);
  if (!lastDispatch) return false;
  return lastDispatch.getTime() >= since.getTime();
}

/** Evict entries older than 24 hours to prevent unbounded growth. */
function evictStaleEntries(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, date] of recentDispatches) {
    if (date.getTime() < cutoff) recentDispatches.delete(key);
  }
}

/**
 * Check all active ventures and dispatch any due schedule entries.
 */
export async function checkAndDispatchScheduledVentures(): Promise<void> {
  try {
    evictStaleEntries();
    const ventures = await listVentures({ status: 'active' });

    // Respect VENTURE_FILTER env var — only dispatch for filtered ventures
    const ventureFilter = process.env.VENTURE_FILTER;
    const allowedIds = ventureFilter
      ? new Set(ventureFilter.split(',').map(s => s.trim()).filter(Boolean))
      : null;

    const withSchedule = ventures.filter(v => {
      if (!Array.isArray(v.dispatch_schedule) || v.dispatch_schedule.length === 0) return false;
      if (allowedIds && !allowedIds.has(v.id)) return false;
      return true;
    });

    if (withSchedule.length === 0) return;

    workerLogger.debug({ ventureCount: withSchedule.length, ventureFilter: ventureFilter || 'none' }, 'Venture watcher: checking schedules');

    for (const venture of withSchedule) {
      const now = new Date();
      for (const entry of venture.dispatch_schedule) {
        if (entry.enabled === false) continue;
        try {
          await processScheduleEntry(venture, entry, now);
        } catch (err: any) {
          workerLogger.error(
            { ventureId: venture.id, entryId: entry.id, templateId: entry.templateId, error: err?.message },
            'Venture watcher: failed to process schedule entry'
          );
        }
      }
    }
  } catch (err: any) {
    workerLogger.error({ error: err?.message }, 'Venture watcher: failed to check schedules');
  }
}

/**
 * Process one schedule entry with entry-specific tick accounting.
 */
async function processScheduleEntry(
  venture: Venture,
  entry: ScheduleEntry,
  now: Date,
): Promise<void> {
  const { due, lastTick } = isDue(entry.cron, now);
  if (!due) return;

  const scheduleTick = buildScheduleTick(lastTick, entry.id);
  const scheduledJobDefinitionId = buildScheduledJobDefinitionId(venture.id, entry.id, lastTick);

  // Fast path: check in-memory tracker first (avoids Ponder lag issue)
  if (hasInMemoryDispatch(venture.id, entry.templateId, lastTick)) {
    workerLogger.debug(
      { ventureId: venture.id, entryId: entry.id, templateId: entry.templateId },
      'Venture watcher: skipping (in-memory dispatch record exists)'
    );
    return;
  }

  const alreadyDispatched = await hasRecentDispatchForScheduledJobDefinition(scheduledJobDefinitionId);
  if (alreadyDispatched) {
    // Record in memory so we don't query Ponder again this tick
    recordDispatch(venture.id, entry.templateId);
    workerLogger.debug(
      { ventureId: venture.id, entryId: entry.id, templateId: entry.templateId, scheduledJobDefinitionId },
      'Venture watcher: skipping (already dispatched for this entry tick)'
    );
    return;
  }

  // Atomic claim gate — prevents two workers from both dispatching the same entry tick.
  try {
    const claim = await claimVentureDispatch(venture.id, entry.templateId, scheduleTick);
    if (!claim.allowed) {
      workerLogger.debug(
        { ventureId: venture.id, entryId: entry.id, templateId: entry.templateId, claimedBy: claim.claimed_by },
        'Venture watcher: another worker claimed this dispatch'
      );
      return;
    }
  } catch (claimErr: any) {
    // If Control API is unavailable, log a warning and fall through.
    // The entry-specific Ponder check above is still a conservative guard.
    workerLogger.warn(
      { ventureId: venture.id, entryId: entry.id, templateId: entry.templateId, error: claimErr?.message },
      'Venture watcher: claim gate failed, proceeding with Ponder-only guard'
    );
  }

  workerLogger.info(
    {
      ventureId: venture.id,
      entryId: entry.id,
      templateId: entry.templateId,
      lastTick: lastTick.toISOString(),
      scheduledJobDefinitionId
    },
    'Venture watcher: dispatching due schedule entry'
  );

  // Record BEFORE dispatch so failed attempts don't retry every loop iteration.
  // Next attempt happens at the next cron tick.
  recordDispatch(venture.id, entry.templateId);

  try {
    await dispatchFromTemplate(venture, entry, { jobDefinitionId: scheduledJobDefinitionId });
  } catch (err: any) {
    workerLogger.error(
      { ventureId: venture.id, entryId: entry.id, templateId: entry.templateId, error: err?.message },
      'Venture watcher: failed to dispatch schedule entry'
    );
  }
}

/**
 * Determine if a cron entry is due based on the current time.
 *
 * Returns { due: true, lastTick } when the most recent cron occurrence
 * is in the past. The caller should check Ponder for dispatches since lastTick.
 */
export function isDue(cron: string, now: Date): { due: boolean; lastTick: Date } {
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: now });
    const prev = interval.prev();
    const lastTick = prev.toDate();

    // Grace period: don't dispatch if lastTick is more than 24h ago
    // (prevents backfilling missed dispatches after long downtime)
    const ageMs = now.getTime() - lastTick.getTime();
    const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

    return {
      due: ageMs <= MAX_AGE_MS,
      lastTick,
    };
  } catch {
    workerLogger.warn({ cron }, 'Venture watcher: invalid cron expression');
    return { due: false, lastTick: now };
  }
}

/**
 * Build the claim key for a single schedule entry tick.
 */
export function buildScheduleTick(lastTick: Date, entryId: string): string {
  return `${lastTick.toISOString()}:${entryId}`;
}

/**
 * Build a deterministic UUID for one venture schedule entry tick.
 *
 * This lets us query Ponder by exact jobDefinitionId and avoid mixed-cadence
 * suppression when multiple entries share the same templateId.
 */
export function buildScheduledJobDefinitionId(
  ventureId: string,
  entryId: string,
  lastTick: Date
): string {
  const seed = `venture:${ventureId}:entry:${entryId}:tick:${lastTick.toISOString()}`;
  const bytes = Buffer.from(createHash('sha256').update(seed).digest('hex').slice(0, 32), 'hex');

  // RFC 4122 variant + v5-style version bits for UUID formatting compatibility.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Check whether this exact scheduled job definition ID is already on-chain.
 *
 * On query failure, returns true (conservative — avoids duplicate dispatch).
 */
export async function hasRecentDispatchForScheduledJobDefinition(
  jobDefinitionId: string
): Promise<boolean> {
  try {
    const data = await graphQLRequest<{
      requests: { items: Array<{ id: string }> };
    }>({
      url: PONDER_GRAPHQL_URL,
      query: `query HasRecentDispatchForScheduledJob($jobDefinitionId: String!) {
        requests(
          where: { jobDefinitionId: $jobDefinitionId }
          limit: 1
        ) {
          items { id }
        }
      }`,
      variables: { jobDefinitionId },
      context: { operation: 'hasRecentDispatchForScheduledJobDefinition', jobDefinitionId },
    });

    return (data?.requests?.items?.length ?? 0) > 0;
  } catch (err: any) {
    // On query failure, assume dispatched (conservative — avoids duplicate dispatch)
    workerLogger.warn(
      { jobDefinitionId, error: err?.message },
      'Venture watcher: Ponder query failed, assuming dispatch exists'
    );
    return true;
  }
}
