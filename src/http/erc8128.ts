import {
  createSignerClient,
  createVerifierClient,
  formatKeyId,
  parseKeyId,
  type Address,
  type ClientOptions,
  type EthHttpSigner,
  type Hex,
  type NonceStore,
  type SignOptions,
  type VerifyPolicy,
  type VerifyResult,
} from '@slicekit/erc8128';
import { verifyMessage, type Account } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export type Erc8128NonceStore = NonceStore;

export type Erc8128Signer = EthHttpSigner;

export const DEFAULT_ERC8128_SIGN_OPTIONS: SignOptions = {
  label: 'eth',
  binding: 'request-bound',
  replay: 'non-replayable',
  ttlSeconds: 60,
};

export const DEFAULT_ERC8128_VERIFY_POLICY: VerifyPolicy = {
  label: 'eth',
  strictLabel: false,
  replayable: false,
  clockSkewSec: 5,
  maxValiditySec: 300,
  maxNonceWindowSec: 300,
};

const CHAIN_CONFIG_TO_CHAIN_ID: Record<string, number> = {
  base: 8453,
  'base-mainnet': 8453,
  base_mainnet: 8453,
  'base-sepolia': 84532,
  base_sepolia: 84532,
  gnosis: 100,
  ethereum: 1,
  mainnet: 1,
  sepolia: 11155111,
  optimism: 10,
  mode: 34443,
};

function toHex(bytes: Uint8Array): Hex {
  return (`0x${Buffer.from(bytes).toString('hex')}`) as Hex;
}

export function normalizeAddress(value: string): Address {
  return value.toLowerCase() as Address;
}

export function resolveChainId(chainConfig?: string | null, fallback = 8453): number {
  if (!chainConfig) return fallback;
  const normalized = chainConfig.toLowerCase().trim();
  if (/^\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }
  return CHAIN_CONFIG_TO_CHAIN_ID[normalized] ?? fallback;
}

export function createAccountHttpSigner(account: Account, chainId: number): EthHttpSigner {
  return {
    address: normalizeAddress(account.address),
    chainId,
    signMessage: async (message: Uint8Array) =>
      account.signMessage({ message: { raw: toHex(message) } }) as Promise<Hex>,
  };
}

export function createPrivateKeyHttpSigner(privateKey: Hex, chainId: number): EthHttpSigner {
  const account = privateKeyToAccount(privateKey);
  return createAccountHttpSigner(account, chainId);
}

export function createSignedFetchClient(
  signer: EthHttpSigner,
  defaults: Partial<ClientOptions> = {},
) {
  return createSignerClient(signer, {
    ...DEFAULT_ERC8128_SIGN_OPTIONS,
    ...defaults,
  });
}

export async function signRequestWithErc8128(args: {
  signer: EthHttpSigner;
  input: RequestInfo;
  init?: RequestInit;
  signOptions?: SignOptions;
}): Promise<Request> {
  const client = createSignedFetchClient(args.signer, args.signOptions);
  return client.signRequest(args.input, args.init, args.signOptions);
}

export async function signedFetchWithErc8128(args: {
  signer: EthHttpSigner;
  input: RequestInfo;
  init?: RequestInit;
  signOptions?: SignOptions;
  fetch?: typeof fetch;
}): Promise<Response> {
  const client = createSignedFetchClient(args.signer, {
    fetch: args.fetch,
    ...(args.signOptions ?? {}),
  });
  return client.fetch(args.input, args.init, args.signOptions);
}

export function createErc8128Verifier(
  nonceStore: NonceStore,
  policy: Partial<VerifyPolicy> = {},
) {
  return createVerifierClient(
    async ({ address, message, signature }) =>
      verifyMessage({
        address,
        message: { raw: message.raw },
        signature,
      }),
    nonceStore,
    {
      ...DEFAULT_ERC8128_VERIFY_POLICY,
      ...policy,
    },
  );
}

export async function verifyRequestWithErc8128(args: {
  request: Request;
  nonceStore: NonceStore;
  policy?: Partial<VerifyPolicy>;
}): Promise<VerifyResult> {
  const verifier = createErc8128Verifier(args.nonceStore, args.policy);
  return verifier.verifyRequest(args.request, args.policy);
}

export function buildErc8128IdempotencyKey(parts: Array<string | number | undefined | null>): string {
  return parts
    .filter((part): part is string | number => part !== undefined && part !== null && `${part}`.length > 0)
    .map((part) => String(part))
    .join(':');
}

export function formatErc8128KeyId(chainId: number, address: Address): string {
  return formatKeyId(chainId, address);
}

export function parseErc8128KeyId(keyId: string): { chainId: number; address: Address } | null {
  return parseKeyId(keyId);
}

export class InMemoryNonceStore implements NonceStore {
  private readonly entries = new Map<string, number>();

  async consume(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = now + Math.max(ttlSeconds, 1) * 1000;
    const existing = this.entries.get(key);

    if (existing && existing > now) {
      return false;
    }

    this.entries.set(key, expiresAt);
    this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.entries.entries()) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

