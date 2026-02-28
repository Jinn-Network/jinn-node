import type { Helia } from '@helia/interface';
import toBuffer from 'it-to-buffer';
import { digestHexToCid } from './cid.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Retrieve JSON content from the Helia blockstore by digest hex.
 * Returns the parsed JSON if found in the private network, or null if not.
 *
 * NOTE: This does NOT fall back to HTTP gateways. Content must be in the
 * private IPFS network. For historical pre-migration content, use
 * fetchLegacyContent() from './legacy.js' explicitly.
 */
export async function ipfsRetrieveJson(
  helia: Helia,
  digestHex: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown | null> {
  const cid = digestHexToCid(digestHex);
  try {
    const bytes = await toBuffer(helia.blockstore.get(cid, {
      signal: AbortSignal.timeout(timeoutMs),
    }));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // Content not found in private network — do NOT fall back to HTTP
    return null;
  }
}

