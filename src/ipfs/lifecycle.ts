import type { Helia } from '@helia/interface';
import { createJinnNode, type JinnNodeConfig } from './node.js';
import { maybeRunGc } from './gc.js';

let heliaInstance: Helia | null = null;
let gcCycleCount = 0;

/** How often (in worker poll cycles) to check storage and run GC. */
const GC_CHECK_INTERVAL = 100;

/**
 * Initialize the Helia IPFS node singleton.
 * Called once during worker startup. Subsequent calls return the existing instance.
 */
export async function initHeliaNode(config: JinnNodeConfig): Promise<Helia> {
  if (heliaInstance) return heliaInstance;
  heliaInstance = await createJinnNode(config);
  return heliaInstance;
}

/**
 * Get the initialized Helia node. Throws if not yet initialized.
 */
export function getHeliaNode(): Helia {
  if (!heliaInstance) throw new Error('Helia node not initialized — call initHeliaNode() first');
  return heliaInstance;
}

/**
 * Get the Helia node if initialized, or null otherwise.
 * Use this for optional Helia integration in paths that have HTTP fallbacks.
 */
export function getHeliaNodeOptional(): Helia | null {
  return heliaInstance;
}

/**
 * Check if GC should run this cycle and run it if needed.
 * Call this once per worker poll cycle.
 */
export async function maybeRunGcCycle(): Promise<void> {
  if (!heliaInstance) return;
  gcCycleCount++;
  if (gcCycleCount % GC_CHECK_INTERVAL !== 0) return;
  await maybeRunGc(heliaInstance);
}

/**
 * Stop the Helia node and release resources.
 * Called during graceful shutdown.
 */
export async function stopHeliaNode(): Promise<void> {
  if (heliaInstance) {
    await heliaInstance.stop();
    heliaInstance = null;
  }
}
