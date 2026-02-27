/**
 * ADW EIP-712 Creator Signing
 *
 * Uses the worker's existing private key to produce an EIP-712 signature
 * binding creator to content hash. The signature is stored in the Registration
 * File under trust.creatorProof, upgrading trust from Level 0 (Declared)
 * to Level 1 (Signed).
 */

import type { ADWRegistrationFile, CreatorProof, Trust } from './types.js';

// EIP-712 domain separator for ADW
export const ADW_EIP712_DOMAIN = {
  name: 'Agentic Document Web',
  version: '0.1',
  chainId: 8453, // Base
} as const;

// EIP-712 type definitions for ADW document signing
export const ADW_EIP712_TYPES = {
  ADWDocument: [
    { name: 'contentHash', type: 'string' },
    { name: 'documentType', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'timestamp', type: 'string' },
  ],
} as const;

/**
 * Sign an ADW Registration File with EIP-712, returning the trust block.
 *
 * Requires viem at runtime — kept as a dynamic import so the pure types/builder
 * module stays zero-dependency.
 *
 * @param registration - The registration file to sign (contentHash, documentType, version, created)
 * @param privateKey - 0x-prefixed hex private key
 * @returns Trust object with creatorProof containing the EIP-712 signature
 */
export async function signRegistrationFile(
  registration: Pick<ADWRegistrationFile, 'contentHash' | 'documentType' | 'version' | 'created'>,
  privateKey: `0x${string}`,
): Promise<Trust> {
  const { createWalletClient, http } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { base } = await import('viem/chains');

  const account = privateKeyToAccount(privateKey);

  const message = {
    contentHash: registration.contentHash,
    documentType: registration.documentType,
    version: registration.version,
    timestamp: registration.created,
  };

  const client = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  const signature = await client.signTypedData({
    account,
    domain: ADW_EIP712_DOMAIN,
    types: ADW_EIP712_TYPES,
    primaryType: 'ADWDocument',
    message,
  });

  const creatorProof: CreatorProof = {
    type: 'EIP-712',
    signer: account.address,
    signature,
    message,
  };

  return {
    creatorProof,
    level: 1,
  };
}
