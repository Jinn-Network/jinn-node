/**
 * Safe-Based Marketplace Dispatch
 *
 * Shared utility for dispatching marketplace requests through the Gnosis Safe
 * (execTransaction) instead of directly from the agent EOA. This ensures
 * `mapRequestCounts[multisig]` increments so real job dispatches count toward
 * staking targets.
 *
 * The activity checker requires `diffRequestsCounts <= diffNonces` — each
 * request() call must use its own Safe execTransaction, so we iterate
 * individual request() calls rather than using requestBatch().
 *
 * Currently scoped to native payment mechs only.
 */

import { ethers } from 'ethers';
import { pushJsonToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';
import { logger } from '../logging/index.js';

const log = logger.child({ component: 'SAFE-DISPATCH' });

// ── Constants ───────────────────────────────────────────────────────────────

// Native payment type hash (from mech-client-ts/dist/marketplace_interact.js)
const NATIVE_PAYMENT_TYPE = '0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1';

// ── ABIs ────────────────────────────────────────────────────────────────────

const MECH_MARKETPLACE_ABI = [
    'function request(bytes memory requestData, uint256 maxDeliveryRate, bytes32 paymentType, address priorityMech, uint256 responseTimeout, bytes memory paymentData) external payable returns (bytes32 requestId)',
    'function minResponseTimeout() view returns (uint256)',
    'function maxResponseTimeout() view returns (uint256)',
    'event MarketplaceRequest(address indexed priorityMech, address indexed requester, uint256 numRequests, bytes32[] requestIds, bytes[] requestDatas)',
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

// ── Types ───────────────────────────────────────────────────────────────────

export interface SafeDispatchParams {
    /** Safe multisig address that will be msg.sender on-chain */
    serviceSafeAddress: string;
    /** Agent EOA private key — used to sign the Safe transaction */
    agentEoaPrivateKey: string;
    /** Priority mech address — caller chooses routing (e.g. getRandomStakedMech) */
    priorityMech: string;
    /** MechMarketplace contract address */
    mechMarketplaceAddress: string;
    /** JSON-RPC URL */
    rpcUrl: string;
    /** Pre-built IPFS payload objects (one per request) */
    ipfsJsonContents: unknown[];
    /** Caller's response timeout in seconds (clamped to contract bounds) */
    responseTimeout?: number;
}

export interface SafeDispatchResult {
    /** On-chain request IDs — matches marketplaceInteract return shape */
    request_ids: string[];
    /** Transaction hash(es) from the Safe execTransaction call(s) */
    transactionHash: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sign a Safe transaction hash using eth_sign format.
 * The v value is adjusted by +4 per Gnosis Safe convention.
 */
function signSafeTransaction(wallet: ethers.Wallet, txHash: string): Promise<string> {
    return wallet.signMessage(ethers.getBytes(txHash)).then(signature => {
        const sigBytes = ethers.getBytes(signature);
        const r = ethers.hexlify(sigBytes.slice(0, 32));
        const s = ethers.hexlify(sigBytes.slice(32, 64));
        const v = sigBytes[64] + 4; // eth_sign marker for Safe
        return ethers.hexlify(ethers.concat([r, s, new Uint8Array([v])]));
    });
}

/**
 * Parse MarketplaceRequest event from a transaction receipt to extract request IDs.
 */
function extractRequestIds(receipt: ethers.TransactionReceipt): string[] {
    const iface = new ethers.Interface(MECH_MARKETPLACE_ABI);
    const requestIds: string[] = [];

    for (const eventLog of receipt.logs) {
        try {
            const parsed = iface.parseLog({ topics: eventLog.topics as string[], data: eventLog.data });
            if (parsed?.name === 'MarketplaceRequest') {
                const ids = parsed.args.requestIds || parsed.args[3];
                if (Array.isArray(ids)) {
                    for (const id of ids) {
                        requestIds.push(String(id));
                    }
                }
            }
        } catch {
            // Not a MarketplaceRequest event — skip
        }
    }

    return requestIds;
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Dispatch marketplace requests through the Gnosis Safe.
 *
 * Each request is sent as an individual Safe execTransaction + marketplace.request()
 * call. This ensures the activity checker's `diffRequestsCounts <= diffNonces`
 * constraint is satisfied (1 request = 1 Safe nonce increment).
 *
 * @throws If Safe address is missing, payment type is non-native, or tx fails
 */
export async function dispatchViaSafe(params: SafeDispatchParams): Promise<SafeDispatchResult> {
    const {
        serviceSafeAddress,
        agentEoaPrivateKey,
        priorityMech,
        mechMarketplaceAddress,
        rpcUrl,
        ipfsJsonContents,
        responseTimeout,
    } = params;

    if (!serviceSafeAddress) {
        throw new Error(
            'Safe address is required for marketplace dispatch. ' +
            'Check JINN_SERVICE_SAFE_ADDRESS or service config.'
        );
    }

    log.info({
        safe: serviceSafeAddress,
        priorityMech,
        marketplace: mechMarketplaceAddress,
        numPayloads: ipfsJsonContents.length,
    }, 'Dispatching marketplace request(s) via Safe');

    // 1. Setup provider and wallet
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const agentWallet = new ethers.Wallet(agentEoaPrivateKey, provider);
    const safe = new ethers.Contract(serviceSafeAddress, SAFE_ABI, agentWallet);
    const marketplace = new ethers.Contract(mechMarketplaceAddress, MECH_MARKETPLACE_ABI, provider);
    const mech = new ethers.Contract(priorityMech, MECH_ABI, provider);

    // 2. Query mech payment type — fail if not native
    const mechPaymentType = await mech.paymentType();
    const paymentTypeHex = String(mechPaymentType).toLowerCase();

    if (paymentTypeHex !== NATIVE_PAYMENT_TYPE) {
        throw new Error(
            `Unsupported payment type for Safe dispatch: ${paymentTypeHex}. ` +
            `Only native payment type (${NATIVE_PAYMENT_TYPE}) is supported. ` +
            'Non-native mechs cannot use Safe-based dispatch.'
        );
    }

    // 3. Query mech delivery rate and marketplace timeout bounds
    const [maxDeliveryRate, minTimeout, maxTimeout] = await Promise.all([
        mech.maxDeliveryRate(),
        marketplace.minResponseTimeout(),
        marketplace.maxResponseTimeout(),
    ]);

    // 4. Clamp caller's responseTimeout to contract bounds
    const minT = Number(minTimeout);
    const maxT = Number(maxTimeout);
    const requestedTimeout = responseTimeout ?? 300;
    const clampedTimeout = Math.max(minT, Math.min(maxT, requestedTimeout));

    if (clampedTimeout !== requestedTimeout) {
        log.debug({
            requested: requestedTimeout,
            clamped: clampedTimeout,
            min: minT,
            max: maxT,
        }, 'Response timeout clamped to contract bounds');
    }

    // 5. Upload IPFS payloads
    const ipfsHashes: string[] = [];
    for (let i = 0; i < ipfsJsonContents.length; i++) {
        const [truncatedHash, cidString] = await pushJsonToIpfs(ipfsJsonContents[i]);
        ipfsHashes.push(truncatedHash);
        log.debug({ index: i, ipfsUrl: `https://gateway.autonolas.tech/ipfs/${cidString}` }, 'Payload uploaded to IPFS');
    }

    // 6. Check Safe balance (native payment = msg.value = maxDeliveryRate per request)
    const pricePerRequest = maxDeliveryRate;
    const totalPrice = pricePerRequest * BigInt(ipfsJsonContents.length);
    const safeBalance = await provider.getBalance(serviceSafeAddress);

    if (safeBalance < totalPrice) {
        throw new Error(
            `Insufficient balance in Safe ${serviceSafeAddress}. ` +
            `Available: ${ethers.formatEther(safeBalance)} ETH, ` +
            `Needed: ${ethers.formatEther(totalPrice)} ETH ` +
            `(${ipfsJsonContents.length} requests × ${ethers.formatEther(pricePerRequest)} ETH each)`
        );
    }

    // 7. Send individual request() per Safe tx (activity checker nonce constraint)
    const allRequestIds: string[] = [];
    let lastTxHash = '';

    for (let i = 0; i < ipfsHashes.length; i++) {
        const requestData = ipfsHashes[i];

        // Encode marketplace.request() call
        const callData = marketplace.interface.encodeFunctionData('request', [
            requestData,           // bytes requestData (IPFS digest hash)
            maxDeliveryRate,       // uint256 maxDeliveryRate
            mechPaymentType,       // bytes32 paymentType
            priorityMech,          // address priorityMech
            clampedTimeout,        // uint256 responseTimeout
            '0x',                  // bytes paymentData (empty for native)
        ]);

        // Get current Safe nonce (increments with each execTransaction)
        const safeNonce = await safe.nonce();

        // Build Safe transaction hash
        const txHash = await safe.getTransactionHash(
            mechMarketplaceAddress,   // to
            pricePerRequest,          // value
            callData,                 // data
            0,                        // operation (CALL)
            0,                        // safeTxGas
            0,                        // baseGas
            0,                        // gasPrice
            ethers.ZeroAddress,       // gasToken
            ethers.ZeroAddress,       // refundReceiver
            safeNonce,                // nonce
        );

        // Sign and execute
        const signature = await signSafeTransaction(agentWallet, txHash);

        log.debug({ index: i, safeNonce: Number(safeNonce) }, 'Executing Safe transaction');

        const tx = await safe.execTransaction(
            mechMarketplaceAddress,
            pricePerRequest,
            callData,
            0,                        // operation
            0,                        // safeTxGas
            0,                        // baseGas
            0,                        // gasPrice
            ethers.ZeroAddress,       // gasToken
            ethers.ZeroAddress,       // refundReceiver
            signature,
        );

        const receipt = await tx.wait();

        if (!receipt || receipt.status !== 1) {
            throw new Error(
                `Safe dispatch transaction failed for request ${i + 1}/${ipfsHashes.length}. ` +
                `TxHash: ${tx.hash}`
            );
        }

        // Extract request IDs from MarketplaceRequest event
        const requestIds = extractRequestIds(receipt);
        allRequestIds.push(...requestIds);
        lastTxHash = receipt.hash;

        log.info({
            index: i,
            txHash: receipt.hash,
            gasUsed: receipt.gasUsed.toString(),
            requestIds,
        }, 'Safe dispatch successful');
    }

    log.info({
        totalRequests: allRequestIds.length,
        request_ids: allRequestIds,
        safeAddress: serviceSafeAddress,
    }, 'All marketplace requests dispatched via Safe');

    return {
        request_ids: allRequestIds,
        transactionHash: lastTxHash,
    };
}
