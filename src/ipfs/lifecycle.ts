import type { Helia } from '@helia/interface';
import { createJinnNode, type JinnNodeConfig } from './node.js';

let heliaInstance: Helia | null = null;

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
 * Stop the Helia node and release resources.
 * Called during graceful shutdown.
 */
export async function stopHeliaNode(): Promise<void> {
  if (heliaInstance) {
    await heliaInstance.stop();
    heliaInstance = null;
  }
}
