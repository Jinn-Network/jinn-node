/**
 * stOLAS Mech Deployer
 *
 * Deploys a mech contract via the service Safe by calling MechMarketplace.create().
 * The agent EOA (service Safe owner) signs + submits the Safe execTransaction.
 *
 * Same Safe tx pattern as MechMarketplaceRequester.ts — agent EOA is both signer
 * and submitter (pays gas).
 *
 * MechMarketplace.create(serviceId, mechFactory, payload)
 *   → emits CreateMech(address mech, uint256 serviceId, address mechFactory)
 *   → mech address parsed from receipt logs
 */

import { ethers } from 'ethers';
import { logger } from '../../logging/index.js';
import { DEFAULT_MECH_DELIVERY_RATE } from '../config/MechConfig.js';

const mechLogger = logger.child({ component: 'STOLAS-MECH-DEPLOYER' });

// Keep deployer constants local so this module can compile independently of
// worker/contracts/MechMarketplace.ts in minimal deployment contexts.
const MECH_MARKETPLACE_ABI = [
  {
    inputs: [
      { internalType: 'uint256', name: 'serviceId', type: 'uint256' },
      { internalType: 'address', name: 'mechFactory', type: 'address' },
      { internalType: 'bytes', name: 'payload', type: 'bytes' },
    ],
    name: 'create',
    outputs: [{ internalType: 'address', name: 'mech', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'mech', type: 'address' },
      { indexed: true, internalType: 'uint256', name: 'serviceId', type: 'uint256' },
      { indexed: true, internalType: 'address', name: 'mechFactory', type: 'address' },
    ],
    name: 'CreateMech',
    type: 'event',
  },
] as const;

const MECH_FACTORY_ADDRESSES: Record<string, Record<string, Record<string, string>>> = {
  gnosis: {
    '0xad380C51cd5297FbAE43494dD5D407A2a3260b58': {
      Native: '0x42f43be9E5E50df51b86C5c6427223ff565f40C6',
      Token: '0x161b862568E900Dd9d8c64364F3B83a43792e50f',
      Nevermined: '0xCB26B91B0E21ADb04FFB6e5f428f41858c64936A',
    },
    '0x735FAAb1c4Ec41128c367AFb5c3baC73509f70bB': {
      Native: '0x8b299c20F87e3fcBfF0e1B86dC0acC06AB6993EF',
      Token: '0x31ffDC795FDF36696B8eDF7583A3D115995a45FA',
      Nevermined: '0x65fd74C29463afe08c879a3020323DD7DF02DA57',
    },
  },
  base: {
    '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020': {
      Native: '0x2E008211f34b25A7d7c102403c6C2C3B665a1abe',
      Token: '0x97371B1C0cDA1D04dFc43DFb50a04645b7Bc9BEe',
      Nevermined: '0x847bBE8b474e0820215f818858e23F5f5591855A',
    },
  },
};

const DEFAULT_MECH_MARKETPLACE_ADDRESSES: Record<string, string> = {
  gnosis: '0x735FAAb1c4Ec41128c367AFb5c3baC73509f70bB',
  base: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020',
};

// Safe ABI — same subset as StolasServiceBootstrap.ts and MechMarketplaceRequester.ts
const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
];

export interface MechDeployConfig {
  rpcUrl: string;
  chain: string;
  serviceId: number;
  serviceSafeAddress: string;
  agentPrivateKey: string;        // plaintext hex — agent EOA is Safe owner
  mechType?: 'Native' | 'Token';
  requestPrice?: string;          // wei — defaults to DEFAULT_MECH_DELIVERY_RATE (99)
}

export interface MechDeployResult {
  success: boolean;
  mechAddress?: string;
  txHash?: string;
  error?: string;
}

/**
 * Deploy a mech contract by routing MechMarketplace.create() through the service Safe.
 *
 * The agent EOA must:
 *   - Be a signer on the service Safe (1-of-1 owner)
 *   - Have ETH for gas (minimum 0.001 ETH)
 *
 * Flow:
 *   1. Verify agent EOA has ETH for gas
 *   2. Encode MechMarketplace.create(serviceId, mechFactory, payload)
 *   3. Build Safe execTransaction (agent EOA signs + submits)
 *   4. Parse CreateMech event → mech address
 */
export async function deployMechViaSafe(config: MechDeployConfig): Promise<MechDeployResult> {
  const {
    rpcUrl,
    chain,
    serviceId,
    serviceSafeAddress,
    agentPrivateKey,
    mechType = 'Native',
    requestPrice = DEFAULT_MECH_DELIVERY_RATE,
  } = config;

  const chainLower = chain.toLowerCase();
  const marketplaceAddress = DEFAULT_MECH_MARKETPLACE_ADDRESSES[chainLower];
  if (!marketplaceAddress) {
    return { success: false, error: `No MechMarketplace address for chain: ${chain}` };
  }

  const chainFactories = MECH_FACTORY_ADDRESSES[chainLower];
  const factories = chainFactories?.[marketplaceAddress];
  const mechFactory = factories?.[mechType];
  if (!mechFactory) {
    return { success: false, error: `No ${mechType} MechFactory for ${chain} marketplace ${marketplaceAddress}` };
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const agentWallet = new ethers.Wallet(agentPrivateKey, provider);

    // 1. Verify agent EOA has ETH for gas
    const agentBalance = await provider.getBalance(agentWallet.address);
    const minGas = ethers.parseEther('0.001');
    if (agentBalance < minGas) {
      return {
        success: false,
        error: `Agent EOA ${agentWallet.address} has insufficient ETH for gas: ${ethers.formatEther(agentBalance)} ETH (need >= 0.001 ETH)`,
      };
    }

    mechLogger.info({
      serviceId,
      serviceSafe: serviceSafeAddress,
      agentEoa: agentWallet.address,
      agentBalance: ethers.formatEther(agentBalance),
      mechType,
      mechFactory,
      requestPrice,
    }, 'Deploying mech via service Safe');

    // 2. Encode MechMarketplace.create() calldata
    const marketplaceIface = new ethers.Interface(MECH_MARKETPLACE_ABI);
    // Payload is ABI-encoded uint256 (request price) — passed through to factory's createMech()
    const payload = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [requestPrice]);
    const createCallData = marketplaceIface.encodeFunctionData('create', [
      serviceId,
      mechFactory,
      payload,
    ]);

    // 2b. Pre-flight: simulate the inner call to catch contract-level errors early
    try {
      const simResult = await provider.call({
        from: serviceSafeAddress,
        to: marketplaceAddress,
        data: createCallData,
      });
      const decodedAddr = ethers.AbiCoder.defaultAbiCoder().decode(['address'], simResult);
      mechLogger.info({ simulatedMech: decodedAddr[0] }, 'Pre-flight simulation succeeded');
    } catch (simErr) {
      const simMsg = simErr instanceof Error ? simErr.message : String(simErr);
      return {
        success: false,
        error: `Pre-flight simulation failed (inner call would revert): ${simMsg}`,
      };
    }

    // 3. Build, sign, and execute Safe transaction
    const safe = new ethers.Contract(serviceSafeAddress, SAFE_ABI, agentWallet);
    const safeNonce = await safe.nonce();

    mechLogger.debug({ safeNonce: Number(safeNonce) }, 'Service Safe nonce');

    const txHash = await safe.getTransactionHash(
      marketplaceAddress,           // to
      0,                            // value (no ETH sent)
      createCallData,               // data
      0,                            // operation (CALL)
      0,                            // safeTxGas
      0,                            // baseGas
      0,                            // gasPrice
      ethers.ZeroAddress,           // gasToken
      ethers.ZeroAddress,           // refundReceiver
      safeNonce,
    );

    // Sign with eth_sign format (v + 4 for Safe)
    const signature = await agentWallet.signMessage(ethers.getBytes(txHash));
    const sigBytes = ethers.getBytes(signature);
    const r = ethers.hexlify(sigBytes.slice(0, 32));
    const s = ethers.hexlify(sigBytes.slice(32, 64));
    const v = sigBytes[64] + 4;
    const adjustedSignature = ethers.concat([r, s, new Uint8Array([v])]);

    const tx = await safe.execTransaction(
      marketplaceAddress,
      0,
      createCallData,
      0,
      0,
      0,
      0,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      adjustedSignature,
      { gasLimit: 5_000_000 },
    );

    mechLogger.info({ txHash: tx.hash }, 'Safe execTransaction submitted, waiting for confirmation');
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      return {
        success: false,
        txHash: tx.hash,
        error: `Safe execTransaction reverted. txHash: ${tx.hash}`,
      };
    }

    // 4. Parse CreateMech event from receipt
    const mechAddress = parseMechAddressFromReceipt(receipt, serviceId);
    if (!mechAddress) {
      return {
        success: false,
        txHash: receipt.hash,
        error: 'Transaction succeeded but CreateMech event not found in logs',
      };
    }

    mechLogger.info({
      mechAddress,
      serviceId,
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
    }, 'Mech deployed successfully via service Safe');

    return {
      success: true,
      mechAddress,
      txHash: receipt.hash,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    mechLogger.error({ error: msg, serviceId }, 'Mech deployment failed');
    return { success: false, error: msg };
  }
}

/**
 * Parse mech address from CreateMech event in transaction receipt.
 * Same logic as MechMarketplace.ts:296-324.
 */
function parseMechAddressFromReceipt(receipt: ethers.TransactionReceipt, expectedServiceId: number): string | null {
  const iface = new ethers.Interface(MECH_MARKETPLACE_ABI);

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });

      if (parsed && parsed.name === 'CreateMech') {
        const mechAddress = parsed.args.mech;
        const serviceId = Number(parsed.args.serviceId);

        if (serviceId === expectedServiceId) {
          mechLogger.info({ mechAddress, serviceId }, 'Parsed CreateMech event');
          return mechAddress;
        }
      }
    } catch {
      // Not our event, continue
    }
  }

  return null;
}

/**
 * Build the MECH_TO_CONFIG JSON value for a deployed mech address.
 * Matches the format used by services 378/379.
 */
export function buildMechToConfigValue(mechAddress: string): string {
  const config: Record<string, { use_dynamic_pricing: boolean; is_marketplace_mech: boolean }> = {
    [mechAddress]: {
      use_dynamic_pricing: false,
      is_marketplace_mech: true,
    },
  };
  return JSON.stringify(config);
}
