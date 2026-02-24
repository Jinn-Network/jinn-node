import type { Helia } from '@helia/interface';
import { digestHexToCid } from './cid.js';

/**
 * Retrieve JSON content from the Helia blockstore by digest hex.
 * When the CID is not in the local blockstore, Helia's bitswap
 * automatically queries connected peers.
 * Returns null if content is not found.
 */
export async function ipfsRetrieveJson(helia: Helia, digestHex: string): Promise<unknown | null> {
  const cid = digestHexToCid(digestHex);
  try {
    const bytes = await helia.blockstore.get(cid);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
