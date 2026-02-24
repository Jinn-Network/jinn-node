import type { Helia } from '@helia/interface';
import toBuffer from 'it-to-buffer';
import { digestHexToCid } from './cid.js';
import { fetchLegacyContent } from './legacy.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Retrieve JSON content from the Helia blockstore by digest hex.
 * Tries the private network first (raw codec CIDv1), then falls back
 * to legacy HTTP gateway resolution for historical dag-pb content.
 * Returns null if content is not found or timeout is reached.
 */
export async function ipfsRetrieveJson(
  helia: Helia,
  digestHex: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown | null> {
  // Try private network first (raw codec CIDv1)
  const cid = digestHexToCid(digestHex);
  try {
    const bytes = await toBuffer(helia.blockstore.get(cid, {
      signal: AbortSignal.timeout(timeoutMs),
    }));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Not in private network — try legacy HTTP gateway
  }

  return fetchLegacyContent(digestHex, { timeoutMs });
}
