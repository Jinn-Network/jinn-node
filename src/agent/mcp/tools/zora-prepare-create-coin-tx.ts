import { z } from 'zod';
import { createPublicClient, http, createWalletClient, WalletClient, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { createCoin, setApiKey, createCoinCall, ContentCoinCurrency } from '@zoralabs/coins-sdk';

// Zod schemas for input validation
export const prepareCreateCoinTxParams = z.object({
  name: z.string().min(1).max(100).describe('Name of the content coin'),
  symbol: z.string().min(1).max(20).describe('Symbol of the content coin (e.g., "MYCOIN")'),
  uri: z.string().startsWith('ipfs://').describe('Metadata URI of the coin (must be an IPFS URI)'),
  creator: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().describe('The creator of the coin. Defaults to the worker address if not provided.'),
  creatorCoinAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().describe('Address of the creator coin to pool against. Required when currency is CREATOR_COIN or CREATOR_COIN_OR_ZORA.'),
  payoutRecipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/).describe('Address to receive creator rewards'),
  platformReferrer: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().describe('Optional address for platform referral rewards'),
  currency: z.enum(['ETH', 'ZORA', 'CREATOR_COIN', 'CREATOR_COIN_OR_ZORA']).default('ETH').describe('Trading currency for the coin pool. Can be ETH, ZORA, CREATOR_COIN, or CREATOR_COIN_OR_ZORA.'),
  chainId: z.number().int().positive().default(8453).describe('Chain ID (default: 8453 for Base)'),
  initialPurchaseAmount: z.string().optional().describe('Initial purchase amount in ETH (e.g., "0.01") to seed liquidity. Recommended for creator coin pools.'),
});

export type PrepareCreateCoinTxParams = z.infer<typeof prepareCreateCoinTxParams>;

export const prepareCreateCoinTxSchema = {
  description: 'Prepares a transaction to create a Zora content coin using the Zora SDK.',
  inputSchema: prepareCreateCoinTxParams.shape,
};

// Function to create Viem clients
function getClients(chainId: number) {
  const chain = chainId === 8453 ? base : baseSepolia;
  const transport = http(process.env.RPC_URL || process.env.BASE_RPC_URL);

  const publicClient = createPublicClient({
    chain,
    transport,
  });

  const account = privateKeyToAccount(process.env.WORKER_PRIVATE_KEY as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain,
    transport,
  });

  return { publicClient, walletClient };
}

export async function prepareCreateCoinTx(params: PrepareCreateCoinTxParams) {
  try {
    // Set the Zora API Key
    if (process.env.ZORA_API_KEY) {
      setApiKey(process.env.ZORA_API_KEY);
    } else {
      // It's better to return a structured error than to throw here
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            code: 'MISSING_API_KEY',
            message: 'ZORA_API_KEY is not set in the environment variables.'
          }, null, 2)
        }]
      };
    }

    const parseResult = prepareCreateCoinTxParams.safeParse(params);
    if (!parseResult.success) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ 
            ok: false, 
            code: 'VALIDATION_ERROR', 
            message: `Invalid parameters: ${parseResult.error.message}`,
            details: parseResult.error.flatten()
          }, null, 2)
        }]
      };
    }

    const { 
      name, 
      symbol, 
      uri, 
      payoutRecipient, 
      platformReferrer, 
      currency, 
      chainId,
      creatorCoinAddress,
      creator: creatorAddress,
      initialPurchaseAmount
    } = parseResult.data;

    if ((currency === 'CREATOR_COIN' || currency === 'CREATOR_COIN_OR_ZORA') && !creatorCoinAddress) {
        return {
            isError: true,
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    ok: false,
                    code: 'VALIDATION_ERROR',
                    message: 'creatorCoinAddress is required when currency is CREATOR_COIN or CREATOR_COIN_OR_ZORA'
                }, null, 2)
            }]
        };
    }

    const { publicClient, walletClient } = getClients(chainId);

    const coinParams = {
      creator: creatorAddress ? (creatorAddress as `0x${string}`) : walletClient.account.address,
      name,
      symbol,
      metadata: {
        type: 'RAW_URI' as const,
        uri: uri as any,
      },
      currency: currency as ContentCoinCurrency,
      chainId,
      payoutRecipientOverride: payoutRecipient as `0x${string}`,
      platformReferrer: platformReferrer as `0x${string}` | undefined,
      skipMetadataValidation: true,
    };

    const [transactionPayload] = await createCoinCall(coinParams);

    const response = {
      ok: true,
      transaction: {
        payload: {
          to: transactionPayload.to,
          data: transactionPayload.data,
          value: transactionPayload.value.toString() || '0',
        },
        chainId,
        note: 'Transaction prepared successfully using Zora SDK - use enqueue_transaction to submit'
      }
    };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(response, null, 2)
      }]
    };

  } catch (error: any) {
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          code: 'UNEXPECTED_ERROR',
          message: 'An unexpected error occurred while preparing transaction',
          error: error.message
        }, null, 2)
      }]
    };
  }
}
