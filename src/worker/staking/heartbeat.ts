/**
 * Staking Heartbeat — Activity Count Booster (v1 only)
 *
 * For services staked in v1 (WhitelistedRequesterActivityChecker), the activity
 * checker counts marketplace REQUESTS (mapRequestCounts). Since the service is
 * a mech that primarily DELIVERS rather than requests, this module submits
 * periodic lightweight marketplace requests to satisfy the staking liveness
 * requirement for the current epoch window.
 *
 * For services staked in v2 (DeliveryActivityChecker), deliveries happen
 * naturally through normal worker operation, so heartbeat is skipped.
 *
 * Detection: we compare activityChecker.getMultisigNonces(multisig)[1] against
 * marketplace.mapRequestCounts(multisig). If they match, the checker is
 * request-based (v1) and heartbeat is needed. If they differ, the checker
 * uses a different metric (e.g. deliveries) and heartbeat is skipped.
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

const DEFAULT_TARGET_ACTIVITIES = 61;
const DEFAULT_CHECKPOINT_DELAY_BUFFER_SEC = 0;
const DEFAULT_SAFETY_MARGIN_ACTIVITIES = 1;

const STAKING_ABI = [
  'function livenessPeriod() view returns (uint256)',
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
  'function activityChecker() view returns (address)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

const ACTIVITY_CHECKER_ABI = [
  'function livenessRatio() view returns (uint256)',
  'function getMultisigNonces(address multisig) view returns (uint256[] memory)',
];

const MARKETPLACE_ABI = [
  'function mapRequestCounts(address) view returns (uint256)',
];

// ── Checker type detection ──────────────────────────────────────────────────

/**
 * Cache of checker type per staking contract (immutable — the activity checker
 * doesn't change for a given staking contract).
 * true = request-based (v1, heartbeat needed)
 * false = delivery-based or other (v2, heartbeat skipped)
 */
const checkerIsRequestBased = new Map<string, boolean>();

/**
 * Detect whether the activity checker counts marketplace requests.
 * Compares activityChecker.getMultisigNonces(multisig)[1] against
 * marketplace.mapRequestCounts(multisig).
 */
async function detectRequestBasedChecker(
  stakingContractAddress: string,
  marketplaceAddress: string,
  provider: ethers.JsonRpcProvider,
  multisig: string,
): Promise<boolean> {
  const cacheKey = stakingContractAddress.toLowerCase();
  const cached = checkerIsRequestBased.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const staking = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);
    const activityCheckerAddress = await staking.activityChecker();
    const activityChecker = new ethers.Contract(activityCheckerAddress, ACTIVITY_CHECKER_ABI, provider);
    const marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, provider);

    const [checkerNonces, requestCount] = await Promise.all([
      activityChecker.getMultisigNonces(multisig),
      marketplace.mapRequestCounts(multisig),
    ]);

    const checkerActivityCount = BigInt(checkerNonces[1]);
    const marketplaceRequestCount = BigInt(requestCount);
    const isRequestBased = checkerActivityCount === marketplaceRequestCount;

    checkerIsRequestBased.set(cacheKey, isRequestBased);
    log.info({
      stakingContract: stakingContractAddress,
      activityChecker: activityCheckerAddress,
      checkerNonces1: checkerActivityCount.toString(),
      mapRequestCounts: marketplaceRequestCount.toString(),
      isRequestBased,
    }, isRequestBased
      ? 'Activity checker is request-based (v1) — heartbeat enabled'
      : 'Activity checker is delivery-based (v2) — heartbeat disabled');

    return isRequestBased;
  } catch (error: any) {
    log.warn({ error: error.message }, 'Failed to detect checker type — assuming request-based for safety');
    return true; // Fail safe: assume heartbeat is needed
  }
}

// Cached staking multisig per service — resolved from on-chain getServiceInfo()
const resolvedMultisigByService = new Map<number, string>();

/**
 * Calculate how many more activities we need this epoch.
 *
 * Uses activityChecker.getMultisigNonces() for the current count and
 * nonces[1] from getServiceInfo for the baseline — both come from the
 * same activity checker, so the subtraction is always consistent.
 */
async function getActivityDeficit(
  stakingContract: string,
  serviceId: number,
  marketplaceAddress: string,
): Promise<{ deficit: number; current: number; target: number; epochSecondsRemaining: number; multisig: string }> {
  const rpcUrl = getRequiredRpcUrl();
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
  const overrideTarget = readPositiveIntEnv('WORKER_STAKING_TARGET');
  const delayBufferSeconds = readPositiveIntEnv('WORKER_STAKING_CHECKPOINT_DELAY_SEC') ?? DEFAULT_CHECKPOINT_DELAY_BUFFER_SEC;
  const safetyMarginActivities = readNonNegativeIntEnv('WORKER_STAKING_SAFETY_MARGIN') ?? DEFAULT_SAFETY_MARGIN_ACTIVITIES;

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

  // Read current activity count from the activity checker (v1/v2 agnostic)
  const activityChecker = new ethers.Contract(activityCheckerAddress, ACTIVITY_CHECKER_ABI, provider);
  const currentNonces = await activityChecker.getMultisigNonces(multisig);

  // Baseline from on-chain nonces[1] — authoritative epoch-start activity count
  const baselineActivityCount = Number(serviceInfo.nonces[1]);
  const currentActivityCount = Number(currentNonces[1]);
  const targetData = await computeProjectedEpochTarget({
    provider,
    activityCheckerAddress,
    tsCheckpoint,
    livenessPeriod,
    delayBufferSeconds,
    overrideTarget,
    safetyMarginActivities,
  });
  const target = targetData.target || DEFAULT_TARGET_ACTIVITIES;

  const now = Math.floor(Date.now() / 1000);
  const epochSecondsRemaining = Math.max(0, nextCheckpoint - now);

  const activitiesThisEpoch = currentActivityCount - baselineActivityCount;
  const deficit = Math.max(0, target - activitiesThisEpoch);

  log.info({
    multisig,
    baseline: baselineActivityCount,
    current: currentActivityCount,
    activitiesThisEpoch,
    target,
    tsCheckpoint,
    nextCheckpoint,
    livenessPeriod,
    effectivePeriodSeconds: targetData.effectivePeriodSeconds,
    effectivePeriodSecondsWithoutBuffer: targetData.effectivePeriodSecondsWithoutBuffer,
    baselineTimestamp: targetData.baselineTimestamp,
    livenessRatio: targetData.livenessRatio.toString(),
    delayBufferSeconds,
    safetyMarginActivities: targetData.safetyMarginActivities,
    targetFromOverride: targetData.usedOverride,
    deficit,
    epochSecondsRemaining,
  }, 'Epoch deficit check');

  return { deficit, current: currentActivityCount, target, epochSecondsRemaining, multisig };
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
 * Only submits if:
 * 1. The activity checker is request-based (v1) — delivery-based checkers (v2)
 *    don't benefit from heartbeat requests.
 * 2. There's a deficit of activities for the current epoch.
 *
 * Submits one request per call to compensate for slow worker cycles.
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

  // Detect checker type — skip heartbeat for delivery-based (v2) checkers
  const rpcUrl = getRequiredRpcUrl();
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // We need a multisig for detection. Resolve from staking contract if not cached.
  let multisig = resolvedMultisigByService.get(serviceId);
  if (!multisig) {
    const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
    const serviceInfo = await staking.getServiceInfo(serviceId);
    multisig = serviceInfo.multisig;
    resolvedMultisigByService.set(serviceId, multisig);
  }

  const isRequestBased = await detectRequestBasedChecker(stakingContract, marketplaceAddress, provider, multisig);
  if (!isRequestBased) {
    log.debug({ stakingContract, serviceId }, 'Delivery-based checker (v2) — skipping heartbeat');
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
    const { deficit, current, target, epochSecondsRemaining, multisig: resolvedMultisig } = await getActivityDeficit(stakingContract, serviceId, marketplaceAddress);

    if (deficit <= 0) {
      log.info({ current, target, deficit: 0 }, 'Activity target met for this epoch — no heartbeat needed');
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
      currentActivityCount: current,
      target,
      epochSecondsRemaining,
      multisig: resolvedMultisig,
    }, `Activity deficit: ${deficit} — submitting 1 heartbeat`);

    await submitHeartbeat(resolvedMultisig, mechAddress, serviceId, marketplaceAddress);

    lastHeartbeatTimestampByService.set(serviceId, Math.floor(Date.now() / 1000));
  } catch (error: any) {
    log.warn({ error: error.message }, 'Heartbeat check failed (non-fatal)');
  }
}
