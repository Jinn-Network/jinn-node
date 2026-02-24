import type { Helia } from '@helia/interface';

const DEFAULT_MAX_BLOCKS = 250_000; // ~1GB at ~4KB per block

/**
 * Run garbage collection if the blockstore exceeds the block count threshold.
 * Counts blocks and calls helia.gc() if over the limit.
 *
 * Note: Helia's gc() removes unpinned blocks. In the private network,
 * all blocks are unpinned by default (we rely on the gateway service for
 * durable archival). Worker nodes only need recent content.
 */
export async function maybeRunGc(
  helia: Helia,
  maxBlocks: number = DEFAULT_MAX_BLOCKS,
): Promise<{ ran: boolean; blockCount: number }> {
  let blockCount = 0;
  try {
    for await (const _ of helia.blockstore.getAll()) {
      blockCount++;
      if (blockCount > maxBlocks) break;
    }
  } catch {
    return { ran: false, blockCount: 0 };
  }

  if (blockCount > maxBlocks) {
    try {
      await helia.gc({ signal: AbortSignal.timeout(30_000) });
      return { ran: true, blockCount };
    } catch {
      return { ran: false, blockCount };
    }
  }

  return { ran: false, blockCount };
}
