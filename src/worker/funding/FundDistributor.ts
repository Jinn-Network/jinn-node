/**
 * Fund Distributor — Automatic ETH distribution from Master Safe to service addresses
 *
 * Periodically checks ETH balances of all service Safes and agent EOAs,
 * and tops them up from the Master Safe when they fall below the threshold
 * defined in each service's fund_requirements config.
 *
 * Mirrors the middleware's funding_job (manage.py:2312) behavior:
 * - Threshold = 50% of fund_requirements target
 * - Top-up fills to 100% of target
 * - Transfers batched into a single Safe transaction
 */

import { ethers } from 'ethers';
import SafeDefault from '@safe-global/protocol-kit';
import { promises as fs } from 'fs';
import { join } from 'path';
import { workerLogger } from '../../logging/index.js';
import { getMasterSafe, getMasterPrivateKey, getMiddlewarePath } from '../../env/operate-profile.js';
import type { ServiceInfo } from '../ServiceConfigReader.js';

// Handle ESM/CJS interop for Safe SDK
const Safe = (SafeDefault as any).default ?? SafeDefault;

const log = workerLogger.child({ component: 'FUND-DISTRIBUTOR' });

/** Matches middleware DEFAULT_TOPUP_THRESHOLD */
const TOPUP_THRESHOLD_FRACTION = 0.5;

/** Minimum ETH to keep in Master Safe (don't drain it completely) */
const DEFAULT_RESERVE_WEI = ethers.parseEther('0.002');

/** Zero address represents native ETH in fund_requirements */
const ETH_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface FundTransfer {
  to: string;
  label: string;
  amountWei: bigint;
}

export interface FundDistributionResult {
  checked: number;
  funded: FundTransfer[];
  skipped: string[];
  txHash?: string;
  error?: string;
}

interface FundRequirements {
  agent: number; // wei
  safe: number;  // wei
}

/**
 * Read fund_requirements from a service's config.json.
 * ServiceInfo doesn't include this, so we read the raw config.
 */
async function readFundRequirements(serviceConfigId: string): Promise<FundRequirements | null> {
  const middlewarePath = getMiddlewarePath();
  if (!middlewarePath) return null;

  try {
    const configPath = join(middlewarePath, '.operate', 'services', serviceConfigId, 'config.json');
    const raw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);
    const homeChain = config.home_chain || 'base';
    const reqs = config.chain_configs?.[homeChain]?.chain_data?.user_params?.fund_requirements?.[ETH_ADDRESS];
    if (reqs && typeof reqs.agent === 'number' && typeof reqs.safe === 'number') {
      return reqs;
    }
  } catch (err) {
    log.debug({ serviceConfigId, error: (err as Error).message }, 'Could not read fund_requirements');
  }
  return null;
}

/**
 * Check all service addresses and distribute ETH from Master Safe as needed.
 *
 * @param services - All services from ServiceRotator
 * @param rpcUrl - RPC URL for balance queries and transaction submission
 * @param options.reserveWei - Minimum ETH to keep in Master Safe (default 0.002 ETH)
 */
export async function maybeDistributeFunds(
  services: ServiceInfo[],
  rpcUrl: string,
  options?: { reserveWei?: bigint },
): Promise<FundDistributionResult> {
  const result: FundDistributionResult = { checked: 0, funded: [], skipped: [] };
  const reserveWei = options?.reserveWei ?? DEFAULT_RESERVE_WEI;

  const masterSafeAddress = getMasterSafe('base');
  if (!masterSafeAddress) {
    result.error = 'Master Safe address not found';
    log.warn(result.error);
    return result;
  }

  const masterPrivateKey = getMasterPrivateKey();
  if (!masterPrivateKey) {
    result.error = 'Master private key not available (OPERATE_PASSWORD set?)';
    log.warn(result.error);
    return result;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const masterBalance = await provider.getBalance(masterSafeAddress);

  log.info({
    masterSafe: masterSafeAddress,
    masterBalanceEth: ethers.formatEther(masterBalance),
    serviceCount: services.length,
  }, 'Fund distribution check starting');

  if (masterBalance <= reserveWei) {
    result.error = `Master Safe balance (${ethers.formatEther(masterBalance)} ETH) at or below reserve (${ethers.formatEther(reserveWei)} ETH)`;
    log.warn(result.error);
    return result;
  }

  const availableWei = masterBalance - reserveWei;
  const transfers: FundTransfer[] = [];

  for (const svc of services) {
    if (!svc.serviceSafeAddress || !svc.agentEoaAddress) continue;

    const reqs = await readFundRequirements(svc.serviceConfigId);
    if (!reqs) {
      result.skipped.push(`${svc.serviceConfigId}: no fund_requirements`);
      continue;
    }

    result.checked++;

    // Check service Safe balance against threshold
    const safeTarget = BigInt(reqs.safe);
    const safeThreshold = safeTarget / 2n;
    const safeBalance = await provider.getBalance(svc.serviceSafeAddress);

    if (safeBalance < safeThreshold && safeTarget > 0n) {
      const topUp = safeTarget - safeBalance;
      transfers.push({
        to: svc.serviceSafeAddress,
        label: `Service #${svc.serviceId} Safe`,
        amountWei: topUp,
      });
    }

    // Check agent EOA balance against threshold
    const agentTarget = BigInt(reqs.agent);
    const agentThreshold = agentTarget / 2n;
    const agentBalance = await provider.getBalance(svc.agentEoaAddress);

    if (agentBalance < agentThreshold && agentTarget > 0n) {
      const topUp = agentTarget - agentBalance;
      transfers.push({
        to: svc.agentEoaAddress,
        label: `Service #${svc.serviceId} Agent`,
        amountWei: topUp,
      });
    }
  }

  if (transfers.length === 0) {
    log.info({ checked: result.checked }, 'All service addresses adequately funded');
    return result;
  }

  // Trim transfers to fit within available Master Safe balance
  const totalNeeded = transfers.reduce((sum, t) => sum + t.amountWei, 0n);
  const affordableTransfers: FundTransfer[] = [];
  let runningTotal = 0n;

  for (const transfer of transfers) {
    if (runningTotal + transfer.amountWei <= availableWei) {
      affordableTransfers.push(transfer);
      runningTotal += transfer.amountWei;
    } else {
      result.skipped.push(`${transfer.label}: insufficient Master Safe funds`);
    }
  }

  if (affordableTransfers.length === 0) {
    result.error = `Need ${ethers.formatEther(totalNeeded)} ETH but only ${ethers.formatEther(availableWei)} available after reserve`;
    log.warn(result.error);
    return result;
  }

  log.info({
    transfers: affordableTransfers.map(t => ({
      to: t.to,
      label: t.label,
      ethAmount: ethers.formatEther(t.amountWei),
    })),
    totalEth: ethers.formatEther(runningTotal),
  }, 'Executing fund distribution');

  try {
    const safeSdk = await Safe.init({
      provider: rpcUrl,
      signer: masterPrivateKey,
      safeAddress: masterSafeAddress,
    });

    const metaTxs = affordableTransfers.map(t => ({
      to: t.to,
      value: t.amountWei.toString(),
      data: '0x',
      operation: 0,
    }));

    const safeTransaction = await safeSdk.createTransaction({ transactions: metaTxs });
    const signedTx = await safeSdk.signTransaction(safeTransaction);
    const executeTxResponse = await safeSdk.executeTransaction(signedTx);

    const txHash = executeTxResponse.hash;
    const txResponse = executeTxResponse.transactionResponse;

    if (txResponse) {
      // Wait for confirmation if transaction response is available
      const receipt = await (txResponse as any).wait();
      const status = receipt?.status;
      // Safe SDK v6 may return status as string "success" or number 1
      if (status === 1 || status === 'success') {
        result.funded = affordableTransfers;
        result.txHash = receipt?.hash ?? txHash;
        log.info({
          txHash: result.txHash,
          fundedCount: affordableTransfers.length,
          totalEth: ethers.formatEther(runningTotal),
        }, 'Fund distribution complete');
      } else {
        throw new Error(`Safe transaction reverted (status: ${status})`);
      }
    } else if (txHash) {
      // No transactionResponse but we have a hash — assume success
      result.funded = affordableTransfers;
      result.txHash = txHash;
      log.info({
        txHash,
        fundedCount: affordableTransfers.length,
        totalEth: ethers.formatEther(runningTotal),
      }, 'Fund distribution submitted (hash only)');
    } else {
      throw new Error('Safe transaction response and hash both missing');
    }
  } catch (err) {
    result.error = (err as Error).message;
    log.error({ error: result.error }, 'Fund distribution transaction failed');
  }

  return result;
}
