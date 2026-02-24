/**
 * IPFS bootstrap peer discovery and self-registration.
 *
 * - fetchBootstrapPeers(): queries x402-gateway for other operators' multiaddrs
 * - registerMultiaddrs(): registers this node's multiaddrs so others can find it
 *
 * Both are non-fatal — if the gateway is unreachable, the node operates locally
 * (local blockstore + HTTP fallback).
 */

import type { Helia } from '@helia/interface';
import { workerLogger } from '../logging/index.js';
import { getServicePrivateKey } from '../env/operate-profile.js';
import {
  createPrivateKeyHttpSigner,
  resolveChainId,
  signRequestWithErc8128,
} from '../http/erc8128.js';
import { privateKeyToAccount } from 'viem/accounts';

function getGatewayUrl(): string | null {
  const url = process.env.X402_GATEWAY_URL;
  return url ? url.replace(/\/$/, '') : null;
}

function getSigner() {
  const privateKey = getServicePrivateKey();
  if (!privateKey) return null;
  return createPrivateKeyHttpSigner(
    privateKey as `0x${string}`,
    resolveChainId(process.env.CHAIN_ID || process.env.CHAIN_CONFIG || 'base'),
  );
}

function getOwnAddress(): string | null {
  const privateKey = getServicePrivateKey();
  if (!privateKey) return null;
  return privateKeyToAccount(privateKey as `0x${string}`).address.toLowerCase();
}

/**
 * Fetch bootstrap peer multiaddrs from the x402-gateway operators table.
 * Filters out the caller's own multiaddrs to avoid self-dial.
 * Returns empty array on any failure (node operates locally).
 */
export async function fetchBootstrapPeers(): Promise<string[]> {
  const gatewayUrl = getGatewayUrl();
  if (!gatewayUrl) {
    workerLogger.debug('No X402_GATEWAY_URL — skipping bootstrap peer discovery');
    return [];
  }

  const signer = getSigner();
  if (!signer) return [];

  const ownAddress = getOwnAddress();

  try {
    const url = `${gatewayUrl}/admin/operators/network`;
    const request = await signRequestWithErc8128({
      signer,
      input: url,
      init: {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      },
      signOptions: {
        label: 'eth',
        binding: 'request-bound',
        replay: 'non-replayable',
        ttlSeconds: 60,
      },
    });

    const response = await fetch(request);
    if (!response.ok) {
      workerLogger.warn({ status: response.status }, 'Failed to fetch bootstrap peers');
      return [];
    }

    const body = await response.json() as {
      operators: Array<{ address: string; multiaddrs: string[] | null }>;
    };

    const peers: string[] = [];
    for (const op of body.operators || []) {
      // Skip own entry
      if (ownAddress && op.address.toLowerCase() === ownAddress) continue;
      if (Array.isArray(op.multiaddrs)) {
        peers.push(...op.multiaddrs);
      }
    }

    workerLogger.info({ bootstrapPeerCount: peers.length }, 'Fetched bootstrap peers from operators table');
    return peers;
  } catch (err: any) {
    workerLogger.warn(
      { error: err?.message || String(err) },
      'Failed to fetch bootstrap peers (non-fatal) — node will operate locally',
    );
    return [];
  }
}

/**
 * Register this node's multiaddrs and peerId with the x402-gateway so other
 * nodes can discover it. Called once after Helia starts.
 * Non-fatal — if registration fails, the node still works.
 */
export async function registerMultiaddrs(helia: Helia): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  if (!gatewayUrl) return;

  const privateKey = getServicePrivateKey();
  if (!privateKey) return;

  const signer = getSigner();
  if (!signer) return;

  const ownAddress = getOwnAddress();
  if (!ownAddress) return;

  const multiaddrs = helia.libp2p.getMultiaddrs().map(ma => ma.toString());
  const peerId = helia.libp2p.peerId.toString();

  if (multiaddrs.length === 0) {
    workerLogger.debug('No multiaddrs to register');
    return;
  }

  try {
    const url = `${gatewayUrl}/admin/operators/${ownAddress}/network`;
    const body = JSON.stringify({ multiaddrs, peerId });

    const request = await signRequestWithErc8128({
      signer,
      input: url,
      init: {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      },
      signOptions: {
        label: 'eth',
        binding: 'request-bound',
        replay: 'non-replayable',
        ttlSeconds: 60,
      },
    });

    const response = await fetch(request);
    if (response.ok) {
      workerLogger.info({ peerId, multiaddrs }, 'Registered IPFS multiaddrs with gateway');
    } else {
      const text = await response.text().catch(() => '');
      workerLogger.warn(
        { status: response.status, body: text },
        'Failed to register multiaddrs (non-fatal)',
      );
    }
  } catch (err: any) {
    workerLogger.warn(
      { error: err?.message || String(err) },
      'Failed to register multiaddrs (non-fatal)',
    );
  }
}
