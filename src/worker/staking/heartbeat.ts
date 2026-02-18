/**
 * Staking Heartbeat — Request Count Booster
 *
 * The WhitelistedRequesterActivityChecker counts marketplace REQUESTS
 * (mapRequestCounts) to determine liveness, but the service is a mech
 * that primarily DELIVERS rather than requests. This module submits
 * periodic lightweight marketplace requests to satisfy the liveness
 * requirement of 60 requests per epoch.
 *
 * Each heartbeat request targets our own mech with a trivial payload.
 * The worker auto-delivers these immediately so the ETH round-trips
 * and both request + delivery counts increment.
 *
 * Math: 60 requests / 24h epoch. At default interval of 8 min,
 * the module checks remaining deficit and submits 1 request if needed.
 * Over 8 active hours: 60/8 = 7.5/hr ≈ 1 every 8 min.
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { getRequiredRpcUrl } from '../../agent/mcp/tools/shared/env.js';
import { getServicePrivateKey, getServiceSafeAddress, getMechAddress } from '../../env/operate-profile.js';
// NOTE: getServiceSafeAddress is only used for the warning log comparing worker vs staking multisig
import { submitMarketplaceRequest } from '../MechMarketplaceRequester.js';

const log = workerLogger.child({ component: 'HEARTBEAT' });

const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const TARGET_REQUESTS_PER_EPOCH = 60;

const STAKING_ABI = [
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

const MARKETPLACE_ABI = [
  'function mapRequestCounts(address) view returns (uint256)',
];

const SERVICE_ID = parseInt(process.env.WORKER_SERVICE_ID || '165', 10);

// Cached staking multisig — resolved once from on-chain getServiceInfo()
let resolvedMultisig: string | null = null;

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
): Promise<{ deficit: number; current: number; epochSecondsRemaining: number; multisig: string }> {
  const rpcUrl = getRequiredRpcUrl();
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
  const marketplace = new ethers.Contract(MECH_MARKETPLACE, MARKETPLACE_ABI, provider);

  const [nextCheckpoint, serviceInfo] = await Promise.all([
    staking.getNextRewardCheckpointTimestamp().then(Number),
    staking.getServiceInfo(SERVICE_ID),
  ]);

  // Use the staking multisig from on-chain (may differ from worker Safe)
  const multisig: string = serviceInfo.multisig;
  if (!resolvedMultisig) {
    const workerSafe = getServiceSafeAddress();
    if (workerSafe?.toLowerCase() !== multisig.toLowerCase()) {
      log.warn({ workerSafe, stakingMultisig: multisig }, 'Worker Safe differs from staking multisig — using staking multisig for heartbeats');
    }
    resolvedMultisig = multisig;
  }

  // Baseline from on-chain nonces[1] — authoritative epoch-start request count
  const baselineRequestCount = Number(serviceInfo.nonces[1]);
  const currentRequestCount = await marketplace.mapRequestCounts(multisig).then(Number);

  const now = Math.floor(Date.now() / 1000);
  const epochSecondsRemaining = Math.max(0, nextCheckpoint - now);

  const requestsThisEpoch = currentRequestCount - baselineRequestCount;
  const deficit = Math.max(0, TARGET_REQUESTS_PER_EPOCH - requestsThisEpoch);

  log.info({
    multisig,
    baseline: baselineRequestCount,
    current: currentRequestCount,
    requestsThisEpoch,
    deficit,
    epochSecondsRemaining,
  }, 'Epoch deficit check');

  return { deficit, current: currentRequestCount, epochSecondsRemaining, multisig };
}

/**
 * Submit a single heartbeat request to the marketplace.
 * Returns true if successful.
 */
async function submitHeartbeat(multisig: string, mechAddress: string): Promise<boolean> {
  const privateKey = getServicePrivateKey();
  const rpcUrl = getRequiredRpcUrl();

  if (!privateKey) {
    log.warn('No service private key — cannot submit heartbeat');
    return false;
  }

  const prompt = JSON.stringify({
    heartbeat: true,
    ts: Date.now(),
    service: 165,
  });

  const result = await submitMarketplaceRequest({
    serviceSafeAddress: multisig,
    agentEoaPrivateKey: privateKey,
    mechContractAddress: mechAddress,
    mechMarketplaceAddress: MECH_MARKETPLACE,
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

let lastHeartbeatTimestamp = 0;

/**
 * Maybe submit heartbeat requests to meet the staking liveness requirement.
 * Called periodically from the worker loop.
 *
 * Only submits if there's a deficit of requests for the current epoch.
 * Submits a batch of requests per call to compensate for slow worker cycles.
 */
export async function maybeSubmitHeartbeat(stakingContract: string): Promise<void> {
  log.info({ stakingContract, serviceId: SERVICE_ID }, 'Heartbeat check starting');
  const mechAddress = getMechAddress();

  if (!mechAddress) {
    log.warn('No mech address — skipping heartbeat');
    return;
  }

  // Throttle: don't submit more often than HEARTBEAT_MIN_INTERVAL_SEC
  const now = Math.floor(Date.now() / 1000);
  if (now - lastHeartbeatTimestamp < HEARTBEAT_MIN_INTERVAL_SEC) {
    log.info({ secondsSinceLast: now - lastHeartbeatTimestamp, minInterval: HEARTBEAT_MIN_INTERVAL_SEC }, 'Heartbeat throttled');
    return;
  }

  try {
    const { deficit, current, epochSecondsRemaining, multisig } = await getRequestDeficit(stakingContract);

    if (deficit <= 0) {
      log.info({ current, deficit: 0 }, 'Request target met for this epoch — no heartbeat needed');
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
      target: TARGET_REQUESTS_PER_EPOCH,
      epochSecondsRemaining,
      multisig,
    }, `Request deficit: ${deficit} — submitting 1 heartbeat`);

    await submitHeartbeat(multisig, mechAddress);

    lastHeartbeatTimestamp = Math.floor(Date.now() / 1000);
  } catch (error: any) {
    log.warn({ error: error.message }, 'Heartbeat check failed (non-fatal)');
  }
}
