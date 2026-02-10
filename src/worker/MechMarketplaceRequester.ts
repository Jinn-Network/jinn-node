/**
 * Mech Marketplace Requester
 * 
 * Implements Safe-based marketplace requests using the mech-client-ts Safe SDK.
 * Based on the proven pattern from scripts/submit-marketplace-request-165.ts.
 * 
 * JINN-209: Safe-based mech marketplace request/deliver flow
 */

import { ethers } from 'ethers';
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../logging/index.js';
import { pushMetadataToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';

const requestLogger = logger.child({ component: 'MECH-MARKETPLACE-REQUESTER' });

/**
 * Sleep helper for rate limiting
 */
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface MarketplaceRequestParams {
  // Service configuration
  serviceSafeAddress: string;
  agentEoaPrivateKey: string;
  mechContractAddress: string;
  mechMarketplaceAddress: string;

  // Request parameters
  prompt: string;
  requestPriceWei?: string; // Optional, defaults to mech's maxDeliveryRate

  // Optional extra attributes to include in IPFS payload (e.g. workstreamId, jobName)
  ipfsExtraAttributes?: Record<string, unknown>;

  // Network configuration
  rpcUrl: string;
  chainId?: number;
}

export interface MarketplaceRequestResult {
  success: boolean;
  transactionHash?: string;
  requestId?: string;
  gasUsed?: string;
  blockNumber?: number;
  error?: string;
}

// ABIs
const MECH_MARKETPLACE_ABI = [
  'function request(bytes memory requestData, uint256 maxDeliveryRate, bytes32 paymentType, address priorityMech, uint256 responseTimeout, bytes memory paymentData) external payable returns (bytes32 requestId)',
  'function mapRequestCounts(address requester) view returns (uint256)',
  'function minResponseTimeout() view returns (uint256)',
  'function maxResponseTimeout() view returns (uint256)',
];

const MECH_ABI = [
  'function paymentType() view returns (bytes32)',
  'function maxDeliveryRate() view returns (uint256)',
];

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
];

/**
 * Submit a marketplace request via Safe
 * 
 * Uses the same Safe transaction pattern as deliverViaSafe in mech-client-ts
 */
export async function submitMarketplaceRequest(
  params: MarketplaceRequestParams
): Promise<MarketplaceRequestResult> {
  const {
    serviceSafeAddress,
    agentEoaPrivateKey,
    mechContractAddress,
    mechMarketplaceAddress,
    prompt,
    requestPriceWei,
    rpcUrl,
  } = params;
  
  try {
    requestLogger.info({
      serviceSafeAddress,
      mechContractAddress,
      mechMarketplaceAddress,
      prompt: prompt.slice(0, 100),
    }, 'Submitting marketplace request via Safe');
    
    // 1. Setup provider and wallet
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const agentWallet = new ethers.Wallet(agentEoaPrivateKey, provider);
    
    requestLogger.debug({ agentAddress: agentWallet.address }, 'Agent wallet loaded');
    
    // 2. Check balances
    await sleep(200); // Rate limit: 5 req/s max
    const serviceSafeBalance = await provider.getBalance(serviceSafeAddress);
    requestLogger.debug({
      serviceSafeAddress,
      balance: ethers.formatEther(serviceSafeBalance),
    }, 'Service Safe balance');
    
    // 3. Upload prompt to IPFS via Autonolas registry
    requestLogger.info({ promptLength: prompt.length }, 'Uploading prompt to IPFS');
    const [digestHex, ipfsHash] = await pushMetadataToIpfs(prompt, 'openai-gpt-4', {
      requestTimestamp: Date.now(),
      mechAddress: mechContractAddress,
      ...params.ipfsExtraAttributes,
    });
    // digestHex already includes 0x prefix from pushMetadataToIpfs
    const requestData = digestHex;
    requestLogger.info({ 
      requestData, 
      ipfsHash,
      ipfsUrl: `https://gateway.autonolas.tech/ipfs/${ipfsHash}`
    }, 'Prompt uploaded to IPFS');
    
    // 4. Query mech for payment type and max delivery rate
    await sleep(200); // Rate limit: 5 req/s max
    const mech = new ethers.Contract(mechContractAddress, MECH_ABI, provider);
    const mechPaymentType = await mech.paymentType();
    await sleep(200); // Rate limit: 5 req/s max
    const mechMaxDeliveryRate = await mech.maxDeliveryRate();
    
    requestLogger.debug({
      mechPaymentType,
      mechMaxDeliveryRate: ethers.formatEther(mechMaxDeliveryRate),
    }, 'Mech parameters');
    
    // Use provided price or mech's max delivery rate
    const finalPrice = requestPriceWei ? BigInt(requestPriceWei) : mechMaxDeliveryRate;
    
    // Check if Safe has sufficient balance
    if (serviceSafeBalance < finalPrice) {
      return {
        success: false,
        error: `Insufficient balance in Safe. Available: ${ethers.formatEther(serviceSafeBalance)} ETH, Needed: ${ethers.formatEther(finalPrice)} ETH`,
      };
    }
    
    // 5. Query marketplace for timeout bounds
    await sleep(200); // Rate limit: 5 req/s max
    const marketplace = new ethers.Contract(mechMarketplaceAddress, MECH_MARKETPLACE_ABI, provider);
    const minTimeout = await marketplace.minResponseTimeout();
    await sleep(200); // Rate limit: 5 req/s max
    const maxTimeout = await marketplace.maxResponseTimeout();
    
    requestLogger.debug({
      minTimeout: Number(minTimeout),
      maxTimeout: Number(maxTimeout),
    }, 'Marketplace timeout bounds');
    
    // 6. Encode marketplace request call
    const marketplaceCallData = marketplace.interface.encodeFunctionData('request', [
      requestData,           // bytes (single request data)
      mechMaxDeliveryRate,   // uint256 (use mech's rate)
      mechPaymentType,       // bytes32
      mechContractAddress,   // address (priority mech)
      maxTimeout,            // uint256 (use maximum allowed)
      '0x',                  // bytes (payment data)
    ]);
    
    // 7. Build Safe transaction
    await sleep(200); // Rate limit: 5 req/s max
    const safe = new ethers.Contract(serviceSafeAddress, SAFE_ABI, agentWallet);
    const safeNonce = await safe.nonce();
    
    requestLogger.debug({ safeNonce: Number(safeNonce) }, 'Safe nonce');
    
    const txParams = {
      to: mechMarketplaceAddress,
      value: finalPrice,
      data: marketplaceCallData,
      operation: 0, // CALL
      safeTxGas: 0,
      baseGas: 0,
      gasPrice: 0,
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
      nonce: safeNonce,
    };
    
    // Get transaction hash to sign
    await sleep(200); // Rate limit: 5 req/s max
    const txHash = await safe.getTransactionHash(
      txParams.to,
      txParams.value,
      txParams.data,
      txParams.operation,
      txParams.safeTxGas,
      txParams.baseGas,
      txParams.gasPrice,
      txParams.gasToken,
      txParams.refundReceiver,
      txParams.nonce
    );
    
    requestLogger.debug({ txHash }, 'Transaction hash to sign');
    
    // 8. Sign transaction (eth_sign format for Safe)
    const signature = await agentWallet.signMessage(ethers.getBytes(txHash));
    
    // Adjust v for eth_sign format (Safe expects v + 4)
    const sigBytes = ethers.getBytes(signature);
    const r = ethers.hexlify(sigBytes.slice(0, 32));
    const s = ethers.hexlify(sigBytes.slice(32, 64));
    const v = sigBytes[64] + 4; // Add 4 for eth_sign marker
    
    const adjustedSignature = ethers.concat([r, s, new Uint8Array([v])]);
    
    requestLogger.debug({ signature: ethers.hexlify(adjustedSignature) }, 'Signature prepared');
    
    // 9. Execute Safe transaction
    await sleep(200); // Rate limit: 5 req/s max
    const tx = await safe.execTransaction(
      txParams.to,
      txParams.value,
      txParams.data,
      txParams.operation,
      txParams.safeTxGas,
      txParams.baseGas,
      txParams.gasPrice,
      txParams.gasToken,
      txParams.refundReceiver,
      adjustedSignature
    );
    
    requestLogger.info({ transactionHash: tx.hash }, 'Transaction sent, waiting for confirmation');
    
    // 10. Wait for confirmation
    const receipt = await tx.wait();
    
    if (!receipt || receipt.status !== 1) {
      return {
        success: false,
        error: 'Transaction failed',
        transactionHash: tx.hash,
      };
    }
    
    // 11. Verify request count increased
    await sleep(2000); // Wait for state update
    const newRequestCount = await marketplace.mapRequestCounts(serviceSafeAddress);
    
    requestLogger.info({
      transactionHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
      blockNumber: receipt.blockNumber,
      requestCount: Number(newRequestCount),
    }, 'Marketplace request submitted successfully');
    
    return {
      success: true,
      transactionHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
      blockNumber: receipt.blockNumber,
    };
    
  } catch (error) {
    requestLogger.error({
      error: error instanceof Error ? error.message : String(error),
      serviceSafeAddress,
    }, 'Failed to submit marketplace request');
    
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Load agent EOA private key from middleware .operate/keys directory
 */
export async function loadAgentPrivateKey(
  middlewarePath: string,
  agentEoaAddress: string
): Promise<string | null> {
  try {
    const keyPath = join(middlewarePath, '.operate', 'keys', agentEoaAddress);
    const keyContent = await fs.readFile(keyPath, 'utf-8');
    const keyData = JSON.parse(keyContent);
    const privateKey = keyData.private_key;
    
    if (!privateKey || typeof privateKey !== 'string') {
      requestLogger.error({
        agentEoaAddress,
        hasKey: !!privateKey,
        keyType: typeof privateKey,
      }, 'Private key not found or invalid format');
      return null;
    }
    
    return privateKey;
  } catch (error) {
    requestLogger.error({
      error: error instanceof Error ? error.message : String(error),
      agentEoaAddress,
    }, 'Failed to load agent private key');
    return null;
  }
}

