import type { Helia } from '@helia/interface';
import type { CID } from 'multiformats/cid';
import { jsonToCid, cidToDigestHex } from './cid.js';
import { publishContentAnnouncement } from './announcements.js';

/**
 * Upload JSON to the local Helia blockstore and announce via gossipsub.
 * Returns the CID and the 0x-prefixed digest hex (for on-chain storage).
 */
export async function ipfsUploadJson(
  helia: Helia,
  payload: unknown,
): Promise<{ digestHex: string; cid: CID }> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const cid = await jsonToCid(payload);
  await helia.blockstore.put(cid, bytes);
  await publishContentAnnouncement(helia, cid);
  return { digestHex: cidToDigestHex(cid), cid };
}
