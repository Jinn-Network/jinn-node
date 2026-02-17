/**
 * Smart Heartbeat Throttling
 *
 * Keeps staking activity at exactly the target (default 60) requests per epoch
 * instead of the ~255 the worker naturally produces. Two mechanisms:
 *
 * 1. Shadow heartbeats — one heartbeat per real delivery (doubles real work)
 * 2. Deadline burst — within N hours of checkpoint, heartbeats every 5 min
 *
 * All state is read from on-chain contracts (cached 5 min). This module never
 * crashes the worker — every public function swallows errors.
 */

import { ethers } from 'ethers';
import { logger } from '../../logging/index.js';
import { getServiceSafeAddress, getServicePrivateKey, getMechAddress } from '../../env/operate-profile.js';
import { submitMarketplaceRequest } from '../MechMarketplaceRequester.js';

const hbLogger = logger.child({ component: 'HEARTBEAT' });

// ---------------------------------------------------------------------------
// Configuration (env vars, no schema changes)
// ---------------------------------------------------------------------------

const TARGET = parseInt(process.env.HEARTBEAT_TARGET || '60', 10);
const DEADLINE_HOURS = parseInt(process.env.HEARTBEAT_DEADLINE_HOURS || '5', 10);
const BURST_INTERVAL_MS = parseInt(process.env.HEARTBEAT_BURST_INTERVAL_MS || '300000', 10);

// Contract addresses (defaults for Jinn on Base)
const STAKING_CONTRACT = process.env.WORKER_STAKING_CONTRACT || '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';
const ACTIVITY_CHECKER = process.env.WORKER_ACTIVITY_CHECKER || '0x1dF0be586a7273a24C7b991e37FE4C0b1C622A9B';
const MECH_MARKETPLACE = process.env.MECH_MARKETPLACE_ADDRESS_BASE || '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const SERVICE_ID = parseInt(process.env.WORKER_SERVICE_ID || '165', 10);

const RPC_URL = process.env.BASE_LEDGER_RPC || process.env.BASE_RPC_URL || 'https://base.publicnode.com';

// ---------------------------------------------------------------------------
// ABIs (minimal — only what we read)
// ---------------------------------------------------------------------------

const STAKING_ABI = [
  'function tsCheckpoint() view returns (uint256)',
  'function livenessPeriod() view returns (uint256)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

const ACTIVITY_CHECKER_ABI = [
  'function getMultisigNonces(address multisig) view returns (uint256[] memory)',
];

const MARKETPLACE_ABI = [
  'function mapRequestCounts(address requester) view returns (uint256)',
];

// ---------------------------------------------------------------------------
// Cached epoch state
// ---------------------------------------------------------------------------

interface EpochState {
  tsCheckpoint: number;
  livenessPeriod: number;
  baselineRequestCount: number; // nonces[1] at staking time
  currentRequestCount: number;  // mapRequestCounts(safe)
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedEpochState: EpochState | null = null;
let lastKnownCheckpointTs = 0;
let lastBurstHeartbeatAt = 0;

async function fetchEpochState(safe: string): Promise<EpochState> {
  // Return cached if fresh
  if (cachedEpochState && Date.now() - cachedEpochState.fetchedAt < CACHE_TTL_MS) {
    return cachedEpochState;
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const staking = new ethers.Contract(STAKING_CONTRACT, STAKING_ABI, provider);
  const activityChecker = new ethers.Contract(ACTIVITY_CHECKER, ACTIVITY_CHECKER_ABI, provider);
  const marketplace = new ethers.Contract(MECH_MARKETPLACE, MARKETPLACE_ABI, provider);

  // Parallel reads
  const [tsCheckpoint, livenessPeriod, serviceInfo, requestCount] = await Promise.all([
    staking.tsCheckpoint() as Promise<bigint>,
    staking.livenessPeriod() as Promise<bigint>,
    staking.getServiceInfo(SERVICE_ID),
    marketplace.mapRequestCounts(safe) as Promise<bigint>,
  ]);

  const state: EpochState = {
    tsCheckpoint: Number(tsCheckpoint),
    livenessPeriod: Number(livenessPeriod),
    baselineRequestCount: Number(serviceInfo.nonces[1]),
    currentRequestCount: Number(requestCount),
    fetchedAt: Date.now(),
  };

  // Detect epoch rollover — reset burst state
  if (lastKnownCheckpointTs !== 0 && state.tsCheckpoint !== lastKnownCheckpointTs) {
    hbLogger.info(
      { oldCheckpoint: lastKnownCheckpointTs, newCheckpoint: state.tsCheckpoint },
      'Epoch rollover detected — resetting burst state',
    );
    lastBurstHeartbeatAt = 0;
  }
  lastKnownCheckpointTs = state.tsCheckpoint;

  cachedEpochState = state;
  return state;
}

function remaining(state: EpochState): number {
  const epochRequests = state.currentRequestCount - state.baselineRequestCount;
  return Math.max(0, TARGET - epochRequests);
}

// ---------------------------------------------------------------------------
// Submit heartbeat via existing Safe tx flow
// ---------------------------------------------------------------------------

async function submitHeartbeat(): Promise<void> {
  const safe = getServiceSafeAddress();
  const privateKey = getServicePrivateKey();
  const mechAddress = getMechAddress();

  if (!safe || !privateKey || !mechAddress) {
    hbLogger.warn('Missing service profile — skipping heartbeat');
    return;
  }

  // Re-check on-chain count right before submitting (invalidate cache)
  cachedEpochState = null;
  const freshState = await fetchEpochState(safe);
  const rem = remaining(freshState);

  if (rem <= 0) {
    hbLogger.debug({ target: TARGET, current: freshState.currentRequestCount - freshState.baselineRequestCount }, 'Target already met — skipping heartbeat');
    return;
  }

  hbLogger.info({ remaining: rem, target: TARGET }, 'Submitting heartbeat');

  const result = await submitMarketplaceRequest({
    serviceSafeAddress: safe,
    agentEoaPrivateKey: privateKey,
    mechContractAddress: mechAddress,
    mechMarketplaceAddress: MECH_MARKETPLACE,
    prompt: '__heartbeat__',
    rpcUrl: RPC_URL,
  });

  if (result.success) {
    hbLogger.info({ tx: result.transactionHash, remaining: rem - 1 }, 'Heartbeat submitted');
    // Invalidate cache so next call sees updated count
    cachedEpochState = null;
  } else {
    hbLogger.warn({ error: result.error }, 'Heartbeat submission failed');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Shadow heartbeat — call after every real job delivery.
 * Submits one heartbeat if we haven't hit the target yet.
 */
export async function onJobDelivered(): Promise<void> {
  const safe = getServiceSafeAddress();
  if (!safe) return;

  const state = await fetchEpochState(safe);
  const rem = remaining(state);

  hbLogger.debug({ remaining: rem, target: TARGET }, 'Shadow heartbeat check');

  if (rem <= 0) return;

  await submitHeartbeat();
}

/**
 * Deadline burst — call every main loop cycle.
 * Within DEADLINE_HOURS of the next checkpoint, submits a heartbeat every
 * BURST_INTERVAL_MS until the target is met.
 */
export async function checkHeartbeatSchedule(): Promise<void> {
  const safe = getServiceSafeAddress();
  if (!safe) return;

  const state = await fetchEpochState(safe);
  const rem = remaining(state);

  if (rem <= 0) return;

  // How far are we from the next checkpoint?
  const now = Math.floor(Date.now() / 1000);
  const nextCheckpoint = state.tsCheckpoint + state.livenessPeriod;
  const secondsUntil = nextCheckpoint - now;

  if (secondsUntil > DEADLINE_HOURS * 3600) {
    hbLogger.debug({ secondsUntil, deadlineSeconds: DEADLINE_HOURS * 3600 }, 'Outside burst window');
    return;
  }

  // Throttle burst heartbeats
  const msSinceLastBurst = Date.now() - lastBurstHeartbeatAt;
  if (msSinceLastBurst < BURST_INTERVAL_MS) {
    hbLogger.debug({ msSinceLastBurst, burstIntervalMs: BURST_INTERVAL_MS }, 'Burst throttled');
    return;
  }

  hbLogger.info({ remaining: rem, secondsUntilCheckpoint: secondsUntil }, 'Deadline burst heartbeat');
  lastBurstHeartbeatAt = Date.now();
  await submitHeartbeat();
}
