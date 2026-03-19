/**
 * RestorationMarketplace Contract Interface
 *
 * Provides contract interaction utilities for the EIP-8183 ACPCore marketplace
 * and the Jinn MarketplaceProxy (for open claiming).
 *
 * Part of JINN-457: Invariant Restoration Marketplace on EIP-8183
 */

import { Contract, Interface, JsonRpcProvider, Wallet, ethers } from 'ethers';
import { createRpcProvider } from '../../config/index.js';
import { logger } from '../../logging/index.js';

const log = logger.child({ component: 'RESTORATION-MARKETPLACE' });

// ============ Contract Addresses ============

/** Deployed ACPCore on Base mainnet */
export const ACP_CORE_ADDRESS = '0x16213AB6a660A24f36d4F8DdACA7a3d0856A8AF5';

/** USDC on Base */
export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ============ ABIs ============

export const ACP_CORE_ABI = [
  // Views
  'function getJob(uint256 jobId) view returns (tuple(address client, address provider, address evaluator, address hook, address token, uint256 budget, uint256 expiredAt, uint8 status))',
  'function jobCount() view returns (uint256)',
  'function getDescription(uint256 jobId) view returns (string)',
  'function DEFAULT_TOKEN() view returns (address)',

  // Write (called by proxy/provider/evaluator)
  'function submit(uint256 jobId, bytes deliverable, bytes optParams)',
  'function complete(uint256 jobId, bytes reason, bytes optParams)',
  'function reject(uint256 jobId, bytes reason, bytes optParams)',

  // Events
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed evaluator, address provider, address hook, uint256 expiredAt)',
  'event JobFunded(uint256 indexed jobId, uint256 amount)',
  'event JobSubmitted(uint256 indexed jobId, bytes deliverable)',
  'event JobCompleted(uint256 indexed jobId, bytes reason)',
  'event JobRejected(uint256 indexed jobId, bytes reason)',
  'event JobExpired(uint256 indexed jobId)',
  'event ProviderSet(uint256 indexed jobId, address indexed provider)',
  'event BudgetSet(uint256 indexed jobId, uint256 amount)',
];

export const MARKETPLACE_PROXY_ABI = [
  'function createJob(address evaluator, uint256 expiredAt, string description) returns (uint256 jobId)',
  'function claimJob(uint256 jobId)',
  'function setBudget(uint256 jobId, uint256 amount)',
  'function fundJob(uint256 jobId, uint256 amount)',
  'function claimRefund(uint256 jobId)',
  'function jobCreators(uint256 jobId) view returns (address)',
  'function acp() view returns (address)',
  'function token() view returns (address)',
];

export const ACTIVITY_CHECKER_ABI = [
  'function recordActivity(address multisig, uint8 activityType)',
  'function activityCounts(address multisig) view returns (uint256)',
  'function activityCountsByType(address multisig, uint8 activityType) view returns (uint256)',
  'function getMultisigNonces(address multisig) view returns (uint256[])',
  'function isRatioPass(uint256[] curNonces, uint256[] lastNonces, uint256 ts) view returns (bool)',
  'function authorizedCallers(address) view returns (bool)',
  'event ActivityRecorded(address indexed multisig, uint8 indexed activityType, uint256 totalCount)',
];

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// ============ Types ============

export enum JobStatus {
  Open = 0,
  Funded = 1,
  Submitted = 2,
  Completed = 3,
  Rejected = 4,
  Expired = 5,
}

export enum ActivityType {
  CREATE = 0,
  DELIVER = 1,
  EVALUATE = 2,
}

export interface Job {
  client: string;
  provider: string;
  evaluator: string;
  hook: string;
  token: string;
  budget: bigint;
  expiredAt: bigint;
  status: JobStatus;
}

export interface RestorationMarketplaceConfig {
  acpCoreAddress: string;
  proxyAddress: string;
  activityCheckerAddress: string;
  rpcUrl?: string;
}

// ============ Safe Transaction Helper ============

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)',
];

/**
 * Execute a contract call through a Safe (threshold=1).
 * Reuses the proven pattern from MechMarketplaceRequester.
 */
async function execViaSafe(
  safe: Contract,
  to: string,
  data: string,
  wallet: Wallet,
  value: bigint = 0n,
): Promise<ethers.TransactionReceipt> {
  const safeNonce = await safe.nonce();
  const txHash = await safe.getTransactionHash(
    to, value, data, 0, // operation = CALL
    0, 0, 0,            // safeTxGas, baseGas, gasPrice
    ethers.ZeroAddress, ethers.ZeroAddress,
    safeNonce,
  );

  const signature = await wallet.signMessage(ethers.getBytes(txHash));
  const sigBytes = ethers.getBytes(signature);
  // Adjust v value for Safe contract (+4)
  const adjustedSig = ethers.concat([
    sigBytes.slice(0, 32),
    sigBytes.slice(32, 64),
    new Uint8Array([sigBytes[64] + 4]),
  ]);

  const tx = await safe.execTransaction(
    to, value, data, 0,
    0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress,
    adjustedSig,
    { gasLimit: 2_000_000 },
  );

  const receipt = await tx.wait();
  if (!receipt) throw new Error('Transaction receipt is null');
  return receipt;
}

// ============ Main Class ============

export class RestorationMarketplace {
  private provider: JsonRpcProvider;
  private acpCore: Contract;
  private proxy: Contract;
  private activityChecker: Contract;
  private config: RestorationMarketplaceConfig;

  constructor(config: RestorationMarketplaceConfig) {
    this.config = config;
    this.provider = createRpcProvider();
    this.acpCore = new Contract(config.acpCoreAddress, ACP_CORE_ABI, this.provider);
    this.proxy = new Contract(config.proxyAddress, MARKETPLACE_PROXY_ABI, this.provider);
    this.activityChecker = new Contract(config.activityCheckerAddress, ACTIVITY_CHECKER_ABI, this.provider);
  }

  // ============ Read Operations (direct ACPCore) ============

  async getJob(jobId: number): Promise<Job> {
    const raw = await this.acpCore.getJob(jobId);
    return {
      client: raw.client,
      provider: raw.provider,
      evaluator: raw.evaluator,
      hook: raw.hook,
      token: raw.token,
      budget: raw.budget,
      expiredAt: raw.expiredAt,
      status: Number(raw.status) as JobStatus,
    };
  }

  async getJobCount(): Promise<number> {
    const count = await this.acpCore.jobCount();
    return Number(count);
  }

  async getDescription(jobId: number): Promise<string> {
    return this.acpCore.getDescription(jobId);
  }

  // ============ Write Operations (via Safe → Proxy/ACPCore) ============

  /**
   * CREATE: Post a new restoration job to 8183 via the proxy.
   * The proxy becomes the client; msg.sender (Safe) is tracked as real creator.
   */
  async createRestorationJob(
    safeAddress: string,
    wallet: Wallet,
    evaluator: string,
    expiredAt: number,
    descriptionCID: string,
  ): Promise<{ jobId: number; receipt: ethers.TransactionReceipt }> {
    const safe = new Contract(safeAddress, SAFE_ABI, wallet);
    const iface = new Interface(MARKETPLACE_PROXY_ABI);
    const data = iface.encodeFunctionData('createJob', [evaluator, expiredAt, descriptionCID]);

    const receipt = await execViaSafe(safe, this.config.proxyAddress, data, wallet);

    // Parse JobCreated event from ACPCore logs
    const acpIface = new Interface(ACP_CORE_ABI);
    let jobId = 0;
    for (const eventLog of receipt.logs) {
      try {
        const parsed = acpIface.parseLog({ topics: eventLog.topics as string[], data: eventLog.data });
        if (parsed?.name === 'JobCreated') {
          jobId = Number(parsed.args.jobId);
          break;
        }
      } catch { /* not our event */ }
    }

    if (jobId === 0) {
      log.error({ txHash: receipt.hash }, 'Job creation tx succeeded but JobCreated event not found in logs');
    }

    log.info({ jobId, evaluator, expiredAt, descriptionCID }, 'Created restoration job');
    return { jobId, receipt };
  }

  /**
   * DELIVER (claim): Claim an open job as provider.
   */
  async claimRestorationJob(
    safeAddress: string,
    wallet: Wallet,
    jobId: number,
  ): Promise<ethers.TransactionReceipt> {
    const safe = new Contract(safeAddress, SAFE_ABI, wallet);
    const iface = new Interface(MARKETPLACE_PROXY_ABI);
    const data = iface.encodeFunctionData('claimJob', [jobId]);

    const receipt = await execViaSafe(safe, this.config.proxyAddress, data, wallet);
    log.info({ jobId }, 'Claimed restoration job');
    return receipt;
  }

  /**
   * DELIVER (submit): Submit a deliverable for a claimed job.
   * Called directly on ACPCore (provider = agent address, not proxy).
   */
  async submitDeliverable(
    wallet: Wallet,
    jobId: number,
    deliverableCID: string,
  ): Promise<ethers.TransactionReceipt> {
    const connectedAcp = this.acpCore.connect(wallet) as Contract;
    const tx = await connectedAcp.submit(
      jobId,
      ethers.toUtf8Bytes(deliverableCID),
      '0x',
      { gasLimit: 500_000 },
    );
    const receipt = await tx.wait();
    log.info({ jobId, deliverableCID }, 'Submitted deliverable');
    return receipt;
  }

  /**
   * EVALUATE (complete): Approve a submitted job, releasing payment to provider.
   */
  async completeJob(
    wallet: Wallet,
    jobId: number,
    reasonCID: string,
  ): Promise<ethers.TransactionReceipt> {
    const connectedAcp = this.acpCore.connect(wallet) as Contract;
    const tx = await connectedAcp.complete(
      jobId,
      ethers.toUtf8Bytes(reasonCID),
      '0x',
      { gasLimit: 500_000 },
    );
    const receipt = await tx.wait();
    log.info({ jobId, reasonCID }, 'Completed (approved) job');
    return receipt;
  }

  /**
   * EVALUATE (reject): Reject a submitted job, refunding the client.
   */
  async rejectJob(
    wallet: Wallet,
    jobId: number,
    reasonCID: string,
  ): Promise<ethers.TransactionReceipt> {
    const connectedAcp = this.acpCore.connect(wallet) as Contract;
    const tx = await connectedAcp.reject(
      jobId,
      ethers.toUtf8Bytes(reasonCID),
      '0x',
      { gasLimit: 500_000 },
    );
    const receipt = await tx.wait();
    log.info({ jobId, reasonCID }, 'Rejected job');
    return receipt;
  }

  // ============ Activity Recording ============

  /**
   * Record a restoration activity for OLAS staking rewards.
   * Called after each 8183 action (create/deliver/evaluate).
   */
  async recordActivity(
    wallet: Wallet,
    multisig: string,
    activityType: ActivityType,
  ): Promise<ethers.TransactionReceipt> {
    const connected = this.activityChecker.connect(wallet) as Contract;
    const tx = await connected.recordActivity(multisig, activityType, { gasLimit: 200_000 });
    const receipt = await tx.wait();
    log.info({ multisig, activityType: ActivityType[activityType] }, 'Recorded activity');
    return receipt;
  }

  /**
   * Get current activity counts for a multisig.
   */
  async getActivityCounts(multisig: string): Promise<{
    total: number;
    creates: number;
    delivers: number;
    evaluates: number;
  }> {
    const [total, creates, delivers, evaluates] = await Promise.all([
      this.activityChecker.activityCounts(multisig),
      this.activityChecker.activityCountsByType(multisig, ActivityType.CREATE),
      this.activityChecker.activityCountsByType(multisig, ActivityType.DELIVER),
      this.activityChecker.activityCountsByType(multisig, ActivityType.EVALUATE),
    ]);
    return {
      total: Number(total),
      creates: Number(creates),
      delivers: Number(delivers),
      evaluates: Number(evaluates),
    };
  }

  // ============ Funding helpers ============

  /**
   * Set budget and fund a job in one flow.
   * For phase 0, jobs can have minimal/zero funding.
   */
  async setBudgetAndFund(
    safeAddress: string,
    wallet: Wallet,
    jobId: number,
    amount: bigint,
  ): Promise<ethers.TransactionReceipt> {
    const safe = new Contract(safeAddress, SAFE_ABI, wallet);

    // Step 1: Approve USDC from Safe to Proxy
    const erc20Iface = new Interface(ERC20_ABI);
    const approveData = erc20Iface.encodeFunctionData('approve', [this.config.proxyAddress, amount]);
    await execViaSafe(safe, USDC_ADDRESS, approveData, wallet);

    // Step 2: Set budget
    const proxyIface = new Interface(MARKETPLACE_PROXY_ABI);
    const setBudgetData = proxyIface.encodeFunctionData('setBudget', [jobId, amount]);
    await execViaSafe(safe, this.config.proxyAddress, setBudgetData, wallet);

    // Step 3: Fund
    const fundData = proxyIface.encodeFunctionData('fundJob', [jobId, amount]);
    const receipt = await execViaSafe(safe, this.config.proxyAddress, fundData, wallet);

    log.info({ jobId, amount: amount.toString() }, 'Set budget and funded job');
    return receipt;
  }
}
