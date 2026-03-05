/**
 * Per-Safe transaction mutex.
 *
 * Serializes all Safe execTransaction calls for the same Safe address
 * to prevent nonce collisions when delivery and dispatch (or multiple
 * dispatches) happen concurrently within the same worker process.
 *
 * Usage:
 *   const release = await acquireSafeLock(safeAddress);
 *   try { ... sign & exec ... } finally { release(); }
 */

const locks = new Map<string, Promise<void>>();

export async function acquireSafeLock(safeAddress: string): Promise<() => void> {
  const key = safeAddress.toLowerCase();

  // Chain onto whatever is currently queued for this Safe
  const prev = locks.get(key) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>(resolve => {
    release = resolve;
  });

  // Replace the queue tail with our promise (so the next caller waits on us)
  locks.set(key, next);

  // Wait for our turn
  await prev;

  return release;
}
