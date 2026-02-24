import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';

/** Parse a hex string (with or without 0x prefix) into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  return new Uint8Array(clean.match(/.{2}/g)!.map(h => parseInt(h, 16)));
}

/**
 * Create a raw-codec CIDv1 from a JSON-serializable object.
 * The on-chain digest equals sha256(JSON.stringify(payload)).
 */
export async function jsonToCid(payload: unknown): Promise<CID> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const hash = await sha256.digest(bytes);
  return CID.create(1, raw.code, hash);
}

/**
 * Create a raw-codec CIDv1 from raw bytes.
 */
export async function bytesToCid(bytes: Uint8Array): Promise<CID> {
  const hash = await sha256.digest(bytes);
  return CID.create(1, raw.code, hash);
}

/**
 * Extract the 0x-prefixed sha256 digest hex from a CID.
 * This is the value stored on-chain in Deliver events.
 */
export function cidToDigestHex(cid: CID): string {
  const digestBytes = cid.multihash.digest;
  const hex = Array.from(digestBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `0x${hex}`;
}

/**
 * Reconstruct a raw-codec CIDv1 from an on-chain digest hex.
 * Accepts both 0x-prefixed and bare hex. Must be a 32-byte SHA-256 digest.
 */
export function digestHexToCid(digestHex: string): CID {
  const digestBytes = hexToBytes(digestHex);
  if (digestBytes.length !== 32) {
    throw new Error(`Expected 32-byte SHA-256 digest, got ${digestBytes.length} bytes`);
  }
  // Manually construct the multihash: 0x12 (sha2-256) + 0x20 (32 bytes) + digest
  const multihash = new Uint8Array([0x12, 0x20, ...digestBytes]);
  return CID.createV1(raw.code, { code: 0x12, size: 32, digest: digestBytes, bytes: multihash });
}
