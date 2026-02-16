#!/usr/bin/env tsx
/**
 * Add Service - Provision an additional OLAS service for multi-service rotation
 *
 * Usage: yarn service:add [--staking-contract <address>] [--no-mech] [--dry-run]
 *
 * Prerequisites:
 * - OPERATE_PASSWORD env var set
 * - RPC_URL env var set
 * - Existing Master EOA + Master Safe (from initial setup)
 *
 * This creates a new service under the existing Master EOA/Safe, using the
 * same staking contract as existing services (or a custom one). The new service
 * gets its own agent key, service NFT, and service Safe.
 */

import 'dotenv/config';
import { promises as fsPromises } from 'fs';
import { join } from 'path';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';
import { createDefaultServiceConfig, SERVICE_CONSTANTS } from '../../src/worker/config/ServiceConfig.js';
import { enableMechMarketplaceInConfig } from '../../src/worker/config/MechConfig.js';
import { listServiceConfigs, cleanupUndeployedConfigs } from '../../src/worker/ServiceConfigReader.js';
import { printHeader, printStep, printFundingRequirements, printSuccess, printError } from '../../src/setup/display.js';
import { ethers } from 'ethers';

const OLAS_TOKEN_BASE = '0x54330d28ca3357F294334BDC454a032e7f353416';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
const STAKING_ABI = ['function getServiceIds() view returns (uint256[])'];

function parseArgs(): { stakingContract?: string; dryRun: boolean; noMech: boolean; mechMarketplace?: string; mechPrice?: string } {
  const args = process.argv.slice(2);
  let stakingContract: string | undefined;
  let dryRun = false;
  let noMech = false;
  let mechMarketplace: string | undefined;
  let mechPrice: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--staking-contract' && args[i + 1]) {
      stakingContract = args[++i];
    } else if (args[i] === '--mech-marketplace' && args[i + 1]) {
      mechMarketplace = args[++i];
    } else if (args[i] === '--mech-price' && args[i + 1]) {
      mechPrice = args[++i];
    } else if (args[i] === '--no-mech') {
      noMech = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  return { stakingContract, dryRun, noMech, mechMarketplace, mechPrice };
}

async function main() {
  const { stakingContract: stakingContractArg, dryRun, noMech, mechMarketplace, mechPrice } = parseArgs();

  printHeader('Add OLAS Service');

  // --- Preflight checks ---
  const password = process.env.OPERATE_PASSWORD;
  const rpcUrl = process.env.RPC_URL;

  if (!password) {
    printError('OPERATE_PASSWORD environment variable is required');
    process.exit(1);
  }
  if (!rpcUrl) {
    printError('RPC_URL environment variable is required');
    process.exit(1);
  }

  printStep('active', 'Starting middleware daemon...');

  const wrapper = await OlasOperateWrapper.create({
    rpcUrl,
    defaultEnv: {
      operatePassword: password,
      stakingProgram: 'custom_staking',
      chainLedgerRpc: { base: rpcUrl },
      attended: true,
    },
  });

  try {
    await wrapper.startServer();

    // Login
    const loginResult = await wrapper.login(password);
    if (!loginResult.success) {
      // Try setup if login fails (first time)
      const setupResult = await wrapper.setupUserAccount(password);
      if (!setupResult.success && !setupResult.error?.includes('Account already exists')) {
        printError(`Authentication failed: ${setupResult.error}`);
        process.exit(1);
      }
    }
    printStep('done', 'Middleware daemon started');

    // Verify wallet exists
    printStep('active', 'Checking wallet...');
    const walletInfo = await wrapper.getWalletInfo();
    if (!walletInfo.success || !walletInfo.wallets?.length) {
      printError('No wallet found. Run initial setup first (yarn setup).');
      process.exit(1);
    }
    const masterEoa = walletInfo.wallets[0].address;
    printStep('done', 'Wallet found', `Master EOA: ${masterEoa}`);

    // Verify Master Safe exists
    printStep('active', 'Checking Master Safe...');
    const masterSafe = await wrapper.getExistingSafeForChain('base');
    if (!masterSafe) {
      printError('No Master Safe found on Base. Run initial setup first (yarn setup).');
      process.exit(1);
    }
    printStep('done', 'Master Safe found', `Address: ${masterSafe}`);

    // Clean up stale configs from previous interrupted runs
    const middlewarePath = wrapper.getMiddlewarePath();
    printStep('active', 'Cleaning up stale configs...');
    const { removed } = await cleanupUndeployedConfigs(middlewarePath);
    if (removed.length > 0) {
      printStep('done', `Removed ${removed.length} stale config(s)`, removed.join(', '));
    } else {
      printStep('done', 'No stale configs found');
    }

    // List existing services
    printStep('active', 'Listing existing services...');
    const existingServices = await listServiceConfigs(middlewarePath);
    printStep('done', `Found ${existingServices.length} existing service(s)`);

    for (const svc of existingServices) {
      console.log(`      - ${svc.serviceConfigId} (service #${svc.serviceId ?? 'N/A'}, mech: ${svc.mechContractAddress ?? 'none'})`);
    }

    // Determine staking contract
    let stakingContract = stakingContractArg;
    if (!stakingContract) {
      // Use same staking contract as first existing service
      const firstStaked = existingServices.find(s => s.stakingContractAddress);
      if (firstStaked?.stakingContractAddress) {
        stakingContract = firstStaked.stakingContractAddress;
        console.log(`\n  Using staking contract from existing service: ${stakingContract}`);
      } else {
        stakingContract = SERVICE_CONSTANTS.DEFAULT_STAKING_PROGRAM_ID;
        console.log(`\n  Using default staking contract: ${stakingContract}`);
      }
    }

    // Preflight: check staking slots
    printStep('active', 'Checking staking contract slots...');
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const stakingContractInstance = new ethers.Contract(stakingContract, STAKING_ABI, provider);
      const serviceIds = await stakingContractInstance.getServiceIds();
      console.log(`      Staked services: ${serviceIds.length}`);
      // Note: we don't know maxNumServices without the full ABI, just warn if many
      if (serviceIds.length >= 10) {
        console.log(`      Warning: contract has ${serviceIds.length} services staked, may be near capacity`);
      }
      printStep('done', 'Staking contract accessible');
    } catch {
      console.log('      Could not query staking contract (will proceed anyway)');
      printStep('done', 'Staking contract check skipped');
    }

    // Preflight: check OLAS balance on Master Safe
    printStep('active', 'Checking Master Safe OLAS balance...');
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const olasContract = new ethers.Contract(OLAS_TOKEN_BASE, ERC20_ABI, provider);
      const olasBalance = await olasContract.balanceOf(masterSafe);
      const formatted = ethers.formatEther(olasBalance);
      console.log(`      OLAS balance: ${formatted}`);
      printStep('done', 'Balance checked');
    } catch {
      console.log('      Could not query OLAS balance');
      printStep('done', 'Balance check skipped');
    }

    // --- Create service config ---
    printStep('active', 'Creating service configuration...');
    const serviceConfig = createDefaultServiceConfig({
      home_chain: 'base',
    });

    // Set staking
    serviceConfig.configurations.base.staking_program_id = stakingContract;
    serviceConfig.configurations.base.use_staking = true;
    serviceConfig.configurations.base.rpc = rpcUrl;

    // Enable mech marketplace (skip with --no-mech to save VNet write quota)
    if (!noMech) {
      enableMechMarketplaceInConfig(
        serviceConfig,
        mechMarketplace || '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020',
        mechPrice || '10000000000000000',
      );
    }

    printStep('done', 'Service configuration created');

    // --- Create service via middleware API ---
    printStep('active', 'Creating service in middleware...');
    const createResult = await wrapper.createService(serviceConfig);
    if (!createResult.success) {
      printError(`Service creation failed: ${createResult.error}`);
      process.exit(1);
    }

    const serviceConfigId = createResult.service?.service_config_id;
    if (!serviceConfigId) {
      printError('Service creation succeeded but no service_config_id returned');
      process.exit(1);
    }
    printStep('done', 'Service created', `Config ID: ${serviceConfigId}`);

    // Clean up partial config if interrupted before deployment completes
    const cleanupPartial = async () => {
      console.log('\n  Cleaning up partial service config...');
      try {
        const servicePath = join(middlewarePath, '.operate', 'services', serviceConfigId);
        await fsPromises.rm(servicePath, { recursive: true, force: true });
        console.log('  Cleaned up.');
      } catch {}
      process.exit(130);
    };
    process.on('SIGINT', cleanupPartial);
    process.on('SIGTERM', cleanupPartial);

    if (dryRun) {
      console.log('\n  --dry-run: Service config created but not deployed.');
      console.log(`  Config ID: ${serviceConfigId}`);
      console.log('  Run without --dry-run to fund and deploy.\n');
      return;
    }

    // --- Show funding requirements ---
    printStep('active', 'Fetching funding requirements...');
    const fundingResult = await wrapper.getFundingRequirements(serviceConfigId);
    if (!fundingResult.success) {
      printError(`Failed to fetch funding requirements: ${fundingResult.error}`);
      process.exit(1);
    }

    const requirements = fundingResult.requirements || {};
    const refill = requirements.refill_requirements?.base || {};

    // Format funding requirements for display
    const displayReqs: Array<{ purpose: string; address: string; amount: string; token: string }> = [];
    const zeroAddress = '0x0000000000000000000000000000000000000000';

    for (const [addr, tokens] of Object.entries<any>(refill)) {
      const ethWei = BigInt(tokens?.[zeroAddress] || '0');
      const olasWei = BigInt(tokens?.[OLAS_TOKEN_BASE] || '0');

      if (ethWei > 0n) {
        displayReqs.push({
          purpose: addr.toLowerCase() === masterSafe.toLowerCase() ? 'Master Safe (gas)' : `Address ${addr.slice(0, 10)}...`,
          address: addr,
          amount: ethers.formatEther(ethWei),
          token: 'ETH',
        });
      }
      if (olasWei > 0n) {
        displayReqs.push({
          purpose: addr.toLowerCase() === masterSafe.toLowerCase() ? 'Master Safe (staking bond)' : `Address ${addr.slice(0, 10)}...`,
          address: addr,
          amount: ethers.formatEther(olasWei),
          token: 'OLAS',
        });
      }
    }

    if (displayReqs.length > 0) {
      printFundingRequirements(displayReqs);
    } else {
      printStep('done', 'No additional funding required');
    }

    // --- Check if funding is needed ---
    const allowStart = requirements.allow_start_agent === true;
    const isRefillRequired = requirements.is_refill_required === true;

    if (!allowStart || isRefillRequired) {
      console.log('\n  Fund the addresses above, then re-run this command to continue deployment.\n');
      return;
    }

    // --- Deploy service ---
    printStep('active', 'Deploying service on-chain...');
    const startResult = await wrapper.startService(serviceConfigId);
    if (!startResult.success) {
      printError(`Service deployment failed: ${startResult.error}`);
      process.exit(1);
    }

    // Wait for deployment
    const deployTimeoutMs = 10 * 60 * 1000;
    const deployStart = Date.now();
    let serviceSafe: string | undefined;

    while (Date.now() - deployStart < deployTimeoutMs) {
      const dep = await wrapper.getDeployment(serviceConfigId);
      if (dep.success && dep.deployment?.status === 3) {
        // Extract service safe from deployment
        const chainData = startResult.service?.chain_configs?.base?.chain_data;
        serviceSafe = chainData?.multisig;
        break;
      }
      await new Promise(r => setTimeout(r, 5000));
    }

    printStep('done', 'Service deployed');

    // Deployment complete — no longer need cleanup handler
    process.removeListener('SIGINT', cleanupPartial);
    process.removeListener('SIGTERM', cleanupPartial);

    // --- Show result ---
    const totalServices = existingServices.length + 1;
    printSuccess({
      serviceConfigId,
      serviceSafeAddress: serviceSafe,
    });

    console.log(`  Total services: ${totalServices}`);
    console.log('');
    if (totalServices >= 2) {
      console.log('  To enable multi-service rotation:');
      console.log('    WORKER_MULTI_SERVICE=true');
      console.log('');
    }
  } finally {
    await wrapper.stopServer();
  }
}

main().catch(error => {
  printError(error.message);
  process.exit(1);
});
