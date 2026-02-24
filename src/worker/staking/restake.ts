/**
 * Auto-Restake — Detect and restake evicted services via middleware
 *
 * Routes through OlasOperateWrapper → middleware daemon → Python Safe tx builder.
 * This is the same battle-tested path Pearl uses for staking operations.
 *
 * Used by:
 * - Worker startup (auto-restake evicted services)
 * - CLI script (`yarn wallet:restake`)
 */

import { ethers } from 'ethers';
import { workerLogger } from '../../logging/index.js';
import { OlasOperateWrapper } from '../OlasOperateWrapper.js';

const log = workerLogger.child({ component: 'AUTO-RESTAKE' });

const STAKING_ABI = [
  'function getStakingState(uint256 serviceId) view returns (uint8)',
  'function getServiceInfo(uint256 serviceId) view returns (address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 minStakingDuration)',
  'function minStakingDuration() view returns (uint256)',
  'function availableRewards() view returns (uint256)',
  'function maxNumServices() view returns (uint256)',
  'function getServiceIds() view returns (uint256[])',
];

export const STAKING_STATE_NAMES: Record<number, string> = {
  0: 'UNSTAKED',
  1: 'STAKED',
  2: 'EVICTED',
};

export interface RestakeResult {
  serviceId: number;
  configId: string;
  previousState: number;
  finalState: number;
  success: boolean;
  reason: string;
  /** Unix timestamp (seconds) when cooldown expires — set when blocked by min staking duration */
  unstakeAvailableAt?: number;
}

export interface CheckAndRestakeOptions {
  rpcUrl: string;
  operatePassword: string;
  /** Restake only this service config ID (default: all evicted) */
  serviceFilter?: string;
  /** Preview without executing */
  dryRun?: boolean;
}

/**
 * Query on-chain staking state for a service.
 */
export async function getServiceStakingInfo(
  provider: ethers.JsonRpcProvider,
  serviceId: number,
  stakingContractAddress: string,
): Promise<{ state: number; canUnstake: boolean; unstakeAvailableAt: number | null }> {
  const staking = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);

  let state: number;
  try {
    state = Number(await staking.getStakingState(serviceId));
  } catch {
    return { state: 0, canUnstake: false, unstakeAvailableAt: null };
  }

  if (state === 0) {
    return { state: 0, canUnstake: false, unstakeAvailableAt: null };
  }

  try {
    const info = await staking.getServiceInfo(serviceId);
    const tsStart = Number(info.tsStart);
    const minDuration = Number(info.minStakingDuration || await staking.minStakingDuration());
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - tsStart;
    const canUnstake = elapsed >= minDuration;
    const unstakeAvailableAt = canUnstake ? null : (tsStart + minDuration);
    return { state, canUnstake, unstakeAvailableAt };
  } catch {
    return { state, canUnstake: true, unstakeAvailableAt: null };
  }
}

/**
 * Check staking slot availability.
 */
export async function getStakingSlots(
  provider: ethers.JsonRpcProvider,
  stakingContractAddress: string,
): Promise<{ available: boolean; used: number; max: number }> {
  const staking = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);
  try {
    const maxServices = Number(await staking.maxNumServices());
    const serviceIds: bigint[] = await staking.getServiceIds();
    const used = serviceIds.length;
    return { available: used < maxServices, used, max: maxServices };
  } catch {
    return { available: true, used: 0, max: 0 };
  }
}

/**
 * Check if rewards are available in the staking contract.
 */
export async function getRewardsAvailable(
  provider: ethers.JsonRpcProvider,
  stakingContractAddress: string,
): Promise<boolean> {
  const staking = new ethers.Contract(stakingContractAddress, STAKING_ABI, provider);
  try {
    const rewards = await staking.availableRewards();
    return rewards > 0n;
  } catch {
    return true;
  }
}

// Default Jinn staking contract on Base
const DEFAULT_STAKING_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';

/**
 * Check all services for eviction and restake any that are evicted.
 *
 * Returns results for every service that needed restaking (evicted or unstaked with staking configured).
 * Services already staked are silently skipped.
 */
export async function checkAndRestakeServices(options: CheckAndRestakeOptions): Promise<RestakeResult[]> {
  const { rpcUrl, operatePassword, serviceFilter, dryRun } = options;
  const results: RestakeResult[] = [];

  const wrapper = await OlasOperateWrapper.create({ rpcUrl });
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    await wrapper.startServer();
    await wrapper.login(operatePassword);

    // List all services from middleware
    const servicesResult = await wrapper.getServices();
    if (!servicesResult.success || !servicesResult.services?.length) {
      log.warn({ error: servicesResult.error }, 'Failed to get services from middleware');
      return results;
    }

    // Check staking state for each service
    for (const svc of servicesResult.services) {
      const configId = svc.service_config_id;
      const serviceId = svc.chain_configs?.base?.chain_data?.token;
      const stakingProgramId =
        svc.chain_configs?.base?.chain_data?.user_params?.staking_program_id ||
        DEFAULT_STAKING_CONTRACT;

      if (!serviceId) continue;
      if (serviceFilter && configId !== serviceFilter) continue;

      const { state, canUnstake, unstakeAvailableAt } = await getServiceStakingInfo(
        provider, serviceId, stakingProgramId,
      );

      // Skip services that are already staked
      if (state === 1) continue;

      // Only process evicted (2) or unstaked-with-staking (0 with staking configured)
      if (state !== 2 && !(state === 0 && stakingProgramId)) continue;

      // Pre-flight: cooldown check
      if (state === 2 && !canUnstake) {
        log.info({ serviceId, unstakeAvailableAt: unstakeAvailableAt ? new Date(unstakeAvailableAt * 1000).toISOString() : 'unknown' },
          'Service evicted but cooldown not elapsed');
        results.push({
          serviceId, configId, previousState: state, finalState: state,
          success: false, reason: 'cooldown not elapsed',
          unstakeAvailableAt: unstakeAvailableAt ?? undefined,
        });
        continue;
      }

      // Pre-flight: staking slots
      const slots = await getStakingSlots(provider, stakingProgramId);
      if (!slots.available) {
        log.info({ serviceId, used: slots.used, max: slots.max }, 'No staking slots available');
        results.push({
          serviceId, configId, previousState: state, finalState: state,
          success: false, reason: `no staking slots (${slots.used}/${slots.max})`,
        });
        continue;
      }

      // Pre-flight: rewards (warning only, still attempt)
      const rewardsAvailable = await getRewardsAvailable(provider, stakingProgramId);
      if (!rewardsAvailable) {
        log.warn({ serviceId }, 'No rewards available in staking contract (will still attempt restake)');
      }

      // Dry run — report but don't execute
      if (dryRun) {
        results.push({
          serviceId, configId, previousState: state, finalState: state,
          success: false, reason: 'dry run',
        });
        continue;
      }

      // Execute restake via middleware
      log.info({ serviceId, configId, stakingState: STAKING_STATE_NAMES[state] }, 'Restaking service via middleware');

      try {
        const result = await wrapper.startService(configId);
        if (!result.success) {
          log.debug({ serviceId, error: result.error }, 'Middleware returned error (may be expected — local deploy fails for Railway workers)');
        }
      } catch (err: any) {
        log.debug({ serviceId, error: err.message }, 'Middleware call threw (checking on-chain state)');
      }

      // Verify on-chain state regardless of middleware response
      const { state: finalState } = await getServiceStakingInfo(provider, serviceId, stakingProgramId);
      const success = finalState === 1;

      log.info({ serviceId, previousState: STAKING_STATE_NAMES[state], finalState: STAKING_STATE_NAMES[finalState] ?? finalState, success },
        success ? 'Service restaked successfully' : 'Service restake may have failed');

      results.push({
        serviceId, configId, previousState: state, finalState,
        success, reason: success ? 'restaked' : `final state: ${STAKING_STATE_NAMES[finalState] ?? finalState}`,
      });
    }
  } finally {
    await wrapper.stopServer();
  }

  return results;
}
