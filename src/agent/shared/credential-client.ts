/**
 * Credential Client
 *
 * Agent-side client for the Credential Bridge. Signs requests with
 * the agent's private key and fetches fresh OAuth tokens from the gateway.
 *
 * Environment variables:
 * - CREDENTIAL_BRIDGE_URL: URL of the x402-gateway (e.g., https://gateway.example.com)
 * - WORKER_PRIVATE_KEY: Agent's private key (or loaded from operate profile)
 */

import { getServicePrivateKey } from '../../env/operate-profile.js';

interface CredentialResponse {
  access_token: string;
  expires_in: number;
  provider: string;
}

interface CredentialError {
  error: string;
  code: string;
}

// In-memory cache: provider → { token, expiresAt }
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Get the agent's private key from environment or operate profile.
 */
function getPrivateKey(): string {
  const envKey = process.env.WORKER_PRIVATE_KEY;
  if (envKey) return envKey;

  const profileKey = getServicePrivateKey();
  if (profileKey) return profileKey;

  throw new Error('No private key available (WORKER_PRIVATE_KEY or operate profile)');
}

/**
 * Sign a message with EIP-191 personal_sign using the agent's private key.
 * Returns the signature and derived address.
 */
async function signMessage(message: string, privateKey: string): Promise<{ signature: string; address: string }> {
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const signature = await account.signMessage({ message });
  return {
    signature,
    address: account.address.toLowerCase(),
  };
}

/**
 * Get a fresh OAuth access token for a provider via the Credential Bridge.
 *
 * Caches tokens in memory with a 5-minute safety buffer before expiry.
 */
export async function getCredential(provider: string): Promise<string> {
  // Check cache (with 5-minute buffer)
  const cached = tokenCache.get(provider);
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.token;
  }

  const bridgeUrl = process.env.CREDENTIAL_BRIDGE_URL;
  if (!bridgeUrl) {
    throw new Error('CREDENTIAL_BRIDGE_URL environment variable is required');
  }

  const privateKey = getPrivateKey();

  // Build request body
  const body = {
    timestamp: Math.floor(Date.now() / 1000),
    nonce: crypto.randomUUID(),
  };

  // Sign the request body
  const message = JSON.stringify(body);
  const { signature, address } = await signMessage(message, privateKey);

  // Call credential bridge
  const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/credentials/${provider}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Signature': signature,
      'X-Agent-Address': address,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error', code: 'UNKNOWN' })) as CredentialError;
    throw new Error(`Credential bridge error (${response.status}): ${error.error} [${error.code}]`);
  }

  const data = await response.json() as CredentialResponse;

  // Cache the token
  tokenCache.set(provider, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });

  return data.access_token;
}

/**
 * Clear cached token for a provider (useful after token rejection).
 */
export function clearCredentialCache(provider?: string): void {
  if (provider) {
    tokenCache.delete(provider);
  } else {
    tokenCache.clear();
  }
}
