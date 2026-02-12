/**
 * ERC-8128 HTTP Message Signatures for Control API authentication.
 *
 * Workers sign every Control API request with their on-chain private key.
 * The Control API verifies signatures and extracts the worker address
 * from the cryptographic keyid — replacing the bare X-Worker-Address header.
 *
 * Uses @slicekit/erc8128 (RFC 9421 + Ethereum signatures).
 */
import {
  signRequest,
  verifyRequest as erc8128VerifyRequest,
  type EthHttpSigner,
  type NonceStore,
  type VerifyMessageFn,
  type VerifyResult,
  type VerifyPolicy,
  type SetHeadersFn,
} from '@slicekit/erc8128';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';

import { getRequiredWorkerPrivateKey } from '../config/index.js';

// ============================================================================
// Client-side: Signer construction + request signing
// ============================================================================

let _signer: EthHttpSigner | null = null;

/**
 * Lazy singleton signer from the worker's private key.
 * The address and chainId are embedded in the ERC-8128 keyid.
 */
export function getControlApiSigner(): EthHttpSigner {
  if (_signer) return _signer;

  const key = getRequiredWorkerPrivateKey();
  const account = privateKeyToAccount(key as `0x${string}`);

  _signer = {
    address: account.address,
    chainId: 8453, // Base
    signMessage: (msg: Uint8Array) =>
      account.signMessage({ message: { raw: msg } }),
  };

  return _signer;
}

/**
 * Sign a Control API request and return headers with ERC-8128 signature fields.
 *
 * Builds a Web API Request, signs it, then extracts the signature headers
 * so they can be merged into the existing postJson header flow.
 *
 * @param url - The Control API URL
 * @param body - The request body (will be JSON.stringified)
 * @param headers - Existing headers to preserve
 * @returns Headers with signature-input, signature, and content-digest added
 */
export async function signControlApiHeaders(
  url: string,
  body: any,
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  const signer = getControlApiSigner();
  const jsonBody = JSON.stringify(body);

  const req = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: jsonBody,
  });

  const signed = await signRequest(req, signer, {
    binding: 'request-bound',
    replay: 'non-replayable',
    ttlSeconds: 60,
  });

  // Extract signature headers from the signed request
  const result = { ...headers };
  for (const key of ['signature-input', 'signature', 'content-digest']) {
    const val = signed.headers.get(key);
    if (val) result[key] = val;
  }

  return result;
}

// ============================================================================
// Server-side: Nonce store + verification helpers
// ============================================================================

/**
 * In-memory nonce store with TTL-based expiration.
 * Tracks seen nonces and garbage-collects expired entries on access.
 */
export class InMemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();

  async consume(key: string, ttlSeconds: number): Promise<boolean> {
    this.gc();
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now() + ttlSeconds * 1000);
    return true;
  }

  private gc(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(key);
      }
    }
  }
}

/**
 * Verify an ERC-191 personal_sign message using viem.
 * Matches the VerifyMessageFn shape expected by @slicekit/erc8128.
 */
export const ethVerifyMessage: VerifyMessageFn = async (args) => {
  try {
    const valid = await verifyMessage({
      address: args.address,
      message: { raw: args.message.raw },
      signature: args.signature,
    });
    return valid;
  } catch {
    return false;
  }
};

/**
 * Verify an incoming HTTP request's ERC-8128 signature.
 * Thin wrapper that bundles our verifyMessage and nonceStore.
 */
export async function verifyControlApiRequest(
  request: Request,
  nonceStore: NonceStore,
  policy?: VerifyPolicy,
  setHeaders?: SetHeadersFn,
): Promise<VerifyResult> {
  return erc8128VerifyRequest(
    request,
    ethVerifyMessage,
    nonceStore,
    { maxValiditySec: 120, clockSkewSec: 10, ...policy },
    setHeaders,
  );
}

// Re-export types consumers need
export type {
  EthHttpSigner,
  NonceStore,
  VerifyMessageFn,
  VerifyResult,
  VerifyPolicy,
};
