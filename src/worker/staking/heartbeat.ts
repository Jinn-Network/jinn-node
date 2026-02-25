/**
 * Staking Heartbeat — Request Count Booster
 *
 * The WhitelistedRequesterActivityChecker counts marketplace REQUESTS
 * (mapRequestCounts) to determine liveness, but the service is a mech
 * that primarily DELIVERS rather than requests. This module submits
 * periodic lightweight marketplace requests to satisfy the staking
 * liveness requirement for the current epoch window.
 *
 * Each heartbeat request targets our own mech with a trivial payload.
 * The worker auto-delivers these immediately so the ETH round-trips
 * and both request + delivery counts increment.
 *
 * The target is computed dynamically from on-chain livenessRatio and
 * epoch timing, with an optional delay buffer for late checkpoints.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { getRequiredRpcUrl } from '../../agent/mcp/tools/shared/env.js';
import { getServicePrivateKey, getServiceSafeAddress, getMechAddress } from '../../env/operate-profile.js';
// NOTE: getServiceSafeAddress is only used for the warning log comparing worker vs staking multisig
import { submitMarketplaceRequest } from '../MechMarketplaceRequester.js';
import { computeProjectedEpochTarget, readNonNegativeIntEnv, readPositiveIntEnv } from './target.js';

const log = workerLogger.child({ component: 'HEARTBEAT' });

const DEFAULT_TARGET_REQUESTS = 61;
const DEFAULT_CHECKPOINT_DELAY_BUFFER_SEC = 0;
const DEFAULT_SAFETY_MARGIN_REQUESTS = 1;

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

// Cached staking multisig per service — resolved from on-chain getServiceInfo()
const resolvedMultisigByService = new Map<number, string>();

/**
 * Calculate how many more requests we need to submit this epoch.
 *
 * IMPORTANT: The staking multisig (from getServiceInfo on the staking contract)
 * may differ from the worker's configured Safe (JINN_SERVICE_SAFE_ADDRESS).
 * We derive the correct multisig from on-chain and use it for both querying
 * mapRequestCounts and submitting heartbeat requests.
 *
 * The baseline is the on-chain nonces[1] from getServiceInfo — the authoritative
 * request count recorded when the service was staked/checkpointed.
 */
async function getRequestDeficit(
  stakingContract: string,
  serviceId: number,
  marketplaceAddress: string,
): Promise<{ deficit: number; current: number; target: number; epochSecondsRemaining: number; multisig: string }> {
  const rpcUrl = getRequiredRpcUrl();
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
  const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider);
  const overrideTarget = readPositiveIntEnv('WORKER_STAKING_TARGET');
  const delayBufferSeconds = readPositiveIntEnv('WORKER_STAKING_CHECKPOINT_DELAY_SEC') ?? DEFAULT_CHECKPOINT_DELAY_BUFFER_SEC;
  const safetyMarginRequests = readNonNegativeIntEnv('WORKER_STAKING_SAFETY_MARGIN') ?? DEFAULT_SAFETY_MARGIN_REQUESTS;

  const [tsCheckpoint, nextCheckpoint, serviceInfo, activityCheckerAddress, livenessPeriod] = await Promise.all([
    staking.tsCheckpoint().then(Number),
    staking.getNextRewardCheckpointTimestamp().then(Number),
    staking.getServiceInfo(serviceId),
    staking.activityChecker(),
    staking.livenessPeriod().then(Number),
  ]);

  // Use the staking multisig from on-chain (may differ from worker Safe)
  const multisig: string = serviceInfo.multisig;
  const cachedMultisig = resolvedMultisigByService.get(serviceId);
  if (!cachedMultisig) {
    const workerSafe = getServiceSafeAddress();
    if (workerSafe?.toLowerCase() !== multisig.toLowerCase()) {
      log.warn({ workerSafe, stakingMultisig: multisig }, 'Worker Safe differs from staking multisig — using staking multisig for heartbeats');
    }
    resolvedMultisigByService.set(serviceId, multisig);
  }

  // Baseline from on-chain nonces[1] — authoritative epoch-start request count
  const baselineRequestCount = Number(serviceInfo.nonces[1]);
  const currentRequestCount = await marketplace.mapRequestCounts(multisig).then(Number);
  const targetData = await computeProjectedEpochTarget({
    provider,
    activityCheckerAddress,
    tsCheckpoint,
    livenessPeriod,
    delayBufferSeconds,
    overrideTarget,
    safetyMarginRequests,
  });
  const target = targetData.target || DEFAULT_TARGET_REQUESTS;

  const now = Math.floor(Date.now() / 1000);
  const epochSecondsRemaining = Math.max(0, nextCheckpoint - now);

  const requestsThisEpoch = currentRequestCount - baselineRequestCount;
  const deficit = Math.max(0, target - requestsThisEpoch);

  log.info({
    multisig,
    baseline: baselineRequestCount,
    current: currentRequestCount,
    requestsThisEpoch,
    target,
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
    deficit,
    epochSecondsRemaining,
  }, 'Epoch deficit check');

  return { deficit, current: currentRequestCount, target, epochSecondsRemaining, multisig };
}

/**
 * Submit a single heartbeat request to the marketplace.
 * Returns true if successful.
 */
async function submitHeartbeat(
  multisig: string,
  mechAddress: string,
  serviceId: number,
  marketplaceAddress: string,
): Promise<boolean> {
  const privateKey = getServicePrivateKey();
  const rpcUrl = getRequiredRpcUrl();

  if (!privateKey) {
    log.warn('No service private key — cannot submit heartbeat');
    return false;
  }

  const prompt = JSON.stringify({
    heartbeat: true,
    ts: Date.now(),
    service: serviceId,
  });

  const result = await submitMarketplaceRequest({
    serviceSafeAddress: multisig,
    agentEoaPrivateKey: privateKey,
    mechContractAddress: mechAddress,
    mechMarketplaceAddress: marketplaceAddress,
    prompt,
    rpcUrl,
    ipfsExtraAttributes: {
      heartbeat: true,
      jobName: '__heartbeat__',
    },
  });

  if (result.success) {
    log.info({ txHash: result.transactionHash, gasUsed: result.gasUsed }, 'Heartbeat request submitted');
  } else {
    log.warn({ error: result.error }, 'Heartbeat request failed');
  }

  return result.success;
}

// Minimum seconds between heartbeat submissions to avoid gas waste
const HEARTBEAT_MIN_INTERVAL_SEC = parseInt(process.env.HEARTBEAT_MIN_INTERVAL_SEC || '60');

const lastHeartbeatTimestampByService = new Map<number, number>();

/**
 * Maybe submit heartbeat requests to meet the staking liveness requirement.
 * Called periodically from the worker loop.
 *
 * Only submits if there's a deficit of requests for the current epoch.
 * Submits a batch of requests per call to compensate for slow worker cycles.
 */
export async function maybeSubmitHeartbeat(
  stakingContract: string,
  serviceId: number,
  marketplaceAddress: string,
): Promise<void> {
  log.info({ stakingContract, serviceId }, 'Heartbeat check starting');
  const mechAddress = getMechAddress();

  if (!mechAddress) {
    log.warn('No mech address — skipping heartbeat');
    return;
  }

  // Throttle: don't submit more often than HEARTBEAT_MIN_INTERVAL_SEC
  const now = Math.floor(Date.now() / 1000);
  const lastHeartbeatTimestamp = lastHeartbeatTimestampByService.get(serviceId) ?? 0;
  if (now - lastHeartbeatTimestamp < HEARTBEAT_MIN_INTERVAL_SEC) {
    log.info({ serviceId, secondsSinceLast: now - lastHeartbeatTimestamp, minInterval: HEARTBEAT_MIN_INTERVAL_SEC }, 'Heartbeat throttled');
    return;
  }

  try {
    const { deficit, current, target, epochSecondsRemaining, multisig } = await getRequestDeficit(stakingContract, serviceId, marketplaceAddress);

    if (deficit <= 0) {
      log.info({ current, target, deficit: 0 }, 'Request target met for this epoch — no heartbeat needed');
      return;
    }

    // Don't submit if epoch is almost over (< 5 min) — let checkpoint handle it
    if (epochSecondsRemaining < 300) {
      log.info({ epochSecondsRemaining, deficit }, 'Epoch ending soon — skipping heartbeat');
      return;
    }

    // Submit only 1 request per call — the worker cycles frequently enough
    // and the on-chain baseline is authoritative, preventing overshoot.
    log.info({
      deficit,
      currentRequestCount: current,
      target,
      epochSecondsRemaining,
      multisig,
    }, `Request deficit: ${deficit} — submitting 1 heartbeat`);

    await submitHeartbeat(multisig, mechAddress, serviceId, marketplaceAddress);

    lastHeartbeatTimestampByService.set(serviceId, Math.floor(Date.now() / 1000));
  } catch (error: any) {
    log.warn({ error: error.message }, 'Heartbeat check failed (non-fatal)');
  }
}
