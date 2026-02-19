/**
 * Staking-based mech filtering module
 *
 * Queries Ponder for mechs that are staked in a given OLAS staking contract.
 * This enables multi-operator workers to automatically filter requests to only
 * those mechs whose services are staked in the same staking pool.
 */

import { graphQLRequest } from '../../http/client.js';
import { workerLogger } from '../../logging/index.js';
import { getPonderGraphqlUrl } from '../../agent/mcp/tools/shared/env.js';
import { getOptionalWorkerStakingContract } from '../../config/index.js';

/** Default Jinn staking contract on Base */
const DEFAULT_JINN_STAKING_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';

// Cache configuration
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache: Map<string, { addresses: string[]; fetchedAt: number }> = new Map();

export interface StakingFilterConfig {
  stakingContract: string;
  refreshIntervalMs?: number;
}

/**
 * Query Ponder for mech addresses that belong to services staked in a given contract.
 *
 * Flow:
 * 1. Query staked_service table for services where isStaked=true and stakingContract=X
 * 2. Join with mech_service_mapping to get mech addresses for those service IDs
 *
 * @param stakingContract - The staking contract address to filter by
 * @param forceRefresh - If true, bypass cache and fetch fresh data
 * @returns Array of mech addresses (lowercase)
 */
export async function getMechAddressesForStakingContract(
  stakingContract: string,
  forceRefresh: boolean = false
): Promise<string[]> {
  const normalizedContract = stakingContract.toLowerCase();
  const cacheKey = normalizedContract;

  // Check cache unless force refresh
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    const refreshMs = parseInt(process.env.WORKER_STAKING_REFRESH_MS || '') || DEFAULT_CACHE_TTL_MS;
    if (cached && Date.now() - cached.fetchedAt < refreshMs) {
      workerLogger.debug({
        stakingContract: normalizedContract,
        cachedAddresses: cached.addresses.length,
        cacheAge: Math.round((Date.now() - cached.fetchedAt) / 1000)
      }, 'Using cached staking filter addresses');
      return cached.addresses;
    }
  }

  const ponderUrl = getPonderGraphqlUrl();

  try {
    // Query for staked services in this contract, joined with mech addresses
    // This is a two-step query since Ponder GraphQL may not support joins directly
    // Step 1: Get service IDs staked in this contract
    const stakedServicesQuery = `
      query GetStakedServices($stakingContract: String!) {
        stakedServices(
          where: { stakingContract: $stakingContract, isStaked: true }
          limit: 1000
        ) {
          items {
            serviceId
            owner
            multisig
          }
        }
      }
    `;

    const stakedServicesData = await graphQLRequest<{
      stakedServices: { items: Array<{ serviceId: string; owner: string; multisig: string }> };
    }>({
      url: ponderUrl,
      query: stakedServicesQuery,
      variables: { stakingContract: normalizedContract },
      context: { operation: 'getStakedServicesForContract', stakingContract: normalizedContract },
    });

    const stakedServices = stakedServicesData?.stakedServices?.items || [];

    if (stakedServices.length === 0) {
      workerLogger.info({
        stakingContract: normalizedContract
      }, 'No staked services found for staking contract');
      cache.set(cacheKey, { addresses: [], fetchedAt: Date.now() });
      return [];
    }

    const serviceIds = stakedServices.map(s => s.serviceId);
    workerLogger.debug({
      stakingContract: normalizedContract,
      serviceIds
    }, 'Found staked service IDs');

    // Step 2: Get mech addresses for these service IDs
    const mechMappingsQuery = `
      query GetMechsForServices($serviceIds: [BigInt!]!) {
        mechServiceMappings(
          where: { serviceId_in: $serviceIds }
          limit: 1000
        ) {
          items {
            mech
            serviceId
          }
        }
      }
    `;

    const mechMappingsData = await graphQLRequest<{
      mechServiceMappings: { items: Array<{ mech: string; serviceId: string }> };
    }>({
      url: ponderUrl,
      query: mechMappingsQuery,
      variables: { serviceIds },
      context: { operation: 'getMechsForServices', serviceCount: serviceIds.length },
    });

    const mechMappings = mechMappingsData?.mechServiceMappings?.items || [];
    const mechAddresses = mechMappings.map(m => m.mech.toLowerCase());

    // Deduplicate
    const uniqueAddresses = [...new Set(mechAddresses)];

    workerLogger.info({
      stakingContract: normalizedContract,
      stakedServiceCount: stakedServices.length,
      mechAddressCount: uniqueAddresses.length,
      mechAddresses: uniqueAddresses
    }, 'Fetched mech addresses for staking contract');

    // Cache the result
    cache.set(cacheKey, { addresses: uniqueAddresses, fetchedAt: Date.now() });

    return uniqueAddresses;
  } catch (e: any) {
    workerLogger.error({
      stakingContract: normalizedContract,
      error: e?.message || String(e)
    }, 'Failed to fetch mech addresses for staking contract');

    // On error, return cached data if available (stale is better than nothing)
    const cached = cache.get(cacheKey);
    if (cached) {
      workerLogger.warn({
        stakingContract: normalizedContract,
        usingStaleCache: true,
        cacheAge: Math.round((Date.now() - cached.fetchedAt) / 1000)
      }, 'Using stale cache due to fetch error');
      return cached.addresses;
    }

    // Graceful fallback to empty array
    return [];
  }
}

/**
 * Clear the staking filter cache.
 * Useful for testing or when staking state changes are known to have occurred.
 */
export function clearStakingFilterCache(): void {
  cache.clear();
  workerLogger.debug('Staking filter cache cleared');
}

/**
 * Get cache status for debugging
 */
export function getStakingFilterCacheStatus(): { size: number; entries: { contract: string; count: number; ageSeconds: number }[] } {
  const now = Date.now();
  const entries = Array.from(cache.entries()).map(([contract, data]) => ({
    contract,
    count: data.addresses.length,
    ageSeconds: Math.round((now - data.fetchedAt) / 1000),
  }));
  return { size: cache.size, entries };
}

/**
 * Pick a random mech address from the set staked in the configured staking contract.
 *
 * Uses WORKER_STAKING_CONTRACT env var if set, otherwise defaults to the Jinn
 * staking contract. Falls back to `fallbackMech` if the query fails or returns
 * no results.
 *
 * The underlying getMechAddressesForStakingContract() has a 5-minute TTL cache,
 * so this adds negligible overhead per dispatch.
 */
export async function getRandomStakedMech(fallbackMech: string): Promise<string> {
  const stakingContract = getOptionalWorkerStakingContract() || DEFAULT_JINN_STAKING_CONTRACT;

  try {
    const mechs = await getMechAddressesForStakingContract(stakingContract);
    if (mechs.length === 0) {
      workerLogger.debug({ fallbackMech }, 'No staked mechs found, using fallback');
      return fallbackMech;
    }
    const selected = mechs[Math.floor(Math.random() * mechs.length)];
    workerLogger.debug({ selected, pool: mechs.length }, 'Selected random staked mech');
    return selected;
  } catch (e: any) {
    workerLogger.warn({ error: e?.message, fallbackMech }, 'Failed to query staked mechs, using fallback');
    return fallbackMech;
  }
}
