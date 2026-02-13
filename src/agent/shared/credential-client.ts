/**
 * Credential Client
 *
 * Agent-side client for the Credential Bridge. Delegates all signing to
 * the signing proxy running in the worker process.
 *
 * Environment variables:
 * - CREDENTIAL_BRIDGE_URL: URL of the x402-gateway (e.g., https://gateway.example.com)
 * - JINN_SIGNING_PROXY_URL: Signing proxy base URL
 * - JINN_SIGNING_PROXY_SECRET: Signing proxy bearer token
 */

import { proxySignTypedData, proxyGetAddress, createProxyHttpSigner } from './signing-proxy-client.js';
import { resolveChainId, signRequestWithErc8128, type Erc8128Signer } from '../../http/erc8128.js';

interface CredentialResponse {
  access_token: string;
  expires_in: number;
  provider: string;
}

interface CredentialError {
  error: string;
  code: string;
}

interface BridgeCredentialRequest {
  requestId?: string;
}

// In-memory cache: provider → { token, expiresAt }
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

// USDC contract addresses (6 decimals) — must match x402-verify.ts
const USDC_ADDRESSES: Record<string, string> = {
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

let bridgeSignerPromise: Promise<Erc8128Signer> | null = null;

async function getBridgeSigner(): Promise<Erc8128Signer> {
  if (!bridgeSignerPromise) {
    const chainId = resolveChainId(process.env.CHAIN_ID || process.env.CHAIN_CONFIG || 'base');
    bridgeSignerPromise = createProxyHttpSigner(chainId);
  }
  return bridgeSignerPromise;
}

async function signedBridgePost(
  url: string,
  body: BridgeCredentialRequest,
  headers: Record<string, string> = {},
): Promise<Response> {
  const signer = await getBridgeSigner();
  // Deterministic idempotency key from provider + requestId
  const provider = url.split('/credentials/').pop() || 'unknown';
  const idempotencyKey = `cred:${provider}:${body.requestId || 'no-request'}`;

  const request = await signRequestWithErc8128({
    signer,
    input: url,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    signOptions: {
      label: 'eth',
      binding: 'request-bound',
      replay: 'non-replayable',
      ttlSeconds: 60,
    },
  });
  return fetch(request);
}

/**
 * Build an x402 payment header by signing a USDC transferWithAuthorization
 * via the signing proxy (EIP-712 typed data).
 */
async function createPaymentHeader(opts: {
  amount: string;
  payTo: string;
  network: string;
}): Promise<string> {
  const usdcAddress = USDC_ADDRESSES[opts.network] || USDC_ADDRESSES['base'];
  const nonce = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const validBefore = String(Math.floor(Date.now() / 1000) + 3600);
  const from = await proxyGetAddress();

  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: opts.network === 'base-sepolia' ? 84532 : 8453,
    verifyingContract: usdcAddress,
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const message = {
    from,
    to: opts.payTo,
    value: opts.amount,
    validAfter: '0',
    validBefore,
    nonce,
  };

  const { signature } = await proxySignTypedData({
    domain,
    types,
    primaryType: 'TransferWithAuthorization',
    message,
  });

  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: opts.network,
    payload: {
      signature,
      authorization: {
        from,
        to: opts.payTo,
        value: opts.amount,
        validAfter: '0',
        validBefore,
        nonce,
      },
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Get a fresh OAuth access token for a provider via the Credential Bridge.
 *
 * Caches tokens in memory with a 5-minute safety buffer before expiry.
 * Handles x402 payment if the provider requires it.
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

  // Include requestId for job-bound credentials when available
  const requestId = process.env.JINN_REQUEST_ID || process.env.JINN_JOB_ID;
  const body: BridgeCredentialRequest = requestId ? { requestId } : {};

  const credentialUrl = `${bridgeUrl.replace(/\/$/, '')}/credentials/${provider}`;
  let response = await signedBridgePost(credentialUrl, body);

  // Handle x402 payment required
  if (response.status === 402) {
    const errorData = await response.json().catch(() => ({})) as Record<string, string>;
    const amount = errorData.error?.match(/(\d+)/)?.[1];
    const network = process.env.X402_NETWORK || 'base';
    const payTo = process.env.GATEWAY_PAYMENT_ADDRESS;

    if (amount && payTo) {
      const paymentHeader = await createPaymentHeader({ amount, payTo, network });
      response = await signedBridgePost(credentialUrl, body, {
        'X-Payment': paymentHeader,
      });
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error', code: 'UNKNOWN' })) as CredentialError;
    throw new Error(`Credential bridge error (${response.status}): ${error.error} [${error.code}]`);
  }

  const data = await response.json() as CredentialResponse;

  // Cache the token (evict oldest if at capacity)
  if (tokenCache.size >= 100) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey !== undefined) tokenCache.delete(oldestKey);
  }
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
