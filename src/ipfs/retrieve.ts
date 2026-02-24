import type { Helia } from '@helia/interface';
import { digestHexToCid } from './cid.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Retrieve JSON content from the Helia blockstore by digest hex.
 * When the CID is not in the local blockstore, Helia's bitswap
 * automatically queries connected peers (with timeout).
 * Returns null if content is not found or timeout is reached.
 */
export async function ipfsRetrieveJson(
  helia: Helia,
  digestHex: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown | null> {
  const cid = digestHexToCid(digestHex);
  try {
    const bytes = await helia.blockstore.get(cid, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
