/**
 * stOLAS Service Bootstrap
 *
 * Alternative to SimplifiedServiceBootstrap that uses the stOLAS
 * ExternalStakingDistributor. Operators stake without providing OLAS —
 * LemonTree depositors fund the capital.
 *
 * Integrates with the existing .operate/ wallet hierarchy:
 *   - Master Safe (from .operate/wallets/ethereum.json) calls stake() via execTransaction
 *   - Master EOA (from .operate/wallets/ethereum.txt) signs the Safe transaction
 *   - A new agent EOA is generated for the agentInstance (becomes service Safe owner)
 *   - Agent key is stored in .operate/keys/<address> alongside existing keys
 *   - Service config is imported to .operate/services/sc-<uuid>/
 *
 * The Master Safe becomes the service owner in the staking contract, consistent
 * with services created through the standard middleware flow.
 *
 * Flow:
 *   1. Load Master EOA + Master Safe from .operate/
 *   2. Generate new agent EOA for this service
 *   3. Preflight: verify stOLAS proxy configured + staking slots available
 *   4. Route stake() through Master Safe → creates service + Safe on-chain
 *   5. Discover serviceId + Safe from chain
 *   6. Store agent key in .operate/keys/
 *   7. Import service config to .operate/services/
 */

import { promises as fsPromises } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import { logger } from '../../logging/index.js';
import { getMasterPrivateKey, getMasterSafe } from '../../env/operate-profile.js';
import { importServiceFromChain, type ImportServiceResult } from './ServiceImporter.js';
import { deployMechViaSafe, buildMechToConfigValue } from './StolasMechDeployer.js';
import { maybeDistributeFunds, type FundTransfer } from '../funding/FundDistributor.js';
import type { ServiceInfo } from '../ServiceConfigReader.js';

const stolasLogger = logger.child({ component: 'STOLAS-BOOTSTRAP' });

// ─── Contracts ──────────────────────────────────────────────────────────────────

const DISTRIBUTOR_PROXY = '0x40abf47B926181148000DbCC7c8DE76A3a61a66f';
const JINN_STAKING      = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';

const JINN_AGENT_ID = 43;

const DISTRIBUTOR_ABI = [
  'function mapStakingProxyConfigs(address) view returns (uint256)',
  'function stake(address stakingProxy, uint256 serviceId, uint256 agentId, bytes32 configHash, address agentInstance) external',
];

const STAKING_ABI = [
  'function getServiceIds() view returns (uint256[])',
  'function maxNumServices() view returns (uint256)',
];

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
];

// configHash = keccak256(abi.encode([43], [(1, 5000e18)]))
const CONFIG_HASH = (() => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    ['uint32[]', 'tuple(uint32,uint96)[]'],
    [[JINN_AGENT_ID], [[1, ethers.parseEther('5000')]]]
  );
  return ethers.keccak256(encoded);
})();

// ─── Interfaces ─────────────────────────────────────────────────────────────────

export interface StolasBootstrapConfig {
  rpcUrl: string;
  chain: string;
  operateBasePath: string;       // directory containing .operate/
  operatePassword: string;       // password for encrypting new agent key
}

export interface StolasBootstrapResult {
  success: boolean;
  serviceId?: number;
  serviceConfigId?: string;
  multisig?: string;
  masterSafeAddress?: string;
  masterEoaAddress?: string;
  agentInstanceAddress?: string;
  mechAddress?: string;
  mechDeployError?: string;      // non-fatal — service created but mech pending
  error?: string;
}

// ─── Preflight ──────────────────────────────────────────────────────────────────

/**
 * Verify stOLAS prerequisites before attempting stake():
 *   - setStakingProxyConfigs is set for Jinn staking
 *   - staking slots are available
 */
export async function stolasPreflightCheck(rpcUrl: string): Promise<{
  ok: boolean;
  slotsRemaining: number;
  error?: string;
}> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const dist = new ethers.Contract(DISTRIBUTOR_PROXY, DISTRIBUTOR_ABI, provider);
  const proxyConfig = await dist.mapStakingProxyConfigs(JINN_STAKING);
  if (proxyConfig === 0n) {
    return {
      ok: false,
      slotsRemaining: 0,
      error: 'stOLAS distributor not configured for Jinn staking. Contact LemonTree team.',
    };
  }

  const staking = new ethers.Contract(JINN_STAKING, STAKING_ABI, provider);
  const serviceIds = await staking.getServiceIds();
  const maxServices = await staking.maxNumServices();
  const slotsRemaining = Number(maxServices) - serviceIds.length;

  if (slotsRemaining <= 0) {
    return {
      ok: false,
      slotsRemaining: 0,
      error: `All ${maxServices} staking slots are occupied. No slots available.`,
    };
  }

  return { ok: true, slotsRemaining };
}

// ─── Agent Key Storage ──────────────────────────────────────────────────────────

/**
 * Store a new agent key in .operate/keys/<address> in the same format
 * as existing keys (encrypted keystore V3 JSON).
 */
async function storeAgentKey(
  operateBasePath: string,
  agentWallet: ethers.HDNodeWallet,
  password: string,
): Promise<string> {
  const keysDir = join(operateBasePath, '.operate', 'keys');
  await fsPromises.mkdir(keysDir, { recursive: true });

  // Encrypt the private key as keystore V3 (matching existing key format)
  const keystoreJson = await agentWallet.encrypt(password);
  const keystore = JSON.parse(keystoreJson);

  // Store in the same format as existing .operate/keys/ files
  const keyEntry = {
    ledger: 'ethereum',
    address: agentWallet.address,
    private_key: JSON.stringify({
      address: keystore.address,
      crypto: keystore.crypto,
      id: keystore.id,
      version: keystore.version,
    }),
  };

  const keyPath = join(keysDir, agentWallet.address);
  await fsPromises.writeFile(keyPath, JSON.stringify(keyEntry, null, 2));

  stolasLogger.info({ address: agentWallet.address, keyPath }, 'Agent key stored');
  return keyPath;
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────────

/**
 * Execute the stOLAS bootstrap flow:
 *   1. Load Master EOA + Master Safe from .operate/
 *   2. Generate new agent EOA
 *   3. Preflight checks
 *   4. Route stake() through Master Safe (Master EOA signs)
 *   5. Discover new serviceId
 *   6. Store agent key + import service config to .operate/
 *
 * The Master Safe becomes the service owner in the staking contract,
 * consistent with services 378/379 created through the middleware.
 */
export async function stolasBootstrap(
  config: StolasBootstrapConfig
): Promise<StolasBootstrapResult> {
  const { rpcUrl, chain, operateBasePath, operatePassword } = config;

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // ── 1. Load Master EOA + Master Safe ──────────────────────────────────────

  const masterPrivateKey = getMasterPrivateKey();
  if (!masterPrivateKey) {
    return {
      success: false,
      error: 'Could not decrypt Master EOA from .operate/wallets/ethereum.txt. Check OPERATE_PASSWORD.',
    };
  }

  const masterWallet = new ethers.Wallet(masterPrivateKey, provider);

  const masterSafeAddress = getMasterSafe(chain);
  if (!masterSafeAddress) {
    return {
      success: false,
      error: `No Master Safe found for chain "${chain}" in .operate/wallets/ethereum.json.`,
    };
  }

  stolasLogger.info({
    masterEoa: masterWallet.address,
    masterSafe: masterSafeAddress,
  }, 'Master EOA + Safe loaded');

  // Check Master EOA has ETH for gas (it signs and submits the Safe tx)
  // Base L2 gas is cheap (~0.00003 ETH for 2.5M gas), so 0.001 ETH is plenty
  const balance = await provider.getBalance(masterWallet.address);
  const minBalance = ethers.parseEther('0.001');
  if (balance < minBalance) {
    return {
      success: false,
      error: `Master EOA ${masterWallet.address} has insufficient ETH: ${ethers.formatEther(balance)} ETH. Need at least 0.005 ETH for gas.`,
    };
  }

  // ── 2. Generate new agent EOA ─────────────────────────────────────────────

  const agentWallet = ethers.Wallet.createRandom();
  stolasLogger.info({
    agentInstance: agentWallet.address,
    masterSafe: masterSafeAddress,
  }, 'Generated new agent EOA for service');

  // ── 3. Preflight ──────────────────────────────────────────────────────────

  const preflight = await stolasPreflightCheck(rpcUrl);
  if (!preflight.ok) {
    return { success: false, error: preflight.error };
  }

  stolasLogger.info({ slotsRemaining: preflight.slotsRemaining }, 'Preflight passed');

  // ── 4. Route stake() through Master Safe ──────────────────────────────────

  const staking = new ethers.Contract(JINN_STAKING, STAKING_ABI, provider);
  const serviceIdsBefore: bigint[] = await staking.getServiceIds();

  // Encode the stake() calldata
  const distIface = new ethers.Interface(DISTRIBUTOR_ABI);
  const stakeCallData = distIface.encodeFunctionData('stake', [
    JINN_STAKING,
    0,                              // serviceId = 0 → create new
    JINN_AGENT_ID,
    CONFIG_HASH,
    agentWallet.address,            // agentInstance → becomes Safe owner
  ]);

  stolasLogger.info({
    distributor: DISTRIBUTOR_PROXY,
    stakingProxy: JINN_STAKING,
    agentId: JINN_AGENT_ID,
    configHash: CONFIG_HASH,
    masterSafe: masterSafeAddress,
    agentInstance: agentWallet.address,
  }, 'Routing stake() through Master Safe');

  // Build, sign, and execute Safe transaction
  const safe = new ethers.Contract(masterSafeAddress, SAFE_ABI, masterWallet);
  const safeNonce = await safe.nonce();

  const txHash = await safe.getTransactionHash(
    DISTRIBUTOR_PROXY,              // to
    0,                              // value (no ETH sent)
    stakeCallData,                  // data
    0,                              // operation (CALL)
    0,                              // safeTxGas
    0,                              // baseGas
    0,                              // gasPrice
    ethers.ZeroAddress,             // gasToken
    ethers.ZeroAddress,             // refundReceiver
    safeNonce,
  );

  // Sign with eth_sign format (v + 4 for Safe)
  const signature = await masterWallet.signMessage(ethers.getBytes(txHash));
  const sigBytes = ethers.getBytes(signature);
  const r = ethers.hexlify(sigBytes.slice(0, 32));
  const s = ethers.hexlify(sigBytes.slice(32, 64));
  const v = sigBytes[64] + 4;
  const adjustedSignature = ethers.concat([r, s, new Uint8Array([v])]);

  const tx = await safe.execTransaction(
    DISTRIBUTOR_PROXY,
    0,
    stakeCallData,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    adjustedSignature,
    { gasLimit: 2_500_000 }
  );

  const receipt = await tx.wait();

  if (!receipt || receipt.status !== 1) {
    return {
      success: false,
      error: `Safe execTransaction failed. txHash: ${tx.hash}`,
    };
  }

  stolasLogger.info({
    txHash: receipt.hash,
    gasUsed: receipt.gasUsed.toString(),
    logs: receipt.logs.length,
  }, 'stake() via Master Safe confirmed');

  // ── 5. Discover new serviceId ─────────────────────────────────────────────

  const serviceIdsAfter: bigint[] = await staking.getServiceIds();
  const newServiceIds = serviceIdsAfter.filter(
    id => !serviceIdsBefore.some(old => old === id)
  );

  if (newServiceIds.length === 0) {
    return {
      success: false,
      error: 'stake() succeeded but no new service ID found in getServiceIds()',
    };
  }

  const serviceId = Number(newServiceIds[0]);
  stolasLogger.info({ serviceId }, 'New service discovered');

  // ── 6. Store agent key in .operate/keys/ ──────────────────────────────────

  try {
    await storeAgentKey(operateBasePath, agentWallet, operatePassword);
  } catch (err: any) {
    return {
      success: false,
      serviceId,
      error: `Service created (ID ${serviceId}) but agent key storage failed: ${err.message}`,
    };
  }

  // ── 7. Import service config to .operate/services/ ────────────────────────

  let imported: ImportServiceResult;
  try {
    imported = await importServiceFromChain({
      serviceId,
      agentInstanceAddress: agentWallet.address,
      agentPrivateKey: agentWallet.privateKey,
      rpcUrl,
      chain,
      operateBasePath,
      stakingContractAddress: JINN_STAKING,
      agentId: JINN_AGENT_ID,
    });
  } catch (err: any) {
    return {
      success: false,
      serviceId,
      error: `Service created (ID ${serviceId}) but config import failed: ${err.message}`,
    };
  }

  stolasLogger.info({
    serviceId,
    serviceConfigId: imported.serviceConfigId,
    multisig: imported.multisig,
    masterSafe: masterSafeAddress,
    agentInstance: agentWallet.address,
  }, 'Service created and imported, proceeding to mech deployment');

  // ── 8. Check Master Safe funding ──────────────────────────────────────

  const minMasterSafeBalance = ethers.parseEther('0.007'); // agent target (0.005) + safe target (~0.0016) + buffer
  const masterSafeBalance = await provider.getBalance(masterSafeAddress);

  if (masterSafeBalance < minMasterSafeBalance) {
    stolasLogger.warn({
      masterSafe: masterSafeAddress,
      balance: ethers.formatEther(masterSafeBalance),
      required: ethers.formatEther(minMasterSafeBalance),
    }, 'Master Safe has insufficient ETH for agent funding + mech deployment');

    return {
      success: true,
      serviceId,
      serviceConfigId: imported.serviceConfigId,
      multisig: imported.multisig,
      masterSafeAddress,
      masterEoaAddress: masterWallet.address,
      agentInstanceAddress: agentWallet.address,
      mechDeployError: `Master Safe needs ETH for mech deployment. Send >= 0.01 ETH to ${masterSafeAddress} and rerun with: npx tsx scripts/deploy-mech.ts --service-config-id=${imported.serviceConfigId}`,
    };
  }

  // ── 9. Fund agent EOA via Master Safe (FundDistributor) ───────────────

  stolasLogger.info({ masterSafe: masterSafeAddress, agentEoa: agentWallet.address }, 'Funding agent EOA from Master Safe');

  const serviceInfoForFunding: ServiceInfo = {
    serviceConfigId: imported.serviceConfigId,
    serviceName: `jinn-stolas-${serviceId}`,
    serviceSafeAddress: imported.multisig,
    agentEoaAddress: agentWallet.address,
    chain,
    serviceId,
  };

  const fundResult = await maybeDistributeFunds([serviceInfoForFunding], rpcUrl);

  if (fundResult.error) {
    stolasLogger.warn({ error: fundResult.error }, 'Fund distribution warning (continuing)');
  }

  if (fundResult.funded.length > 0) {
    stolasLogger.info({
      funded: fundResult.funded.map((t: FundTransfer) => ({ to: t.to, eth: ethers.formatEther(t.amountWei) })),
      txHash: fundResult.txHash,
    }, 'Agent EOA funded from Master Safe');
  }

  // ── 10. Deploy mech via Service Safe ──────────────────────────────────

  stolasLogger.info({ serviceId, serviceSafe: imported.multisig }, 'Deploying mech contract via service Safe');

  const mechResult = await deployMechViaSafe({
    rpcUrl,
    chain,
    serviceId,
    serviceSafeAddress: imported.multisig,
    agentPrivateKey: agentWallet.privateKey,
  });

  if (!mechResult.success) {
    stolasLogger.error({ error: mechResult.error }, 'Mech deployment failed');
    return {
      success: true,
      serviceId,
      serviceConfigId: imported.serviceConfigId,
      multisig: imported.multisig,
      masterSafeAddress,
      masterEoaAddress: masterWallet.address,
      agentInstanceAddress: agentWallet.address,
      mechDeployError: `Service created but mech deployment failed: ${mechResult.error}. Rerun with: npx tsx scripts/deploy-mech.ts --service-config-id=${imported.serviceConfigId}`,
    };
  }

  // ── 11. Update config with mech address ───────────────────────────────

  const mechToConfigValue = buildMechToConfigValue(mechResult.mechAddress!);
  const configPath = imported.configPath;

  try {
    const raw = await fsPromises.readFile(configPath, 'utf-8');
    const configData = JSON.parse(raw);
    configData.env_variables.MECH_TO_CONFIG.value = mechToConfigValue;
    await fsPromises.writeFile(configPath, JSON.stringify(configData, null, 2));
    stolasLogger.info({ mechAddress: mechResult.mechAddress, configPath }, 'Config updated with mech address');
  } catch (err: any) {
    stolasLogger.error({ error: err.message }, 'Failed to update config with mech address');
  }

  stolasLogger.info({
    serviceId,
    serviceConfigId: imported.serviceConfigId,
    multisig: imported.multisig,
    mechAddress: mechResult.mechAddress,
    masterSafe: masterSafeAddress,
    agentInstance: agentWallet.address,
  }, 'stOLAS bootstrap complete (with mech)');

  return {
    success: true,
    serviceId,
    serviceConfigId: imported.serviceConfigId,
    multisig: imported.multisig,
    masterSafeAddress,
    masterEoaAddress: masterWallet.address,
    agentInstanceAddress: agentWallet.address,
    mechAddress: mechResult.mechAddress,
  };
}
