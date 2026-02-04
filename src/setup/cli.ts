#!/usr/bin/env node
/**
 * Interactive Service Setup CLI - JINN-202 Simplified Version
 *
 * User-friendly command-line wizard for setting up an OLAS service.
 * Uses middleware daemon + HTTP API (no interactive CLI prompts).
 *
 * Usage:
 *   npx jinn-setup                         # Mainnet deployment (uses .env)
 *   npx jinn-setup --testnet               # Testnet deployment (uses .env.test)
 *   npx jinn-setup --chain=base            # Specify chain
 *   npx jinn-setup --no-mech               # Deploy without mech contract
 *   npx jinn-setup --isolated              # Run in isolated temp directory
 */

import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { SimplifiedServiceBootstrap, type SimplifiedBootstrapConfig } from '../worker/SimplifiedServiceBootstrap.js';
import { logger } from '../logging/index.js';
import { getRequiredRpcUrl, getOptionalMechChainConfig, getOptionalOperatePassword } from '../agent/mcp/tools/shared/env.js';
import { createIsolatedMiddlewareEnvironment, type IsolatedEnvironment } from './test-isolation.js';

const setupLogger = logger.child({ component: "SETUP-CLI" });

// Parse args early to determine environment
const earlyArgs = process.argv.slice(2);
const isTestnet = earlyArgs.includes('--testnet');

// Load appropriate env file based on --testnet flag
if (isTestnet) {
  const testEnvPath = resolve(process.cwd(), '.env.test');
  if (existsSync(testEnvPath)) {
    dotenvConfig({ path: testEnvPath, override: true });
    setupLogger.info('Loaded .env.test for testnet deployment');
  } else {
    console.error('\n Error: .env.test not found');
    console.error('Create .env.test with testnet/Tenderly VNet configuration\n');
    process.exit(1);
  }
}
// Otherwise, .env is already loaded by 'dotenv/config' at line 14

interface CLIArgs {
  chain?: 'base' | 'gnosis' | 'mode' | 'optimism';
  testnet?: boolean;
  noMech?: boolean;
  noStaking?: boolean;
  stakingContract?: string;
  help?: boolean;
  unattended?: boolean;
  isolated?: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {};

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--chain=')) {
      args.chain = arg.split('=')[1] as any;
    } else if (arg === '--testnet') {
      args.testnet = true;
    } else if (arg === '--no-mech') {
      args.noMech = true;
    } else if (arg === '--no-staking') {
      args.noStaking = true;
    } else if (arg.startsWith('--staking-contract=')) {
      args.stakingContract = arg.split('=')[1];
    } else if (arg === '--unattended') {
      args.unattended = true;
    } else if (arg === '--isolated') {
      args.isolated = true;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
+-----------------------------------------------------------------------------+
|           OLAS Service Interactive Setup Wizard (jinn-node)                 |
+-----------------------------------------------------------------------------+

This wizard uses the middleware daemon + HTTP API to guide you through
setting up an OLAS service with non-interactive funding checks.

USAGE:
  npx jinn-setup [OPTIONS]

OPTIONS:
  --testnet           Use .env.test for testnet/Tenderly VNet deployment
                      Default: use .env for mainnet deployment

  --chain=NETWORK     Network to deploy on (base, gnosis, mode, optimism)
                      Default: base

  --no-mech           Disable mech deployment (mech enabled by default)
  --no-staking        Disable staking (staking enabled by default)
  --staking-contract  Custom staking contract address (default: AgentsFun1)
  --unattended        Run middleware in unattended mode (requires env vars)
  --isolated          Run in isolated temp directory (fresh .operate, no production state)
  --help, -h          Show this help message

ENVIRONMENT FILES:
  .env                Production/mainnet configuration (default)
  .env.test           Testnet/Tenderly VNet configuration (use with --testnet)

REQUIRED ENVIRONMENT VARIABLES:
  OPERATE_PASSWORD    Password for wallet encryption
  RPC_URL             RPC URL for the target network

EXAMPLES:
  # Deploy on mainnet using .env
  npx jinn-setup --chain=base

  # Deploy on testnet using .env.test (Tenderly VNet)
  npx jinn-setup --testnet --chain=base

  # Deploy in isolated mode (fresh .operate in temp dir)
  npx jinn-setup --testnet --isolated

  # Deploy without mech
  npx jinn-setup --chain=base --no-mech

  # Deploy on Gnosis network
  npx jinn-setup --chain=gnosis

WHAT HAPPENS:
  The middleware will:
  1. Detect or create Master EOA (wallet)
  2. Detect or create Master Safe
  3. Create Agent Key(s)
  4. Show funding requirements (Master EOA / Master Safe)
  5. Wait for funding (attended mode) and deploy/stake
  6. Deploy mech contract (by default)

FUNDING REQUIREMENTS:
  - The CLI prints exact addresses and amounts needed
  - It polls the daemon until funding is detected
  - Total time: 5-10 minutes depending on transfer confirmation speed

INTERRUPTION:
  - You can Ctrl+C at any time
  - Partial state is automatically cleaned on next run
  - Safe to retry from the beginning

`);
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Validate environment
  const operatePassword = getOptionalOperatePassword();
  if (!operatePassword) {
    console.error(`\n Error: OPERATE_PASSWORD environment variable is required\n`);
    console.error(`Set it in your .env or .env.test file or export it:\n`);
    console.error(`  export OPERATE_PASSWORD="your-password"\n`);
    process.exit(1);
  }

  // Determine chain and RPC URL
  const chain = args.chain || getOptionalMechChainConfig() || 'base';
  const rpcUrl = getRequiredRpcUrl();

  if (!rpcUrl) {
    console.error(`\n Error: RPC_URL environment variable is required\n`);
    console.error(`Set it in your ${args.testnet ? '.env.test' : '.env'} file or export it:\n`);
    console.error(`  export RPC_URL="https://your-rpc-url"\n`);
    process.exit(1);
  }

  // Mech marketplace addresses (Base mainnet is the primary target)
  const mechMarketplaceAddresses: Record<string, string> = {
    base: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020',
    gnosis: '0x0000000000000000000000000000000000000000', // TODO: Add when available
    mode: '0x0000000000000000000000000000000000000000',   // TODO: Add when available
    optimism: '0x0000000000000000000000000000000000000000', // TODO: Add when available
  };

  // Support staking configuration (enabled by default)
  const disableStaking = args.noStaking === true;
  const stakingContract = args.stakingContract as string | undefined;
  const envAttended = typeof process.env.ATTENDED === 'string'
    ? process.env.ATTENDED.toLowerCase() === 'true'
    : undefined;
  const attendedMode = args.unattended ? false : envAttended ?? true;

  // Set mech request price to 0.000005 ETH (5000000000000 wei) for cost-effective marketplace requests
  const mechRequestPrice = '5000000000000'; // 0.000005 ETH in wei

  // Create isolated environment if requested
  let isolatedEnv: IsolatedEnvironment | undefined;
  if (args.isolated) {
    console.log('\n Creating isolated environment (fresh .operate in temp dir)...');
    isolatedEnv = await createIsolatedMiddlewareEnvironment();
    console.log(`   Temp dir: ${isolatedEnv.tempDir}\n`);
  }

  const config: SimplifiedBootstrapConfig = {
    chain: chain as any,
    operatePassword,
    rpcUrl,
    attended: attendedMode,
    // Mech deployment enabled by default for full integration (use --no-mech to disable)
    deployMech: !args.noMech,
    mechMarketplaceAddress: mechMarketplaceAddresses[chain],
    mechRequestPrice: mechRequestPrice,
    // Staking enabled by default (use --no-staking to disable)
    stakingProgram: disableStaking ? 'no_staking' : 'custom_staking',
    customStakingAddress: stakingContract || '0x2585e63df7BD9De8e058884D496658a030b5c6ce', // AgentsFun1
    // Isolated environment paths (if --isolated flag used)
    middlewarePath: isolatedEnv?.middlewareDir,
    workingDirectory: isolatedEnv?.tempDir,
  };

  // Show mode banner
  if (args.testnet) {
    console.log('\n+============================================================+');
    console.log('|              TESTNET DEPLOYMENT MODE                       |');
    console.log('+============================================================+');
    console.log('');
    console.log('Using Tenderly Virtual TestNet');
    console.log('Simulated funds (no real funds needed)');
    console.log('Instant transactions');
    console.log('Full visibility in Tenderly Dashboard');
    console.log('');
    console.log(`Attended mode: ${attendedMode ? 'ENABLED (interactive prompts)' : 'DISABLED (env-driven)'}`);
    if (args.isolated) {
      console.log(`Isolated mode: ENABLED (temp dir: ${isolatedEnv?.tempDir})`);
    }
  } else {
    console.log('\n+============================================================+');
    console.log('|              MAINNET DEPLOYMENT MODE                       |');
    console.log('+============================================================+');
    console.log('');
    console.log(`Network: ${chain.toUpperCase()}`);
    console.log(`Real funds will be used`);
    console.log(`Staking: ${disableStaking ? 'DISABLED' : 'ENABLED (AgentsFun1)'}`);
    if (!disableStaking) {
      console.log(`   Contract: ${stakingContract || '0x2585e63df7BD9De8e058884D496658a030b5c6ce'}`);
      console.log(`   Required: ~100 OLAS (50 OLAS bond + 50 OLAS stake)`);
    }
    console.log(`Mech deployment: ${config.deployMech ? 'ENABLED' : 'DISABLED'}`);
    if (config.deployMech) {
      console.log(`   Request Price: ${mechRequestPrice} wei (0.000005 ETH)`);
      console.log(`   Marketplace: ${config.mechMarketplaceAddress}`);
    }
    console.log('');
    console.log(`Attended mode: ${attendedMode ? 'ENABLED (interactive prompts)' : 'DISABLED (env-driven)'}`);
    if (args.isolated) {
      console.log(`Isolated mode: ENABLED (temp dir: ${isolatedEnv?.tempDir})`);
    }
  }

  setupLogger.info({
    chain,
    withMech: config.deployMech,
    mode: args.testnet ? 'testnet' : 'mainnet',
    attended: attendedMode,
    isolated: args.isolated || false,
    rpcUrl: rpcUrl.substring(0, 30) + '...',
  }, 'Starting simplified interactive service setup');

  const bootstrap = new SimplifiedServiceBootstrap(config);

  try {
    const result = await bootstrap.bootstrap();

    if (result.success) {
      console.log('\n' + '='.repeat(80));
      console.log('  SETUP COMPLETED SUCCESSFULLY');
      console.log('='.repeat(80));
      console.log('');

      if (result.serviceConfigId) {
        console.log(`Service Config ID: ${result.serviceConfigId}`);
      }
      if (result.serviceSafeAddress) {
        console.log(`Service Safe: ${result.serviceSafeAddress}`);
      }
      console.log('');

      // Save result to file for reference
      const resultPath = `/tmp/jinn-service-setup-${Date.now()}.json`;
      const fs = await import('fs/promises');
      await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
      console.log(`Setup details saved to: ${resultPath}`);
      console.log('');

      process.exit(0);
    } else {
      console.error(`\n Setup failed: ${result.error}\n`);
      process.exit(1);
    }
  } finally {
    // Cleanup resources
    await bootstrap.cleanup();

    // Cleanup isolated environment if used
    if (isolatedEnv) {
      console.log('\n Cleaning up isolated environment...');
      await isolatedEnv.cleanup();
      console.log('Cleanup complete');
    }
  }
}

main().catch((error) => {
  console.error(`\n Fatal error:`, error);
  setupLogger.error({ error }, 'Fatal error in setup CLI');
  process.exit(1);
});
