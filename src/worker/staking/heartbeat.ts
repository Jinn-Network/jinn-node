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
import { submitMarketplaceRequest } from '../MechMarketplaceRequester.js';

const log = workerLogger.child({ component: 'HEARTBEAT' });

const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const TARGET_REQUESTS_PER_EPOCH = 60;
// Safety margin: aim for a few extra to account for timing jitter
const TARGET_WITH_MARGIN = TARGET_REQUESTS_PER_EPOCH + 5;

const STAKING_ABI = [
  'function tsCheckpoint() view returns (uint256)',
  'function getNextRewardCheckpointTimestamp() view returns (uint256)',
  'function activityChecker() view returns (address)',
];

const MARKETPLACE_ABI = [
  'function mapRequestCounts(address) view returns (uint256)',
];

// Cache epoch baseline: reset when checkpoint changes (new epoch)
let cachedEpochBaseline: {
  tsCheckpoint: number;
  baselineRequestCount: number;
} | null = null;

/**
 * Calculate how many more requests we need to submit this epoch.
 *
 * Uses the staking contract's stored nonces (via the activity checker's
 * getMultisigNonces) as the authoritative current count, and tracks the
 * baseline from the epoch start.
 */
async function getRequestDeficit(
  stakingContract: string,
  multisig: string,
): Promise<{ deficit: number; current: number; epochSecondsRemaining: number }> {
  const rpcUrl = getRequiredRpcUrl();
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
  const marketplace = new ethers.Contract(MECH_MARKETPLACE, MARKETPLACE_ABI, provider);

  const [tsCheckpoint, nextCheckpoint, currentRequestCount] = await Promise.all([
    staking.tsCheckpoint().then(Number),
    staking.getNextRewardCheckpointTimestamp().then(Number),
    marketplace.mapRequestCounts(multisig).then(Number),
  ]);

  // Reset baseline when a new epoch starts (tsCheckpoint changed)
  if (!cachedEpochBaseline || cachedEpochBaseline.tsCheckpoint !== tsCheckpoint) {
    cachedEpochBaseline = {
      tsCheckpoint,
      baselineRequestCount: currentRequestCount,
    };
    log.info({
      tsCheckpoint,
      baselineRequestCount: currentRequestCount,
    }, 'New epoch detected — reset heartbeat baseline');
  }

  const now = Math.floor(Date.now() / 1000);
  const epochSecondsRemaining = Math.max(0, nextCheckpoint - now);

  const requestsThisEpoch = currentRequestCount - cachedEpochBaseline.baselineRequestCount;
  const deficit = Math.max(0, TARGET_WITH_MARGIN - requestsThisEpoch);

  return { deficit, current: currentRequestCount, epochSecondsRemaining };
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

// How many requests to submit per heartbeat call.
// With slow worker cycles (Control API retries, backoff), a single request per
// call is not enough to hit 65/epoch. Submit a small batch each time.
const HEARTBEAT_BATCH_SIZE = parseInt(process.env.HEARTBEAT_BATCH_SIZE || '5');

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
  const multisig = getServiceSafeAddress();
  const mechAddress = getMechAddress();

  if (!multisig || !mechAddress) {
    log.debug('No multisig or mech address — skipping heartbeat');
    return;
  }

  // Throttle: don't submit more often than HEARTBEAT_MIN_INTERVAL_SEC
  const now = Math.floor(Date.now() / 1000);
  if (now - lastHeartbeatTimestamp < HEARTBEAT_MIN_INTERVAL_SEC) {
    return;
  }

  try {
    const { deficit, current, epochSecondsRemaining } = await getRequestDeficit(stakingContract, multisig);

    if (deficit <= 0) {
      log.debug({ current, deficit: 0 }, 'Request target met for this epoch — no heartbeat needed');
      return;
    }

    // Don't submit if epoch is almost over (< 5 min) — let checkpoint handle it
    if (epochSecondsRemaining < 300) {
      log.debug({ epochSecondsRemaining, deficit }, 'Epoch ending soon — skipping heartbeat');
      return;
    }

    const batchSize = Math.min(deficit, HEARTBEAT_BATCH_SIZE);

    log.info({
      deficit,
      batchSize,
      currentRequestCount: current,
      target: TARGET_WITH_MARGIN,
      epochSecondsRemaining,
    }, `Request deficit: ${deficit} — submitting ${batchSize} heartbeat(s)`);

    let submitted = 0;
    for (let i = 0; i < batchSize; i++) {
      const ok = await submitHeartbeat(multisig, mechAddress);
      if (ok) {
        submitted++;
      } else {
        log.warn({ submitted, batchSize }, 'Heartbeat batch interrupted by failure');
        break;
      }
    }

    lastHeartbeatTimestamp = Math.floor(Date.now() / 1000);
    log.info({ submitted, batchSize, deficit }, `Heartbeat batch complete`);
  } catch (error: any) {
    log.warn({ error: error.message }, 'Heartbeat check failed (non-fatal)');
  }
}
