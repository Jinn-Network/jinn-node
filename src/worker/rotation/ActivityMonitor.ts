/**
 * Activity Monitor — On-chain activity eligibility checker for multi-service rotation
 *
 * Periodically queries staking contracts and activity checkers to determine
 * which services have met their activity requirements for the current epoch.
 *
 * The eligibility formula (confirmed in Pearl olas-operate-app):
 *   effectivePeriod = max(livenessPeriod, now - tsCheckpoint)
 *   requiredRequests = ceil(effectivePeriod * livenessRatio / 1e18) + SAFETY_MARGIN
 *   eligibleRequests = currentRequestCount - baselineAtCheckpoint
 *   isEligibleForRewards = eligibleRequests >= requiredRequests
 *
 * Data sources (all gas-free view calls):
 *   StakingContract.livenessPeriod()           — epoch length (immutable per contract)
 *   StakingContract.tsCheckpoint()             — last checkpoint time (changes once/epoch)
 *   StakingContract.getServiceInfo(serviceId)  — baseline nonces at checkpoint
 *   StakingContract.activityChecker()          — activity checker address (immutable)
 *   ActivityChecker.livenessRatio()            — required rate in 1e18 (immutable)
 *   ActivityChecker.getMultisigNonces(multisig) — current [safeNonce, requestCount]
 */

import { ethers } from 'ethers';
import { logger } from '../../logging/index.js';

const rotationLogger = logger.child({ component: 'ACTIVITY-MONITOR' });

const SAFETY_MARGIN = 1;

// ABIs (from scripts/migrate-staking-contract.ts and scripts/archive/query-service-165-activity-requirements.ts)
const STAKING_ABI = [
  'function livenessPeriod() view returns (uint256)',
  'function tsCheckpoint() view returns (uint256)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
  'function activityChecker() view returns (address)',
  'function rewardsPerSecond() view returns (uint256)',
  'function getServiceIds() view returns (uint256[])',
];

const ACTIVITY_CHECKER_ABI = [
  'function livenessRatio() view returns (uint256)',
  'function getMultisigNonces(address multisig) view returns (uint256[] memory)',
];

export interface ServiceActivityStatus {
  serviceConfigId: string;
  serviceId: number;
  multisig: string;
  stakingContract: string;

  // On-chain data
  livenessPeriod: number;
  tsCheckpoint: number;
  livenessRatio: bigint;
  currentRequestCount: bigint;
  baselineRequestCount: bigint;

  // Computed
  requiredRequests: number;
  eligibleRequests: number;
  isEligibleForRewards: boolean;
  requestsNeeded: number;

  // Meta
  fetchedAt: number;
  error?: string;
}

export interface ServiceCheckInput {
  serviceConfigId: string;
  serviceId: number;
  multisig: string;
  stakingContract: string;
}

// Contract-level cache (immutable data cached permanently)
interface ContractLevelCache {
  livenessPeriod: number;
  livenessRatio: bigint;
  activityCheckerAddress: string;
  rewardsPerSecond: bigint;
}

// Checkpoint-level cache (changes once per epoch)
interface CheckpointCache {
  tsCheckpoint: number;
  fetchedAt: number;
}

export class ActivityMonitor {
  private provider: ethers.JsonRpcProvider;
  private cacheTtlMs: number;

  // Permanent cache for immutable contract data (keyed by staking contract address)
  private contractCache = new Map<string, ContractLevelCache>();

  // TTL cache for checkpoint data (keyed by staking contract address)
  private checkpointCache = new Map<string, CheckpointCache>();

  constructor(rpcUrl: string, cacheTtlMs: number = 60_000) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Get contract-level data (immutable, cached permanently)
   */
  private async getContractData(stakingContract: string): Promise<ContractLevelCache> {
    const key = stakingContract.toLowerCase();
    const cached = this.contractCache.get(key);
    if (cached) return cached;

    const contract = new ethers.Contract(stakingContract, STAKING_ABI, this.provider);

    const [livenessPeriod, activityCheckerAddress, rewardsPerSecond] = await Promise.all([
      contract.livenessPeriod(),
      contract.activityChecker(),
      contract.rewardsPerSecond(),
    ]);

    const activityChecker = new ethers.Contract(activityCheckerAddress, ACTIVITY_CHECKER_ABI, this.provider);
    const livenessRatio = await activityChecker.livenessRatio();

    const data: ContractLevelCache = {
      livenessPeriod: Number(livenessPeriod),
      livenessRatio: BigInt(livenessRatio),
      activityCheckerAddress,
      rewardsPerSecond: BigInt(rewardsPerSecond),
    };

    this.contractCache.set(key, data);

    rotationLogger.info({
      stakingContract: key,
      livenessPeriod: data.livenessPeriod,
      livenessRatio: data.livenessRatio.toString(),
      activityChecker: activityCheckerAddress,
    }, 'Cached contract-level data');

    return data;
  }

  /**
   * Get checkpoint timestamp (cached with TTL, changes once per epoch)
   */
  private async getCheckpointTs(stakingContract: string): Promise<number> {
    const key = stakingContract.toLowerCase();
    const cached = this.checkpointCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.tsCheckpoint;
    }

    const contract = new ethers.Contract(stakingContract, STAKING_ABI, this.provider);
    const tsCheckpoint = Number(await contract.tsCheckpoint());

    this.checkpointCache.set(key, { tsCheckpoint, fetchedAt: Date.now() });
    return tsCheckpoint;
  }

  /**
   * Check activity status for a single service
   */
  async checkService(input: ServiceCheckInput): Promise<ServiceActivityStatus> {
    const { serviceConfigId, serviceId, multisig, stakingContract } = input;
    const now = Math.floor(Date.now() / 1000);

    try {
      // Get contract-level data (cached permanently)
      const contractData = await this.getContractData(stakingContract);

      // Get checkpoint timestamp (cached with TTL)
      const tsCheckpoint = await this.getCheckpointTs(stakingContract);

      // Get per-service data (always fresh)
      const stakingContractInstance = new ethers.Contract(stakingContract, STAKING_ABI, this.provider);
      const activityChecker = new ethers.Contract(
        contractData.activityCheckerAddress, ACTIVITY_CHECKER_ABI, this.provider
      );

      const [serviceInfo, currentNonces] = await Promise.all([
        stakingContractInstance.getServiceInfo(serviceId),
        activityChecker.getMultisigNonces(multisig),
      ]);

      // serviceInfo.nonces[1] = mech request count at last checkpoint
      const baselineRequestCount = BigInt(serviceInfo.nonces[1] ?? 0n);
      // currentNonces[1] = current mech request count
      const currentRequestCount = BigInt(currentNonces[1] ?? 0n);

      // Apply the Pearl eligibility formula
      const effectivePeriod = Math.max(contractData.livenessPeriod, now - tsCheckpoint);
      const requiredRequests = Math.ceil(
        effectivePeriod * Number(contractData.livenessRatio) / 1e18
      ) + SAFETY_MARGIN;
      const eligibleRequests = Number(currentRequestCount - baselineRequestCount);
      const isEligibleForRewards = eligibleRequests >= requiredRequests;
      const requestsNeeded = Math.max(0, requiredRequests - eligibleRequests);

      const status: ServiceActivityStatus = {
        serviceConfigId,
        serviceId,
        multisig,
        stakingContract,
        livenessPeriod: contractData.livenessPeriod,
        tsCheckpoint,
        livenessRatio: contractData.livenessRatio,
        currentRequestCount,
        baselineRequestCount,
        requiredRequests,
        eligibleRequests,
        isEligibleForRewards,
        requestsNeeded,
        fetchedAt: Date.now(),
      };

      rotationLogger.debug({
        serviceId,
        eligible: isEligibleForRewards,
        requestsNeeded,
        required: requiredRequests,
        current: eligibleRequests,
      }, 'Activity check');

      return status;
    } catch (error: any) {
      rotationLogger.error({
        serviceId,
        stakingContract,
        error: error?.message || String(error),
      }, 'Activity check failed');

      return {
        serviceConfigId,
        serviceId,
        multisig,
        stakingContract,
        livenessPeriod: 0,
        tsCheckpoint: 0,
        livenessRatio: 0n,
        currentRequestCount: 0n,
        baselineRequestCount: 0n,
        requiredRequests: 0,
        eligibleRequests: 0,
        isEligibleForRewards: false,
        requestsNeeded: -1,
        fetchedAt: Date.now(),
        error: error?.message || String(error),
      };
    }
  }

  /**
   * Check activity status for all services
   * Groups queries by staking contract for efficiency
   */
  async checkAllServices(inputs: ServiceCheckInput[]): Promise<ServiceActivityStatus[]> {
    if (inputs.length === 0) return [];

    // Pre-warm contract caches for all unique staking contracts (parallel)
    const uniqueContracts = [...new Set(inputs.map(i => i.stakingContract.toLowerCase()))];
    await Promise.all(uniqueContracts.map(c => this.getContractData(c).catch(() => null)));
    await Promise.all(uniqueContracts.map(c => this.getCheckpointTs(c).catch(() => 0)));

    // Check each service (per-service data must be fresh)
    return Promise.all(inputs.map(input => this.checkService(input)));
  }

  /**
   * Clear all caches (for testing or when staking state changes)
   */
  clearCache(): void {
    this.contractCache.clear();
    this.checkpointCache.clear();
    rotationLogger.debug('Activity monitor caches cleared');
  }
}
