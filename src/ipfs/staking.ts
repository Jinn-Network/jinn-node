/**
 * IPFS staking check — verifies whether a peer's operator address is staked.
 *
 * The ConnectionGater calls isOperatorStaked(ethAddress) where ethAddress is
 * derived from the peer's secp256k1 PeerId. This module resolves the chain:
 *   Ponder (staked service IDs) + x402-gateway (operator → serviceId mapping)
 *   → Set<string> of staked operator addresses.
 *
 * Caches the result for 5 minutes, falling back to stale cache on errors.
 */

import { graphQLRequest } from '../http/client.js';
import { workerLogger } from '../logging/index.js';
import { getPonderGraphqlUrl } from '../agent/mcp/tools/shared/env.js';
import { getOptionalWorkerStakingContract } from '../config/index.js';
import { getServicePrivateKey } from '../env/operate-profile.js';
import {
  createPrivateKeyHttpSigner,
  resolveChainId,
  signRequestWithErc8128,
} from '../http/erc8128.js';

/** Default Jinn staking contract on Base */
const DEFAULT_JINN_STAKING_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedAddresses: Set<string> | null = null;
let cachedAt = 0;

const stakedServicesQuery = `
  query GetStakedServices($stakingContract: String!) {
    stakedServices(
      where: { stakingContract: $stakingContract, isStaked: true }
      limit: 1000
    ) {
      items {
        serviceId
      }
    }
  }
`;

/**
 * Fetch staked service IDs from Ponder.
 */
async function fetchStakedServiceIds(): Promise<Set<string>> {
  const stakingContract = (getOptionalWorkerStakingContract() || DEFAULT_JINN_STAKING_CONTRACT).toLowerCase();
  const ponderUrl = getPonderGraphqlUrl();

  const data = await graphQLRequest<{
    stakedServices: { items: Array<{ serviceId: string }> };
  }>({
    url: ponderUrl,
    query: stakedServicesQuery,
    variables: { stakingContract },
    context: { operation: 'getStakedServiceIds', stakingContract },
  });

  const items = data?.stakedServices?.items || [];
  return new Set(items.map(s => String(s.serviceId)));
}

interface OperatorNetworkEntry {
  address: string;
  serviceId: number | null;
}

/**
 * Fetch operator network entries from x402-gateway.
 */
async function fetchOperatorEntries(): Promise<OperatorNetworkEntry[]> {
  const gatewayUrl = process.env.X402_GATEWAY_URL;
  if (!gatewayUrl) return [];

  const privateKey = getServicePrivateKey();
  if (!privateKey) return [];

  const signer = createPrivateKeyHttpSigner(
    privateKey as `0x${string}`,
    resolveChainId(process.env.CHAIN_ID || process.env.CHAIN_CONFIG || 'base'),
  );

  const url = `${gatewayUrl.replace(/\/$/, '')}/admin/operators/network`;
  const request = await signRequestWithErc8128({
    signer,
    input: url,
    init: {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    },
    signOptions: {
      label: 'eth',
      binding: 'request-bound',
      replay: 'non-replayable',
      ttlSeconds: 60,
    },
  });

  const response = await fetch(request);
  if (!response.ok) {
    workerLogger.warn({ status: response.status }, 'Failed to fetch operator network from gateway');
    return [];
  }

  const body = await response.json() as { operators: OperatorNetworkEntry[] };
  return body.operators || [];
}

/**
 * Refresh the cached set of staked operator addresses.
 */
async function refreshStakedOperators(): Promise<Set<string>> {
  const [stakedIds, operators] = await Promise.all([
    fetchStakedServiceIds(),
    fetchOperatorEntries(),
  ]);

  const staked = new Set<string>();
  for (const op of operators) {
    if (op.serviceId != null && stakedIds.has(String(op.serviceId))) {
      staked.add(op.address.toLowerCase());
    }
  }

  workerLogger.info(
    { stakedOperators: staked.size, totalOperators: operators.length, stakedServices: stakedIds.size },
    'Refreshed IPFS staking gater cache',
  );

  cachedAddresses = staked;
  cachedAt = Date.now();
  return staked;
}

/**
 * Check whether an operator address is staked for IPFS ConnectionGater use.
 * Cached for 5 minutes, falls back to stale cache on errors.
 */
export async function isOperatorStaked(ethAddress: string): Promise<boolean> {
  // Return from cache if fresh
  if (cachedAddresses && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedAddresses.has(ethAddress.toLowerCase());
  }

  try {
    const staked = await refreshStakedOperators();
    return staked.has(ethAddress.toLowerCase());
  } catch (err: any) {
    workerLogger.warn(
      { error: err?.message || String(err) },
      'Failed to refresh IPFS staking cache',
    );

    // Fall back to stale cache
    if (cachedAddresses) {
      return cachedAddresses.has(ethAddress.toLowerCase());
    }

    // No cache at all — admit the peer (fail open on first startup)
    return true;
  }
}

/** Clear the cache (for testing). */
export function clearStakingCache(): void {
  cachedAddresses = null;
  cachedAt = 0;
}
