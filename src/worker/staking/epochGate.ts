/**
 * Staking Epoch Gate
 *
 * Checks whether the service has met its request target for the current
 * staking epoch. The staking contract's activity checker reads
 * mapRequestCounts(multisig) from the MechMarketplace contract to
 * determine liveness. We read the same on-chain value and compare
 * against a baseline captured at epoch start.
 *
 * When the target is met the worker should stop claiming new jobs
 * to save gas and API quota.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { getRequiredRpcUrl } from '../../agent/mcp/tools/shared/env.js';

const log = workerLogger.child({ component: 'EPOCH_GATE' });

const DEFAULT_TARGET_REQUESTS = 60;
const EPOCH_CACHE_TTL_MS = 5 * 60_000; // 5 min — checkpoint only changes daily
const REQUEST_CACHE_TTL_MS = 2 * 60_000; // 2 min — requests change frequently

const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';

const STAKING_ABI = [
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
  'function mapServiceInfo(uint256) view returns (address multisig, address owner, uint256 tsStart, uint256 reward, uint256 nonces)',
];

const MARKETPLACE_ABI = [
  'function mapRequestCounts(address) view returns (uint256)',
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

// Baseline: the mapRequestCounts value at epoch start. Reset when tsCheckpoint changes.
let cachedBaseline: { tsCheckpoint: number; baselineRequestCount: number } | null = null;

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

/**
 * Read mapRequestCounts(multisig) from the MechMarketplace contract.
 * This is the authoritative on-chain value the activity checker uses.
 * Computes epoch delta by tracking baseline at epoch start.
 */
async function getEpochRequestCount(multisig: string, tsCheckpoint: number): Promise<number> {
  if (cachedRequests && Date.now() - cachedRequests.fetchedAt < REQUEST_CACHE_TTL_MS) {
    return cachedRequests.count;
  }

  const rpcUrl = getRequiredRpcUrl();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const marketplace = new ethers.Contract(MECH_MARKETPLACE, MARKETPLACE_ABI, provider);

  const currentCount = await marketplace.mapRequestCounts(multisig).then(Number);

  // Reset baseline when a new epoch starts (tsCheckpoint changed)
  if (!cachedBaseline || cachedBaseline.tsCheckpoint !== tsCheckpoint) {
    cachedBaseline = { tsCheckpoint, baselineRequestCount: currentCount };
    log.info({
      tsCheckpoint,
      baselineRequestCount: currentCount,
    }, 'New epoch detected — reset epoch gate baseline');
  }

  const epochCount = currentCount - cachedBaseline.baselineRequestCount;
  cachedRequests = { count: epochCount, fetchedAt: Date.now() };
  return epochCount;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function checkEpochGate(
  stakingContract: string,
  multisig: string,
): Promise<EpochGateResult> {
  const target = parseInt(process.env.WORKER_STAKING_TARGET || '', 10) || DEFAULT_TARGET_REQUESTS;

  try {
    const { tsCheckpoint, nextCheckpoint } = await getEpochBounds(stakingContract);
    const requestCount = await getEpochRequestCount(multisig, tsCheckpoint);

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
