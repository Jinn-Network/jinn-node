/**
 * Staking Epoch Gate
 *
 * Checks whether the service has met its delivery target for the current
 * staking epoch. When the target is met the worker should stop claiming
 * new jobs to save gas and API quota for the next epoch.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { getRequiredRpcUrl } from '../../agent/mcp/tools/shared/env.js';
import { getPonderGraphqlUrl } from '../../config/index.js';
import { graphQLRequest } from '../../http/client.js';

const log = workerLogger.child({ component: 'EPOCH_GATE' });

const DEFAULT_TARGET_DELIVERIES = 60;
const EPOCH_CACHE_TTL_MS = 5 * 60_000; // 5 min — checkpoint only changes daily
const DELIVERY_CACHE_TTL_MS = 2 * 60_000; // 2 min — deliveries change frequently

const STAKING_ABI = [
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
];

export interface EpochGateResult {
  targetMet: boolean;
  deliveryCount: number;
  target: number;
  nextCheckpoint: number; // unix timestamp of epoch reset
}

// ── Caches ──────────────────────────────────────────────────────────────────

let cachedEpoch: { tsCheckpoint: number; nextCheckpoint: number; fetchedAt: number } | null = null;
let cachedDeliveries: { count: number; fetchedAt: number } | null = null;

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

async function getDeliveryCount(multisig: string, sinceTimestamp: number): Promise<number> {
  if (cachedDeliveries && Date.now() - cachedDeliveries.fetchedAt < DELIVERY_CACHE_TTL_MS) {
    return cachedDeliveries.count;
  }

  const ponderUrl = getPonderGraphqlUrl();
  const query = `
    query DeliveryCount($multisig: String!, $since: BigInt!) {
      deliverys(
        where: { mechServiceMultisig: $multisig, blockTimestamp_gte: $since }
      ) {
        totalCount
      }
    }
  `;

  const data = await graphQLRequest<{ deliverys: { totalCount: number } }>({
    url: ponderUrl,
    query,
    variables: { multisig: multisig.toLowerCase(), since: String(sinceTimestamp) },
    timeoutMs: 10_000,
  });

  const count = data.deliverys.totalCount;
  cachedDeliveries = { count, fetchedAt: Date.now() };
  return count;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function checkEpochGate(
  stakingContract: string,
  multisig: string,
): Promise<EpochGateResult> {
  const target = parseInt(process.env.WORKER_STAKING_TARGET || '', 10) || DEFAULT_TARGET_DELIVERIES;

  try {
    const { tsCheckpoint, nextCheckpoint } = await getEpochBounds(stakingContract);
    const deliveryCount = await getDeliveryCount(multisig, tsCheckpoint);

    const result: EpochGateResult = {
      targetMet: deliveryCount >= target,
      deliveryCount,
      target,
      nextCheckpoint,
    };

    log.debug({
      deliveryCount,
      target,
      targetMet: result.targetMet,
      epochStart: new Date(tsCheckpoint * 1000).toISOString(),
      epochEnd: new Date(nextCheckpoint * 1000).toISOString(),
    }, 'Epoch gate check');

    return result;
  } catch (error: any) {
    log.warn({ error: error.message }, 'Epoch gate check failed — allowing job pickup');
    // Fail open: if we can't check, don't block work
    return { targetMet: false, deliveryCount: 0, target, nextCheckpoint: 0 };
  }
}
