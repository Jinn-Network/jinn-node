/**
 * Staking Epoch Gate
 *
 * Checks whether the service has met its request target for the current
 * staking epoch. The staking contract's activity checker counts requests
 * (not deliveries), so we gate on request count. When the target is met
 * the worker should stop claiming new jobs to save gas and API quota.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { getRequiredRpcUrl } from '../../agent/mcp/tools/shared/env.js';
import { getPonderGraphqlUrl } from '../../config/index.js';
import { graphQLRequest } from '../../http/client.js';

const log = workerLogger.child({ component: 'EPOCH_GATE' });

const DEFAULT_TARGET_REQUESTS = 60;
const EPOCH_CACHE_TTL_MS = 5 * 60_000; // 5 min — checkpoint only changes daily
const REQUEST_CACHE_TTL_MS = 2 * 60_000; // 2 min — requests change frequently

const STAKING_ABI = [
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
];

export interface EpochGateResult {
  targetMet: boolean;
  requestCount: number;
  target: number;
  nextCheckpoint: number; // unix timestamp of epoch reset
}

// ── Caches ──────────────────────────────────────────────────────────────────

let cachedEpoch: { tsCheckpoint: number; nextCheckpoint: number; fetchedAt: number } | null = null;
let cachedRequests: { count: number; fetchedAt: number } | null = null;

async function getEpochBounds(stakingContract: string): Promise<{ tsCheckpoint: number; nextCheckpoint: number }> {
  if (cachedEpoch && Date.now() - cachedEpoch.fetchedAt < EPOCH_CACHE_TTL_MS) {
    return { tsCheckpoint: cachedEpoch.tsCheckpoint, nextCheckpoint: cachedEpoch.nextCheckpoint };
  }

  const rpcUrl = getRequiredRpcUrl();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(stakingContract, STAKING_ABI, provider);

  const [tsCheckpoint, nextCheckpoint] = await Promise.all([
    contract.tsCheckpoint().then(Number),
    contract.getNextRewardCheckpointTimestamp().then(Number),
  ]);

  cachedEpoch = { tsCheckpoint, nextCheckpoint, fetchedAt: Date.now() };
  return { tsCheckpoint, nextCheckpoint };
}

async function getRequestCount(multisig: string, sinceTimestamp: number): Promise<number> {
  if (cachedRequests && Date.now() - cachedRequests.fetchedAt < REQUEST_CACHE_TTL_MS) {
    return cachedRequests.count;
  }

  const ponderUrl = getPonderGraphqlUrl();
  const query = `
    query RequestCount($sender: String!, $since: BigInt!) {
      requests(
        where: { sender: $sender, blockTimestamp_gte: $since }
      ) {
        totalCount
      }
    }
  `;

  const data = await graphQLRequest<{ requests: { totalCount: number } }>({
    url: ponderUrl,
    query,
    variables: { sender: multisig.toLowerCase(), since: String(sinceTimestamp) },
    timeoutMs: 10_000,
  });

  const count = data.requests.totalCount;
  cachedRequests = { count, fetchedAt: Date.now() };
  return count;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function checkEpochGate(
  stakingContract: string,
  multisig: string,
): Promise<EpochGateResult> {
  const target = parseInt(process.env.WORKER_STAKING_TARGET || '', 10) || DEFAULT_TARGET_REQUESTS;

  try {
    const { tsCheckpoint, nextCheckpoint } = await getEpochBounds(stakingContract);
    const requestCount = await getRequestCount(multisig, tsCheckpoint);

    const result: EpochGateResult = {
      targetMet: requestCount >= target,
      requestCount,
      target,
      nextCheckpoint,
    };

    log.debug({
      requestCount,
      target,
      targetMet: result.targetMet,
      epochStart: new Date(tsCheckpoint * 1000).toISOString(),
      epochEnd: new Date(nextCheckpoint * 1000).toISOString(),
    }, 'Epoch gate check');

    return result;
  } catch (error: any) {
    log.warn({ error: error.message }, 'Epoch gate check failed — allowing job pickup');
    // Fail open: if we can't check, don't block work
    return { targetMet: false, requestCount: 0, target, nextCheckpoint: 0 };
  }
}
