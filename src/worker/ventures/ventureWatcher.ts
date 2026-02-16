/**
 * Venture Watcher — periodic check of venture dispatch schedules.
 *
 * Runs inside the worker main loop (every N cycles when ENABLE_VENTURE_WATCHER=1).
 * For each active venture with a non-empty dispatch_schedule:
 *   1. Parse each cron entry → compute when the last dispatch should have occurred
 *   2. Query Ponder for recent dispatches with matching ventureId + templateId
 *   3. If none found since last cron tick → dispatch via dispatchFromTemplate()
 *
 * Double-dispatch prevention: Ponder is the coordination mechanism.
 * If two workers both see "no dispatch" and both post, the claim system
 * prevents double execution (only one agent processes the work).
 */

import { CronExpressionParser } from 'cron-parser';
import { workerLogger } from '../../logging/index.js';
import { listVentures, type Venture } from '../../data/ventures.js';
import { graphQLRequest } from '../../http/client.js';
import { getPonderGraphqlUrl } from '../../agent/mcp/tools/shared/env.js';
import { dispatchFromTemplate } from './ventureDispatch.js';
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
    const withSchedule = ventures.filter(
      v => Array.isArray(v.dispatch_schedule) && v.dispatch_schedule.length > 0
    );

    if (withSchedule.length === 0) return;

    workerLogger.debug({ ventureCount: withSchedule.length }, 'Venture watcher: checking schedules');

    for (const venture of withSchedule) {
      for (const entry of venture.dispatch_schedule) {
        if (entry.enabled === false) continue;

        try {
          await processScheduleEntry(venture, entry);
        } catch (err: any) {
          workerLogger.error(
            { ventureId: venture.id, entryId: entry.id, error: err?.message },
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
 * Process a single schedule entry for a venture.
 */
async function processScheduleEntry(venture: Venture, entry: ScheduleEntry): Promise<void> {
  const { due, lastTick } = isDue(entry.cron, new Date());
  if (!due) return;

  // Fast path: check in-memory tracker first (avoids Ponder lag issue)
  if (hasInMemoryDispatch(venture.id, entry.templateId, lastTick)) {
    workerLogger.debug(
      { ventureId: venture.id, entryId: entry.id, templateId: entry.templateId },
      'Venture watcher: skipping (in-memory dispatch record exists)'
    );
    return;
  }

  // Slow path: check Ponder for dispatches from other workers
  const alreadyDispatched = await hasRecentDispatch(
    venture.id,
    entry.templateId,
    lastTick
  );

  if (alreadyDispatched) {
    // Record in memory so we don't query Ponder again this tick
    recordDispatch(venture.id, entry.templateId);
    workerLogger.debug(
      { ventureId: venture.id, entryId: entry.id, templateId: entry.templateId },
      'Venture watcher: skipping (already dispatched since last tick)'
    );
    return;
  }

  workerLogger.info(
    { ventureId: venture.id, entryId: entry.id, templateId: entry.templateId, lastTick: lastTick.toISOString() },
    'Venture watcher: dispatching due schedule entry'
  );

  await dispatchFromTemplate(venture, entry);
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
 * Check Ponder for recent dispatches matching this venture + template since a timestamp.
 *
 * This is the double-dispatch prevention mechanism. On-chain truth via Ponder.
 */
export async function hasRecentDispatch(
  ventureId: string,
  templateId: string,
  since: Date
): Promise<boolean> {
  const sinceTimestamp = Math.floor(since.getTime() / 1000);

  try {
    const data = await graphQLRequest<{
      requests: { items: Array<{ id: string }> };
    }>({
      url: PONDER_GRAPHQL_URL,
      query: `query HasRecentDispatch($ventureId: String!, $templateId: String!, $since: BigInt!) {
        requests(
          where: { ventureId: $ventureId, templateId: $templateId, blockTimestamp_gte: $since }
          limit: 1
        ) {
          items { id }
        }
      }`,
      variables: { ventureId, templateId, since: sinceTimestamp.toString() },
      context: { operation: 'hasRecentDispatch' },
    });

    return (data?.requests?.items?.length ?? 0) > 0;
  } catch (err: any) {
    // On query failure, assume dispatch exists (conservative — avoids duplicate dispatch)
    workerLogger.warn(
      { ventureId, templateId, error: err?.message },
      'Venture watcher: Ponder query failed, assuming dispatch exists'
    );
    return true;
  }
}
