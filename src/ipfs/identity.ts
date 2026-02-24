import { privateKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256 } from 'viem';
import type { PeerId, Secp256k1PeerId } from '@libp2p/interface';
import { hexToBytes } from './cid.js';

/**
 * Create a libp2p PeerId from a secp256k1 private key (hex string).
 * The resulting PeerId is mathematically linked to the Ethereum address.
 */
export function privateKeyToPeerId(privateKeyHex: string): PeerId {
  const keyBytes = hexToBytes(privateKeyHex);
  const privKey = privateKeyFromRaw(keyBytes);
  return peerIdFromPrivateKey(privKey);
}

/**
 * Derive the Ethereum address from a libp2p PeerId.
 * Only works with secp256k1 PeerIds.
 */
export function peerIdToEthAddress(peerId: PeerId): string {
  const secpPeerId = peerId as Secp256k1PeerId;
  if (!secpPeerId.publicKey || secpPeerId.type !== 'secp256k1') {
    throw new Error(`Expected secp256k1 PeerId, got ${secpPeerId.type}`);
  }

  // Get compressed public key (33 bytes) from PeerId
  const compressed = secpPeerId.publicKey.raw;
  const compressedHex = Array.from(compressed).map(b => b.toString(16).padStart(2, '0')).join('');

  // Decompress to 65 bytes (0x04 prefix + 64 bytes x,y)
  const point = secp256k1.ProjectivePoint.fromHex(compressedHex);
  const uncompressed = point.toRawBytes(false);

  // Ethereum address = keccak256(uncompressed_pubkey_without_prefix)[12:]
  const pubKeyNoPrefix = uncompressed.slice(1);
  const hexStr = '0x' + Array.from(pubKeyNoPrefix).map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = keccak256(hexStr as `0x${string}`);
  return `0x${hash.slice(26)}`;
}
