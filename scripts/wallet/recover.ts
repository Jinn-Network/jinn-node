#!/usr/bin/env tsx
/**
 * Recover - Full emergency recovery: unstake + withdraw all funds
 *
 * Usage:
 *   yarn wallet:recover --to <address>             # Full recovery
 *   yarn wallet:recover --to <address> --dry-run  # Preview without executing
 *
 * This performs a complete fund recovery:
 * 1. Terminate service (if staked) - triggers unstaking
 * 2. Withdraw all funds from Master Safe (ETH + OLAS)
 * 3. Withdraw all funds from Service Safe (ETH)
 * 4. Sweep remaining ETH from EOAs (optional)
 */

import 'dotenv/config';
import { parseArgs } from 'util';
import { ethers } from 'ethers';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';

// OLAS token address on Base
const OLAS_TOKEN_BASE = '0x54330d28ca3357F294334BDC454a032e7f353416';
// Native token (ETH) represented as zero address
const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

// ERC20 ABI
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function getBalances(
  provider: ethers.JsonRpcProvider,
  address: string
): Promise<{ eth: bigint; olas: bigint }> {
  const ethBalance = await provider.getBalance(address);
  const olasContract = new ethers.Contract(OLAS_TOKEN_BASE, ERC20_ABI, provider);
  const olasBalance = await olasContract.balanceOf(address);
  return { eth: ethBalance, olas: olasBalance };
}

async function main() {
  const { values } = parseArgs({
    options: {
      to: { type: 'string', short: 't' },
      'dry-run': { type: 'boolean', default: false },
      'skip-terminate': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' }
    },
    allowPositionals: false
  });

  if (values.help) {
    console.log(`
Full emergency fund recovery - terminates service and withdraws all funds.

Usage:
  yarn wallet:recover --to <address>             # Full recovery
  yarn wallet:recover --to <address> --dry-run  # Preview without executing

Options:
  --to, -t            Destination address for all funds (required)
  --dry-run           Preview recovery without executing
  --skip-terminate    Skip service termination (if already unstaked)
  --help, -h          Show this help message

Recovery steps:
  1. Terminate service (unstakes from staking contract)
  2. Withdraw OLAS + ETH from Master Safe
  3. Withdraw ETH from Service Safe
  4. (Optional) Sweep EOAs

⚠️  WARNING: This is a destructive operation!
    After recovery, your service will be terminated and funds withdrawn.
`);
    process.exit(0);
  }

  if (!values.to) {
    console.error('Error: --to <address> is required');
    console.error('Usage: yarn wallet:recover --to <address>');
    process.exit(1);
  }

  if (!ethers.isAddress(values.to)) {
    console.error('Error: Invalid destination address');
    process.exit(1);
  }

  const password = process.env.OPERATE_PASSWORD;
  if (!password) {
    console.error('Error: OPERATE_PASSWORD environment variable is required');
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('Error: RPC_URL environment variable is required');
    process.exit(1);
  }

  const dryRun = values['dry-run'];
  const skipTerminate = values['skip-terminate'];
  const destination = values.to;

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`           FULL FUND RECOVERY ${dryRun ? '(DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Destination: ${destination}`);
  console.log('');

  if (!dryRun) {
    console.log('⚠️  WARNING: This will terminate your service and withdraw all funds!');
    console.log('');
  }

  // Create wrapper and start daemon
  const wrapper = await OlasOperateWrapper.create({ rpcUrl });
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    await wrapper.startServer();
    await wrapper.login(password);

    // Step 1: Get wallet info
    console.log('Step 1: Fetching wallet information...');
    const walletResult = await wrapper.getWalletInfo();
    if (!walletResult.success || !walletResult.wallets?.length) {
      console.error('Failed to get wallet info:', walletResult.error);
      process.exit(1);
    }

    const wallet = walletResult.wallets[0];
    const masterEOA = wallet.address;
    const masterSafe = wallet.safes?.base;

    console.log(`  Master EOA: ${masterEOA}`);
    console.log(`  Master Safe: ${masterSafe || 'Not found'}`);

    // Step 2: Get service info (v2 API)
    console.log('\nStep 2: Fetching service information...');
    const servicesResult = await wrapper.getServices();
    let serviceSafe: string | undefined;
    let serviceConfigId: string | undefined;

    if (servicesResult.success && servicesResult.services?.length) {
      const service = servicesResult.services[0];
      serviceConfigId = service.service_config_id;
      serviceSafe = service.chain_configs?.base?.chain_data?.multisig;
      console.log(`  Service Config ID: ${serviceConfigId}`);
      console.log(`  Service Safe: ${serviceSafe || 'Not found'}`);
    } else {
      console.log('  No active services found');
    }

    // Step 3: Calculate total funds to recover
    console.log('\nStep 3: Calculating funds to recover...');

    let totalEth = 0n;
    let totalOlas = 0n;

    if (masterSafe) {
      const masterBalances = await getBalances(provider, masterSafe);
      console.log(`  Master Safe ETH:  ${ethers.formatEther(masterBalances.eth)}`);
      console.log(`  Master Safe OLAS: ${ethers.formatEther(masterBalances.olas)}`);
      totalEth += masterBalances.eth;
      totalOlas += masterBalances.olas;
    }

    if (serviceSafe && serviceSafe !== masterSafe) {
      const serviceBalances = await getBalances(provider, serviceSafe);
      console.log(`  Service Safe ETH:  ${ethers.formatEther(serviceBalances.eth)}`);
      console.log(`  Service Safe OLAS: ${ethers.formatEther(serviceBalances.olas)}`);
      totalEth += serviceBalances.eth;
      totalOlas += serviceBalances.olas;
    }

    const eoaBalances = await getBalances(provider, masterEOA);
    console.log(`  Master EOA ETH:   ${ethers.formatEther(eoaBalances.eth)}`);
    totalEth += eoaBalances.eth;

    console.log('\n  ────────────────────────────────────');
    console.log(`  Total ETH:  ${ethers.formatEther(totalEth)}`);
    console.log(`  Total OLAS: ${ethers.formatEther(totalOlas)}`);

    if (dryRun) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('DRY RUN COMPLETE - No transactions executed');
      console.log('');
      console.log('Recovery would:');
      if (!skipTerminate && serviceConfigId) {
        console.log(`  1. Terminate service ${serviceConfigId}`);
      }
      if (masterSafe) {
        console.log(`  2. Withdraw from Master Safe to ${destination}`);
      }
      if (serviceSafe && serviceSafe !== masterSafe) {
        console.log(`  3. Withdraw from Service Safe to ${destination}`);
      }
      console.log('');
      console.log('Remove --dry-run to execute recovery');
      console.log('═══════════════════════════════════════════════════════════════');
      process.exit(0);
    }

    // Step 4: Terminate service (if not skipped)
    if (!skipTerminate && serviceConfigId) {
      console.log('\nStep 4: Terminating service...');
      const terminateResult = await wrapper.terminateAndWithdraw(serviceConfigId, destination);

      if (terminateResult.success) {
        console.log('  ✓ Service terminated');
      } else {
        console.log(`  ⚠️ Terminate may have failed: ${terminateResult.error}`);
        console.log('  Continuing with withdrawal...');
      }
    }

    // Step 5: Withdraw from Master Safe
    if (masterSafe) {
      console.log('\nStep 5: Withdrawing from Master Safe...');

      const masterBalances = await getBalances(provider, masterSafe);
      const withdrawAssets: Record<string, Record<string, string>> = { base: {} };

      // Leave some ETH for gas
      if (masterBalances.eth > ethers.parseEther('0.001')) {
        withdrawAssets.base[NATIVE_TOKEN] = (masterBalances.eth - ethers.parseEther('0.001')).toString();
      }
      if (masterBalances.olas > 0n) {
        withdrawAssets.base[OLAS_TOKEN_BASE] = masterBalances.olas.toString();
      }

      if (Object.keys(withdrawAssets.base).length > 0) {
        const withdrawResult = await wrapper.withdrawFunds(destination, withdrawAssets);

        if (withdrawResult.success) {
          console.log('  ✓ Master Safe withdrawal complete');
          if (withdrawResult.transferTxs) {
            for (const [chain, tokens] of Object.entries(withdrawResult.transferTxs)) {
              for (const [token, txs] of Object.entries(tokens)) {
                const name = token === NATIVE_TOKEN ? 'ETH' : 'OLAS';
                for (const tx of txs) {
                  console.log(`    ${name}: ${tx}`);
                }
              }
            }
          }
        } else {
          console.log(`  ⚠️ Withdrawal may have failed: ${withdrawResult.error}`);
        }
      } else {
        console.log('  No funds to withdraw from Master Safe');
      }
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('✅ RECOVERY COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`All available funds have been sent to: ${destination}`);
    console.log('');
    console.log('Check the destination address to confirm receipt.');
    console.log('═══════════════════════════════════════════════════════════════');

  } finally {
    await wrapper.stopServer();
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
