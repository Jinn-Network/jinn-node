/**
 * Signing Proxy
 *
 * Local HTTP server that mediates all private key operations for the agent subprocess.
 * Runs in the worker process on 127.0.0.1 with a random port and bearer token.
 * The agent never has direct access to the private key.
 *
 * Endpoints:
 * - GET  /address          — Derive and return the agent's address
 * - POST /sign             — EIP-191 personal_sign
 * - POST /sign-raw         — EIP-191 sign raw bytes (0x-prefixed hex)
 * - POST /sign-typed-data  — EIP-712 typed data sign
 * - POST /dispatch         — Full marketplaceInteract() call
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { getServicePrivateKey, getMechAddress, getMechChainConfig } from '../env/operate-profile.js';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function loadPrivateKey(): string {
  const key = getServicePrivateKey();
  if (!key) {
    throw new Error('Service private key not available');
  }
  return key;
}

let cachedAddress: string | null = null;

async function getAddress(): Promise<string> {
  if (cachedAddress) return cachedAddress;
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(loadPrivateKey() as `0x${string}`);
  cachedAddress = account.address.toLowerCase();
  return cachedAddress;
}

async function handleAddress(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const address = await getAddress();
  json(res, 200, { address });
}

async function handleSign(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req));
  if (!body.message || typeof body.message !== 'string') {
    json(res, 400, { error: 'Missing or invalid "message" field', code: 'BAD_REQUEST' });
    return;
  }

  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(loadPrivateKey() as `0x${string}`);
  const signature = await account.signMessage({ message: body.message });

  json(res, 200, {
    signature,
    address: account.address.toLowerCase(),
  });
}

async function handleSignRaw(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req));
  if (!body.message || typeof body.message !== 'string' || !/^0x[0-9a-fA-F]*$/.test(body.message) || body.message.length % 2 !== 0) {
    json(res, 400, { error: 'Missing or invalid "message" field (expected 0x-prefixed even-length hex)', code: 'BAD_REQUEST' });
    return;
  }

  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(loadPrivateKey() as `0x${string}`);
  const signature = await account.signMessage({ message: { raw: body.message as `0x${string}` } });

  json(res, 200, {
    signature,
    address: account.address.toLowerCase(),
  });
}

async function handleSignTypedData(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req));
  const { domain, types, primaryType, message } = body;

  if (!domain || !types || !primaryType || !message) {
    json(res, 400, { error: 'Missing required EIP-712 fields: domain, types, primaryType, message', code: 'BAD_REQUEST' });
    return;
  }

  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(loadPrivateKey() as `0x${string}`);
  const signature = await account.signTypedData({ domain, types, primaryType, message });

  json(res, 200, {
    signature,
    address: account.address.toLowerCase(),
  });
}

async function handleDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse(await readBody(req));
  const { prompts, tools, ipfsJsonContents, postOnly, responseTimeout } = body;

  if (!prompts || !ipfsJsonContents) {
    json(res, 400, { error: 'Missing required dispatch fields: prompts, ipfsJsonContents', code: 'BAD_REQUEST' });
    return;
  }

  const privateKey = loadPrivateKey();
  const mechAddress = body.priorityMech || getMechAddress();
  const chainConfig = body.chainConfig || getMechChainConfig();

  if (!mechAddress) {
    json(res, 500, { error: 'Service mech address not configured', code: 'CONFIG_ERROR' });
    return;
  }

  const result = await marketplaceInteract({
    prompts,
    priorityMech: mechAddress,
    tools: tools || [],
    ipfsJsonContents,
    chainConfig,
    keyConfig: { source: 'value', value: privateKey },
    postOnly: postOnly !== false,
    responseTimeout: responseTimeout || 120,
  });

  json(res, 200, result);
}

export async function startSigningProxy(): Promise<{
  url: string;
  secret: string;
  close: () => Promise<void>;
}> {
  const secret = randomBytes(32).toString('hex');

  const server = createServer(async (req, res) => {
    // Auth check
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${secret}`) {
      json(res, 401, { error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const url = req.url || '';
    const method = req.method || '';

    try {
      if (method === 'GET' && url === '/address') {
        await handleAddress(req, res);
      } else if (method === 'POST' && url === '/sign') {
        await handleSign(req, res);
      } else if (method === 'POST' && url === '/sign-raw') {
        await handleSignRaw(req, res);
      } else if (method === 'POST' && url === '/sign-typed-data') {
        await handleSignTypedData(req, res);
      } else if (method === 'POST' && url === '/dispatch') {
        await handleDispatch(req, res);
      } else {
        json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
      }
    } catch (err: any) {
      // Never leak the private key in error messages
      const message = err?.message || 'Internal server error';
      const safeMessage = message.replace(/0x[a-fA-F0-9]{64}/g, '[REDACTED]');
      json(res, 500, { error: safeMessage, code: 'INTERNAL_ERROR' });
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        secret,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}
