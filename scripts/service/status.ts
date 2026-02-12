#!/usr/bin/env tsx
/**
 * Service Status Dashboard - Comprehensive view of all OLAS services
 *
 * Usage: yarn service:status [--service <configId>]
 *
 * Shows epoch progress, activity requirements, staking health, and balances
 * for all services managed by this node.
 *
 * Requires: RPC_URL environment variable
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { listServiceConfigs, type ServiceInfo } from '../../src/worker/ServiceConfigReader.js';
import { ActivityMonitor, type ServiceCheckInput, type ServiceDashboardStatus } from '../../src/worker/rotation/ActivityMonitor.js';
import { printHeader } from '../../src/setup/display.js';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const OLAS_TOKEN_BASE = '0x54330d28ca3357F294334BDC454a032e7f353416';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

function parseArgs(): { serviceFilter?: string } {
  const args = process.argv.slice(2);
  let serviceFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--service' && args[i + 1]) {
      serviceFilter = args[++i];
    }
  }
  return { serviceFilter };
}

async function resolveMiddlewarePath(): Promise<string> {
  if (process.env.OLAS_MIDDLEWARE_PATH) {
    return resolve(process.env.OLAS_MIDDLEWARE_PATH);
  }
  const currentFile = fileURLToPath(import.meta.url);
  return resolve(dirname(currentFile), '..', '..');
}

async function getBalances(
  provider: ethers.JsonRpcProvider,
  address: string
): Promise<{ eth: string; olas: string }> {
  try {
    const ethBalance = await provider.getBalance(address);
    const olasContract = new ethers.Contract(OLAS_TOKEN_BASE, ERC20_ABI, provider);
    const olasBalance = await olasContract.balanceOf(address);
    return {
      eth: parseFloat(ethers.formatEther(ethBalance)).toFixed(6),
      olas: parseFloat(ethers.formatEther(olasBalance)).toFixed(2),
    };
  } catch {
    return { eth: '?', olas: '?' };
  }
}

function formatAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'overdue';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderProgressBar(pct: number, width: number = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function stakingStateLabel(state: number): string {
  switch (state) {
    case 0: return 'NOT STAKED';
    case 1: return 'STAKED';
    case 2: return 'EVICTED';
    default: return `UNKNOWN (${state})`;
  }
}

async function main() {
  const { serviceFilter } = parseArgs();

  printHeader('JINN Node Service Dashboard');

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('  RPC_URL environment variable is required.\n');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const middlewarePath = await resolveMiddlewarePath();
  const allServices = await listServiceConfigs(middlewarePath);

  if (allServices.length === 0) {
    console.log('  No services found. Run initial setup first.\n');
    process.exit(0);
  }

  // Filter services
  const services = serviceFilter
    ? allServices.filter(s => s.serviceConfigId === serviceFilter)
    : allServices;

  if (services.length === 0) {
    console.log(`  Service "${serviceFilter}" not found.\n`);
    process.exit(1);
  }

  // Get staked services for on-chain queries
  const stakedServices = services.filter(
    s => s.stakingContractAddress && s.serviceId && s.serviceSafeAddress
  );

  let dashboardStatuses: ServiceDashboardStatus[] = [];

  if (stakedServices.length > 0) {
    const monitor = new ActivityMonitor(rpcUrl, 0); // No cache for dashboard
    const inputs: ServiceCheckInput[] = stakedServices.map(s => ({
      serviceConfigId: s.serviceConfigId,
      serviceId: s.serviceId!,
      multisig: s.serviceSafeAddress!,
      stakingContract: s.stakingContractAddress!,
    }));

    try {
      dashboardStatuses = await monitor.getAllDashboardData(inputs);
    } catch (error) {
      console.log(`  Warning: Could not fetch on-chain data: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  const now = Math.floor(Date.now() / 1000);

  // --- Epoch Info ---
  if (dashboardStatuses.length > 0) {
    const first = dashboardStatuses[0];
    const remainingSec = Math.max(0, first.epochEndTimestamp - now);

    console.log(`  Epoch #${first.currentEpoch}  ${renderProgressBar(first.epochProgressPct)} ${first.epochProgressPct}%  (${formatTimeRemaining(remainingSec)} remaining)\n`);
  }

  // --- Per-Service Status ---
  console.log('  \u2500\u2500 Services \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

  for (const svc of services) {
    const dashboard = dashboardStatuses.find(d => d.serviceConfigId === svc.serviceConfigId);

    if (dashboard && !dashboard.error) {
      const icon = dashboard.isEligibleForRewards ? '+' : '-';
      const statusLabel = dashboard.isEligibleForRewards
        ? 'ELIGIBLE'
        : dashboard.stakingState === 2
          ? 'EVICTED'
          : `NEEDS ${dashboard.requestsNeeded} MORE REQUEST${dashboard.requestsNeeded === 1 ? '' : 'S'}`;

      const rewardsOlas = parseFloat(ethers.formatEther(dashboard.accruedRewards)).toFixed(4);
      const requestsDisplay = dashboard.isEligibleForRewards
        ? `${dashboard.eligibleRequests}/${dashboard.requiredRequests} (${dashboard.eligibleRequests - dashboard.requiredRequests} extra)`
        : `${dashboard.eligibleRequests}/${dashboard.requiredRequests}`;

      console.log(`  [${icon}] ${svc.serviceConfigId}  Service #${svc.serviceId}  ${statusLabel}`);
      console.log(`      Requests: ${requestsDisplay}  |  Rewards: ${rewardsOlas} OLAS`);

      // Inactivity warning
      if (dashboard.inactivityCount > 0) {
        const threshold = dashboard.maxInactivityPeriods || 3;
        const severity = dashboard.inactivityCount >= threshold - 1 ? 'CRITICAL' : 'WARNING';
        console.log(`      ${severity}: ${dashboard.inactivityCount}/${threshold} inactive epochs (eviction at ${threshold})`);
      }

      // Balances
      if (svc.serviceSafeAddress) {
        const balances = await getBalances(provider, svc.serviceSafeAddress);
        console.log(`      Safe: ${formatAddress(svc.serviceSafeAddress)}  |  ETH: ${balances.eth}  |  OLAS: ${balances.olas}`);
      }
    } else {
      // Non-staked or errored service
      const errorMsg = dashboard?.error ? ` (${dashboard.error})` : '';
      console.log(`  [?] ${svc.serviceConfigId}  Service #${svc.serviceId ?? 'N/A'}  ${svc.stakingContractAddress ? 'ERROR' + errorMsg : 'NOT STAKED'}`);
      if (svc.serviceSafeAddress) {
        const balances = await getBalances(provider, svc.serviceSafeAddress);
        console.log(`      Safe: ${formatAddress(svc.serviceSafeAddress)}  |  ETH: ${balances.eth}  |  OLAS: ${balances.olas}`);
      }
    }
    console.log('');
  }

  // --- Staking Health ---
  if (dashboardStatuses.length > 0) {
    // Group by staking contract
    const contractGroups = new Map<string, ServiceDashboardStatus[]>();
    for (const d of dashboardStatuses) {
      const key = d.stakingContract.toLowerCase();
      const group = contractGroups.get(key) || [];
      group.push(d);
      contractGroups.set(key, group);
    }

    console.log('  \u2500\u2500 Staking Health \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

    for (const [contractAddr, statuses] of contractGroups) {
      const first = statuses[0];
      const depositOlas = parseFloat(ethers.formatEther(first.minStakingDeposit)).toFixed(0);

      // APY calculation (Pearl formula)
      const ONE_YEAR = 365 * 24 * 60 * 60;
      let apyStr = 'N/A';
      if (first.rewardsPerSecond > 0n && first.minStakingDeposit > 0n) {
        const rewardsPerYear = first.rewardsPerSecond * BigInt(ONE_YEAR);
        const apyBps = (rewardsPerYear * 10000n) / first.minStakingDeposit;
        const apyPct = Number(apyBps) / 100;
        apyStr = `~${apyPct.toFixed(1)}%`;
      }

      console.log(`  Contract: ${formatAddress(contractAddr)}`);
      console.log(`  Slots:    ${first.currentStakedCount}/${first.maxNumServices} used`);
      console.log(`  APY:      ${apyStr}`);
      console.log(`  Deposit:  ${depositOlas} OLAS per service`);
      console.log('');
    }
  }

  // --- Wallet Balances ---
  console.log('  \u2500\u2500 Wallet Balances \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n');

  // Try to get Master EOA + Safe from middleware
  const password = process.env.OPERATE_PASSWORD;
  if (password) {
    try {
      const wrapper = await OlasOperateWrapper.create({ rpcUrl });
      await wrapper.startServer();
      try {
        await wrapper.login(password);
        const walletInfo = await wrapper.getWalletInfo();

        if (walletInfo.success && walletInfo.wallets?.length) {
          const wallet = walletInfo.wallets[0];
          const eoaBalances = await getBalances(provider, wallet.address);
          console.log(`  Master EOA:  ${formatAddress(wallet.address)}  ETH: ${eoaBalances.eth}`);

          if (wallet.safes?.base) {
            const safeBalances = await getBalances(provider, wallet.safes.base);
            console.log(`  Master Safe: ${formatAddress(wallet.safes.base)}  ETH: ${safeBalances.eth}  OLAS: ${safeBalances.olas}`);
          }
        }
      } finally {
        await wrapper.stopServer();
      }
    } catch {
      console.log('  (Set OPERATE_PASSWORD to see wallet balances)');
    }
  } else {
    console.log('  (Set OPERATE_PASSWORD to see wallet balances)');
  }

  console.log('');
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
