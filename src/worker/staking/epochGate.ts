/**
 * Staking Epoch Gate
 *
 * Checks whether the service has met its request target for the current
 * staking epoch. The staking contract's activity checker reads
 * mapRequestCounts(multisig) from the MechMarketplace contract to
 * determine liveness. We read the same on-chain value and compare
 * against nonces[1] from getServiceInfo — the authoritative epoch-start
 * baseline recorded by the staking contract at checkpoint time.
 *
 * When the target is met the worker should stop claiming new jobs
 * to save gas and API quota.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { getRequiredRpcUrl } from '../../agent/mcp/tools/shared/env.js';
import { computeProjectedEpochTarget, readNonNegativeIntEnv, readPositiveIntEnv } from './target.js';

const log = workerLogger.child({ component: 'EPOCH_GATE' });

const DEFAULT_TARGET_REQUESTS = 61;
const DEFAULT_CHECKPOINT_DELAY_BUFFER_SEC = 0;
const DEFAULT_SAFETY_MARGIN_REQUESTS = 1;
const EPOCH_CACHE_TTL_MS = 5 * 60_000; // 5 min — checkpoint only changes daily
const REQUEST_CACHE_TTL_MS = 2 * 60_000; // 2 min — requests change frequently

const STAKING_ABI = [
  'function livenessPeriod() view returns (uint256)',
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
  'function activityChecker() view returns (address)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

const MARKETPLACE_ABI = [
  'function mapRequestCounts(address) view returns (uint256)',
];

export interface EpochGateResult {
  targetMet: boolean;
  requestCount: number;
  target: number;
  nextCheckpoint: number; // unix timestamp of epoch reset
  /** The on-chain staking multisig — authoritative source */
  multisig: string;
}

// ── Caches ──────────────────────────────────────────────────────────────────

let cachedEpoch: { tsCheckpoint: number; nextCheckpoint: number; fetchedAt: number } | null = null;
let cachedGate: { result: EpochGateResult; fetchedAt: number } | null = null;

async function getEpochBounds(stakingContract: ethers.Contract): Promise<{ tsCheckpoint: number; nextCheckpoint: number }> {
  if (cachedEpoch && Date.now() - cachedEpoch.fetchedAt < EPOCH_CACHE_TTL_MS) {
    return { tsCheckpoint: cachedEpoch.tsCheckpoint, nextCheckpoint: cachedEpoch.nextCheckpoint };
  }

  const [tsCheckpoint, nextCheckpoint] = await Promise.all([
    stakingContract.tsCheckpoint().then(Number),
    stakingContract.getNextRewardCheckpointTimestamp().then(Number),
  ]);

  cachedEpoch = { tsCheckpoint, nextCheckpoint, fetchedAt: Date.now() };
  return { tsCheckpoint, nextCheckpoint };
}

/**
 * Read epoch request count using the on-chain nonces[1] from getServiceInfo
 * as the authoritative baseline. This is restart-proof — the baseline comes
 * from the staking contract, not from in-memory state.
 */
async function getEpochRequestCount(
  stakingContract: ethers.Contract,
  marketplace: ethers.Contract,
  multisig: string,
  baselineRequestCount: number,
): Promise<number> {
  const currentCount = await marketplace.mapRequestCounts(multisig).then(Number);
  return currentCount - baselineRequestCount;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function checkEpochGate(
  stakingContractAddress: string,
  serviceId: number,
  marketplaceAddress: string,
): Promise<EpochGateResult> {
  const overrideTarget = readPositiveIntEnv('WORKER_STAKING_TARGET');
  const delayBufferSeconds = readPositiveIntEnv('WORKER_STAKING_CHECKPOINT_DELAY_SEC') ?? DEFAULT_CHECKPOINT_DELAY_BUFFER_SEC;
  const safetyMarginRequests = readNonNegativeIntEnv('WORKER_STAKING_SAFETY_MARGIN') ?? DEFAULT_SAFETY_MARGIN_REQUESTS;
  const fallbackTarget = overrideTarget ?? DEFAULT_TARGET_REQUESTS;

  // Return cached result if fresh enough
  if (cachedGate && Date.now() - cachedGate.fetchedAt < REQUEST_CACHE_TTL_MS) {
    return cachedGate.result;
  }

  try {
    const rpcUrl = getRequiredRpcUrl();
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const stakingContract = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);
    const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider);

    const [{ tsCheckpoint, nextCheckpoint }, serviceInfo, activityCheckerAddress, livenessPeriod] = await Promise.all([
      getEpochBounds(stakingContract),
      stakingContract.getServiceInfo(serviceId),
      stakingContract.activityChecker(),
      stakingContract.livenessPeriod().then(Number),
    ]);

    // Use the staking contract's multisig — authoritative source
    const multisig: string = serviceInfo.multisig;
    // nonces[1] is the request count baseline recorded at epoch checkpoint
    const baselineRequestCount = Number(serviceInfo.nonces[1]);
    const requestCount = await getEpochRequestCount(stakingContract, marketplace, multisig, baselineRequestCount);
    const targetData = await computeProjectedEpochTarget({
      provider,
      activityCheckerAddress,
      tsCheckpoint,
      livenessPeriod,
      delayBufferSeconds,
      overrideTarget,
      safetyMarginRequests,
    });
    const target = targetData.target;

    const result: EpochGateResult = {
      targetMet: requestCount >= target,
      requestCount,
      target,
      nextCheckpoint,
      multisig,
    };

    log.debug({
      requestCount,
      target,
      targetMet: result.targetMet,
      baselineRequestCount,
      multisig,
      tsCheckpoint,
      nextCheckpoint,
      livenessPeriod,
      effectivePeriodSeconds: targetData.effectivePeriodSeconds,
      effectivePeriodSecondsWithoutBuffer: targetData.effectivePeriodSecondsWithoutBuffer,
      baselineTimestamp: targetData.baselineTimestamp,
      livenessRatio: targetData.livenessRatio.toString(),
      delayBufferSeconds,
      safetyMarginRequests: targetData.safetyMarginRequests,
      targetFromOverride: targetData.usedOverride,
      epochStart: new Date(tsCheckpoint * 1000).toISOString(),
      epochEnd: new Date(nextCheckpoint * 1000).toISOString(),
    }, 'Epoch gate check');

    cachedGate = { result, fetchedAt: Date.now() };
    return result;
  } catch (error: any) {
    log.warn({ error: error.message }, 'Epoch gate check failed — allowing job pickup');
    // Fail open: if we can't check, don't block work
    return { targetMet: false, requestCount: 0, target: fallbackTarget, nextCheckpoint: 0, multisig: '' };
  }
}
