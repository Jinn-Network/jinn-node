#!/usr/bin/env tsx
/**
 * Restake — Restake evicted services through the middleware
 *
 * Routes through OlasOperateWrapper → middleware daemon → Python Safe tx builder.
 * This is the same battle-tested path Pearl uses for staking operations.
 *
 * Usage:
 *   yarn wallet:restake                         # Restake all evicted services
 *   yarn wallet:restake --service <config-id>   # Restake specific service
 *   yarn wallet:restake --dry-run               # Preview without executing
 *
 * The middleware's deploy_service_onchain_from_safe() handles:
 *   1. Detect eviction (stakingState == 2)
 *   2. Claim pending rewards
 *   3. Unstake from current contract
 *   4. Approve NFT transfer on ServiceRegistry
 *   5. Restake in target contract
 */

import 'dotenv/config';
import { parseArgs } from 'util';
import { ethers } from 'ethers';
import { OlasOperateWrapper } from '../../src/worker/OlasOperateWrapper.js';
import {
  getServiceStakingInfo,
  getStakingSlots,
  getRewardsAvailable,
  checkAndRestakeServices,
  STAKING_STATE_NAMES,
  type RestakeResult,
} from '../../src/worker/staking/restake.js';

// Default Jinn staking contract on Base
const DEFAULT_STAKING_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';

interface ServiceInfo {
  serviceConfigId: string;
  name: string;
  serviceId: number;
  multisig: string;
  stakingProgramId: string;
  stakingState: number;
  stakingStateName: string;
  canUnstake: boolean;
  unstakeAvailableAt: number | null;
}

async function main() {
  const { values } = parseArgs({
    options: {
      service: { type: 'string', short: 's' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
Restake evicted services through the middleware.

Usage:
  yarn wallet:restake                         # Restake all evicted services
  yarn wallet:restake --service <config-id>   # Restake specific service
  yarn wallet:restake --dry-run               # Preview without executing

Options:
  --service, -s    Service config ID to restake (default: all evicted)
  --dry-run        Preview restaking without executing
  --help, -h       Show this help message

Routes through the olas-operate-middleware's Safe transaction builder,
which handles claim → unstake → approve → stake automatically.
`);
    process.exit(0);
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
  const targetService = values.service;

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`              RESTAKE EVICTED SERVICES ${dryRun ? '(DRY RUN)' : ''}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // For the CLI, we do a verbose flow: list services, show states, pre-flight, then restake.
  // This gives operators full visibility. The core logic is in checkAndRestakeServices().

  const wrapper = await OlasOperateWrapper.create({ rpcUrl });
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    await wrapper.startServer();
    await wrapper.login(password);

    // Step 1: List services
    console.log('Step 1: Fetching services...');
    const servicesResult = await wrapper.getServices();
    if (!servicesResult.success || !servicesResult.services?.length) {
      console.error('Failed to get services:', servicesResult.error || 'No services found');
      process.exit(1);
    }

    // Step 2: Check staking state for each service
    console.log('\nStep 2: Checking staking states...\n');

    const serviceInfos: ServiceInfo[] = [];

    for (const svc of servicesResult.services) {
      const configId = svc.service_config_id;
      const serviceId = svc.chain_configs?.base?.chain_data?.token;
      const multisig = svc.chain_configs?.base?.chain_data?.multisig || '';
      const stakingProgramId =
        svc.chain_configs?.base?.chain_data?.user_params?.staking_program_id ||
        DEFAULT_STAKING_CONTRACT;

      if (!serviceId) {
        console.log(`  ${configId}: No on-chain service ID, skipping`);
        continue;
      }

      const { state, canUnstake, unstakeAvailableAt } = await getServiceStakingInfo(
        provider, serviceId, stakingProgramId,
      );

      const info: ServiceInfo = {
        serviceConfigId: configId,
        name: svc.name || configId,
        serviceId,
        multisig,
        stakingProgramId,
        stakingState: state,
        stakingStateName: STAKING_STATE_NAMES[state] || `UNKNOWN(${state})`,
        canUnstake,
        unstakeAvailableAt,
      };

      serviceInfos.push(info);

      const stateEmoji = state === 2 ? '!!' : state === 1 ? 'ok' : '--';
      console.log(
        `  [${stateEmoji}] Service #${serviceId} (${configId.slice(0, 20)}...): ${info.stakingStateName}`,
      );
      if (state === 2 && !canUnstake && unstakeAvailableAt) {
        console.log(`       Cannot unstake yet — available at ${new Date(unstakeAvailableAt * 1000).toISOString()}`);
      }
    }

    // Filter to target service if specified
    let candidates = serviceInfos;
    if (targetService) {
      candidates = candidates.filter((s) => s.serviceConfigId === targetService);
      if (candidates.length === 0) {
        console.error(`\nError: Service "${targetService}" not found.`);
        console.error(
          `Available: ${serviceInfos.map((s) => s.serviceConfigId).join(', ')}`,
        );
        process.exit(1);
      }
    }

    // Filter to services that need restaking (EVICTED or UNSTAKED with staking configured)
    const needsRestaking = candidates.filter(
      (s) => s.stakingState === 2 || (s.stakingState === 0 && s.stakingProgramId),
    );

    const alreadyStaked = candidates.filter((s) => s.stakingState === 1);
    if (alreadyStaked.length > 0) {
      console.log(
        `\n  ${alreadyStaked.length} service(s) already staked — skipping`,
      );
    }

    if (needsRestaking.length === 0) {
      console.log('\n  No services need restaking.');
      console.log('═══════════════════════════════════════════════════════════════');
      process.exit(0);
    }

    // Step 3: Pre-flight checks
    console.log(`\nStep 3: Pre-flight checks for ${needsRestaking.length} service(s)...`);

    const blocked: ServiceInfo[] = [];
    const ready: ServiceInfo[] = [];

    for (const svc of needsRestaking) {
      if (svc.stakingState === 2 && !svc.canUnstake) {
        blocked.push(svc);
        console.log(`  Service #${svc.serviceId}: BLOCKED — minimum staking duration not elapsed`);
        continue;
      }

      const slots = await getStakingSlots(provider, svc.stakingProgramId);
      if (!slots.available) {
        blocked.push(svc);
        console.log(
          `  Service #${svc.serviceId}: BLOCKED — no staking slots available (${slots.used}/${slots.max})`,
        );
        continue;
      }

      const rewardsAvailable = await getRewardsAvailable(provider, svc.stakingProgramId);
      if (!rewardsAvailable) {
        console.log(
          `  Service #${svc.serviceId}: WARNING — no rewards available (will still attempt restake)`,
        );
      }

      ready.push(svc);
      console.log(`  Service #${svc.serviceId}: READY for restaking`);
    }

    if (ready.length === 0) {
      console.log('\n  No services are ready for restaking.');
      if (blocked.length > 0) {
        console.log(`  ${blocked.length} service(s) blocked (see above).`);
      }
      console.log('═══════════════════════════════════════════════════════════════');
      process.exit(1);
    }

    // Dry run — stop here
    if (dryRun) {
      console.log('');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('DRY RUN COMPLETE — No transactions executed');
      console.log('');
      console.log(`Would restake ${ready.length} service(s):`);
      for (const svc of ready) {
        console.log(
          `  - Service #${svc.serviceId} (${svc.stakingStateName} → STAKED)`,
        );
      }
      if (blocked.length > 0) {
        console.log(`\n${blocked.length} service(s) blocked:`);
        for (const svc of blocked) {
          const reason = !svc.canUnstake
            ? `min duration not elapsed (available ${svc.unstakeAvailableAt ? new Date(svc.unstakeAvailableAt * 1000).toISOString() : 'unknown'})`
            : 'no slots available';
          console.log(`  - Service #${svc.serviceId}: ${reason}`);
        }
      }
      console.log('\nRemove --dry-run to execute restaking');
      console.log('═══════════════════════════════════════════════════════════════');
      process.exit(0);
    }

    // Step 4: Restake via middleware
    console.log(`\nStep 4: Restaking ${ready.length} service(s) via middleware...`);

    const results: Array<{ serviceId: number; configId: string; success: boolean; finalState: string }> = [];

    for (const svc of ready) {
      console.log(`\n  Restaking Service #${svc.serviceId} (${svc.serviceConfigId})...`);
      console.log('  This calls deploy_service_onchain_from_safe → stake_service_on_chain_from_safe');

      try {
        const result = await wrapper.startService(svc.serviceConfigId);

        if (result.success) {
          console.log('  Middleware returned success');
        } else {
          console.log(`  Middleware returned error: ${result.error}`);
          console.log('  (This may be expected — local Docker deploy fails for Railway workers)');
          console.log('  Checking on-chain state...');
        }
      } catch (err: any) {
        console.log(`  Middleware call failed: ${err.message}`);
        console.log('  Checking on-chain state...');
      }

      // Verify on-chain state regardless of middleware response
      const { state: finalState } = await getServiceStakingInfo(
        provider, svc.serviceId, svc.stakingProgramId,
      );
      const finalStateName = STAKING_STATE_NAMES[finalState] || `UNKNOWN(${finalState})`;

      const success = finalState === 1;
      results.push({
        serviceId: svc.serviceId,
        configId: svc.serviceConfigId,
        success,
        finalState: finalStateName,
      });

      if (success) {
        console.log(`  Service #${svc.serviceId}: STAKED (restake successful)`);
      } else {
        console.log(`  Service #${svc.serviceId}: ${finalStateName} (restake may have failed)`);
      }
    }

    // Summary
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                        SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');

    const succeeded = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    for (const r of results) {
      const icon = r.success ? 'ok' : 'FAIL';
      console.log(`  [${icon}] Service #${r.serviceId}: ${r.finalState}`);
    }

    console.log('');
    console.log(`  ${succeeded.length} succeeded, ${failed.length} failed, ${blocked.length} blocked`);

    if (failed.length > 0) {
      console.log('');
      console.log('  Failed services may need manual intervention.');
      console.log('  Check: yarn wallet:unstake --service-id <id>');
      console.log('  Or use the olas-staking skill for guided restaking.');
    }

    console.log('═══════════════════════════════════════════════════════════════');

    if (failed.length > 0) {
      process.exit(1);
    }
  } finally {
    await wrapper.stopServer();
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
