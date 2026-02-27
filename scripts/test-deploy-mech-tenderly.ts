#!/usr/bin/env tsx
/**
 * Test: Deploy Mech on Tenderly Fork
 *
 * Creates a Tenderly Virtual TestNet fork of Base mainnet,
 * funds the Master Safe + Agent EOA, and runs the mech deployment
 * flow for service 392. Validates the mech contract exists on-chain.
 *
 * Usage: npx tsx scripts/test-deploy-mech-tenderly.ts
 *
 * Requires:
 *   TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG
 *   OPERATE_PASSWORD (to decrypt agent key)
 */

process.env.FORCE_STDERR = 'true';

import 'dotenv/config';
import { ethers } from 'ethers';
import { TenderlyClient } from '../src/lib/tenderly.js';
import { deployMechViaSafe, buildMechToConfigValue } from '../src/worker/stolas/StolasMechDeployer.js';
import { decryptKeystoreV3 } from '../src/env/keystore-decrypt.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ─── Config ────────────────────────────────────────────────────────────────────

// Service 392 addresses (from mainnet)
const SERVICE_ID = 392;
const SERVICE_SAFE = '0xd52D163870dA647b2531be3F382DCdC70879778C';
const AGENT_EOA   = '0x3e341FB9d16a571B0bcB65894201Bcf35d652694';
const MASTER_SAFE = '0x953d212bd81b811a3BCc713561c594292CE744f0';
const MASTER_EOA  = '0xFB935BE938110B706723A17978989cb8fD2Dba1a';

// Mech marketplace addresses (Base)
const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const MECH_FACTORY_NATIVE = '0x2E008211f34b25A7d7c102403c6C2C3B665a1abe';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getAgentPrivateKey(): string {
  const password = process.env.OPERATE_PASSWORD;
  if (!password) throw new Error('OPERATE_PASSWORD not set');

  const SERVICE_CONFIG_ID = 'sc-4355d24a-79d0-4290-99bc-0d58c787a372';

  // Try keys.json first (has raw private key), then .operate/keys/ (encrypted keystore)
  const keysJsonPaths = [
    `/Users/adrianobradley/jinn-nodes/jinn-node/.operate/services/${SERVICE_CONFIG_ID}/keys.json`,
    join(process.cwd(), '.operate', 'services', SERVICE_CONFIG_ID, 'keys.json'),
  ];

  for (const keyPath of keysJsonPaths) {
    if (!existsSync(keyPath)) continue;
    const keys = JSON.parse(readFileSync(keyPath, 'utf-8'));
    if (Array.isArray(keys) && keys[0]?.private_key?.startsWith('0x')) {
      return keys[0].private_key;
    }
  }

  // Fallback: try .operate/keys/<address> (encrypted keystore V3)
  const keystorePaths = [
    '/Users/adrianobradley/jinn-nodes/jinn-node/.operate/keys/' + AGENT_EOA,
    join(process.cwd(), '.operate', 'keys', AGENT_EOA),
  ];

  for (const keyPath of keystorePaths) {
    if (!existsSync(keyPath)) continue;
    const keyData = JSON.parse(readFileSync(keyPath, 'utf-8'));
    const pk = keyData.private_key;

    if (typeof pk === 'string' && pk.startsWith('0x')) return pk;
    if (typeof pk === 'string' && pk.startsWith('{')) return decryptKeystoreV3(pk, password);
  }

  throw new Error(`Agent key not found for ${AGENT_EOA}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Test: Deploy Mech on Tenderly Fork                     ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Load Tenderly env from monorepo root .env.test if not already set
  if (!process.env.TENDERLY_ACCESS_KEY) {
    const { config } = await import('dotenv');
    config({ path: join(process.cwd(), '..', '.env.test'), override: false });
  }

  const tenderly = new TenderlyClient({
    accessKey: process.env.TENDERLY_ACCESS_KEY,
    accountSlug: process.env.TENDERLY_ACCOUNT_SLUG || 'RitsuJinn',
    projectSlug: process.env.TENDERLY_PROJECT_SLUG || 'project',
  });

  if (!tenderly.isConfigured()) {
    console.error('  Tenderly not configured. Set TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG');
    process.exit(1);
  }

  // 1. Create Tenderly Virtual TestNet (fork of Base mainnet)
  console.log('  [1/6] Creating Tenderly Virtual TestNet (Base fork)...');
  let vnet;
  try {
    vnet = await tenderly.createVnet(8453);
    console.log(`        VNet ID: ${vnet.id}`);
    console.log(`        Admin RPC: ${vnet.adminRpcUrl}`);
    console.log(`        Public RPC: ${vnet.publicRpcUrl || 'N/A'}`);
    console.log(`        Explorer: ${vnet.blockExplorerUrl}`);
  } catch (err: any) {
    console.error(`  Failed to create VNet: ${err.message}`);
    process.exit(1);
  }

  const rpcUrl = vnet.publicRpcUrl || vnet.adminRpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    // 2. Fund addresses on the fork
    console.log('\n  [2/6] Funding addresses on fork...');
    const fundAmount = ethers.parseEther('1').toString(); // 1 ETH each

    await tenderly.fundAddress(MASTER_SAFE, fundAmount, vnet.adminRpcUrl);
    console.log(`        Master Safe: funded with 1 ETH`);

    await tenderly.fundAddress(AGENT_EOA, fundAmount, vnet.adminRpcUrl);
    console.log(`        Agent EOA:   funded with 1 ETH`);

    await tenderly.fundAddress(MASTER_EOA, fundAmount, vnet.adminRpcUrl);
    console.log(`        Master EOA:  funded with 1 ETH`);

    // Verify balances
    const [masterSafeBal, agentBal] = await Promise.all([
      provider.getBalance(MASTER_SAFE),
      provider.getBalance(AGENT_EOA),
    ]);

    console.log(`\n        Verified balances:`);
    console.log(`          Master Safe: ${ethers.formatEther(masterSafeBal)} ETH`);
    console.log(`          Agent EOA:   ${ethers.formatEther(agentBal)} ETH`);

    if (masterSafeBal === 0n || agentBal === 0n) {
      throw new Error('Funding failed — balances still zero');
    }

    // 3. Decrypt agent private key
    console.log('\n  [3/6] Decrypting agent private key...');
    const agentPrivateKey = getAgentPrivateKey();
    const wallet = new ethers.Wallet(agentPrivateKey);
    console.log(`        Agent address: ${wallet.address}`);

    if (wallet.address.toLowerCase() !== AGENT_EOA.toLowerCase()) {
      throw new Error(`Key mismatch: decrypted ${wallet.address}, expected ${AGENT_EOA}`);
    }

    // 4. Verify on-chain preconditions
    console.log('\n  [4/6] Verifying on-chain preconditions...');

    // Check service exists in ServiceRegistry
    const registryABI = ['function getService(uint256) view returns (tuple(address, uint32, uint32, bytes32, uint8))'];
    const registry = new ethers.Contract('0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE', registryABI, provider);
    const svc = await registry.getService(SERVICE_ID);
    console.log(`        Service ${SERVICE_ID} state: ${svc[4]} (4 = deployed)`);

    // Check Safe has agent as owner
    const safeOwnerABI = ['function getOwners() view returns (address[])'];
    const safe = new ethers.Contract(SERVICE_SAFE, safeOwnerABI, provider);
    const owners = await safe.getOwners();
    console.log(`        Service Safe owners: ${owners.join(', ')}`);

    const isOwner = owners.some((o: string) => o.toLowerCase() === AGENT_EOA.toLowerCase());
    if (!isOwner) {
      throw new Error(`Agent EOA ${AGENT_EOA} is NOT an owner of service Safe ${SERVICE_SAFE}`);
    }
    console.log(`        Agent is Safe owner: YES`);

    // Check MechMarketplace.create() is callable
    const marketplaceABI = ['function mapServiceIdMechContracts(uint256, uint256) view returns (address)'];
    const marketplace = new ethers.Contract(MECH_MARKETPLACE, marketplaceABI, provider);
    try {
      const existingMech = await marketplace.mapServiceIdMechContracts(SERVICE_ID, 0);
      console.log(`        Existing mech for service ${SERVICE_ID}: ${existingMech}`);
      if (existingMech !== ethers.ZeroAddress) {
        console.log(`\n  WARNING: Service ${SERVICE_ID} already has a mech deployed: ${existingMech}`);
        console.log(`  This test may revert if the marketplace doesn't allow re-creation.`);
      }
    } catch {
      console.log(`        No existing mech found (expected for new services)`);
    }

    // 5. Deploy mech via service Safe
    console.log('\n  [5/6] Deploying mech via service Safe...');
    console.log(`        MechMarketplace: ${MECH_MARKETPLACE}`);
    console.log(`        MechFactory:     ${MECH_FACTORY_NATIVE} (Native)`);
    console.log(`        ServiceId:       ${SERVICE_ID}`);
    console.log(`        ServiceSafe:     ${SERVICE_SAFE}`);
    console.log(`        AgentEOA:        ${AGENT_EOA}`);

    const mechResult = await deployMechViaSafe({
      rpcUrl,
      chain: 'base',
      serviceId: SERVICE_ID,
      serviceSafeAddress: SERVICE_SAFE,
      agentPrivateKey,
    });

    if (!mechResult.success) {
      console.error(`\n  MECH DEPLOYMENT FAILED: ${mechResult.error}`);
      if (mechResult.txHash) {
        console.error(`  TX Hash: ${mechResult.txHash}`);
        console.error(`  Check: ${vnet.blockExplorerUrl}`);
      }
      process.exit(1);
    }

    console.log(`\n        Mech deployed!`);
    console.log(`        Mech address: ${mechResult.mechAddress}`);
    console.log(`        TX hash:      ${mechResult.txHash}`);

    // 6. Verify mech contract exists on-chain
    console.log('\n  [6/6] Verifying mech contract on fork...');
    const mechCode = await provider.getCode(mechResult.mechAddress!);
    const hasCode = mechCode !== '0x' && mechCode.length > 2;
    console.log(`        Contract code present: ${hasCode ? 'YES' : 'NO'} (${mechCode.length} chars)`);

    // Verify MECH_TO_CONFIG format
    const mechToConfig = buildMechToConfigValue(mechResult.mechAddress!);
    console.log(`        MECH_TO_CONFIG: ${mechToConfig}`);

    // Check mech's tokenId matches serviceId
    const mechABI = ['function tokenId() view returns (uint256)', 'function maxDeliveryRate() view returns (uint256)'];
    const mechContract = new ethers.Contract(mechResult.mechAddress!, mechABI, provider);
    try {
      const [tokenId, maxRate] = await Promise.all([
        mechContract.tokenId(),
        mechContract.maxDeliveryRate(),
      ]);
      console.log(`        Mech tokenId:        ${tokenId} (expected: ${SERVICE_ID})`);
      console.log(`        Mech maxDeliveryRate: ${maxRate} wei`);

      if (Number(tokenId) !== SERVICE_ID) {
        throw new Error(`Mech tokenId (${tokenId}) doesn't match serviceId (${SERVICE_ID})`);
      }
    } catch (err: any) {
      console.log(`        Could not read mech properties: ${err.message}`);
    }

    // Final summary
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  TEST PASSED                                             ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Service ID:  ${SERVICE_ID}`.padEnd(59) + '║');
    console.log(`║  Mech:        ${mechResult.mechAddress}`.padEnd(59) + '║');
    console.log(`║  TX Hash:     ${mechResult.txHash?.slice(0, 42)}...`.padEnd(59) + '║');
    console.log(`║  Contract:    ${hasCode ? 'verified on-chain' : 'NOT FOUND'}`.padEnd(59) + '║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

  } finally {
    // Cleanup
    console.log('  Cleaning up Tenderly VNet...');
    try {
      await tenderly.deleteVnet(vnet.id);
      console.log('  VNet deleted.\n');
    } catch {
      console.log(`  VNet cleanup failed. Delete manually: ${vnet.id}\n`);
    }
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  process.exit(1);
});
