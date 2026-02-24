/**
 * Legacy CID resolution for historical Autonolas content.
 *
 * On-chain content before the private IPFS migration was uploaded with
 * dag-pb codec and/or directory wrapping. This module builds CID candidates
 * matching the old format and fetches from HTTP gateways as a fallback.
 */

const DEFAULT_IPFS_GATEWAY = 'https://gateway.autonolas.tech/ipfs/';
const FALLBACK_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

function buildCidV1HexCandidates(hexBytes: string): string[] {
  const hexClean = hexBytes.startsWith('0x') ? hexBytes.slice(2) : hexBytes;
  return [
    `f01701220${hexClean}`, // dag-pb
    `f01551220${hexClean}`, // raw
  ];
}

function isFullCidString(value: string): boolean {
  return /^baf|^Qm|^f01/i.test(value);
}

function extractDigestHexFromHexCid(hexCid: string): string | null {
  const s = hexCid.toLowerCase();
  if (s.startsWith('f01701220')) return s.slice(9);
  if (s.startsWith('f01551220')) return s.slice(9);
  return null;
}

function toDecimalRequestIdStrict(id: string): string {
  const s = String(id).trim();
  return s.startsWith('0x') ? BigInt(s).toString(10) : s;
}

function hexCidToBase32DagPb(hexCid: string): string | null {
  try {
    const digestHex = hexCid.toLowerCase().replace(/^f01551220/i, '');
    if (digestHex === hexCid.toLowerCase()) return null;

    const digestBytes: number[] = [];
    for (let i = 0; i < digestHex.length; i += 2) {
      digestBytes.push(parseInt(digestHex.slice(i, i + 2), 16));
    }

    const cidBytes = [0x01, 0x70, 0x12, 0x20, ...digestBytes];
    const base32Alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bitBuffer = 0;
    let bitCount = 0;
    let out = '';

    for (const b of cidBytes) {
      bitBuffer = (bitBuffer << 8) | (b & 0xff);
      bitCount += 8;
      while (bitCount >= 5) {
        const idx = (bitBuffer >> (bitCount - 5)) & 0x1f;
        bitCount -= 5;
        out += base32Alphabet[idx];
      }
    }
    if (bitCount > 0) {
      const idx = (bitBuffer << (5 - bitCount)) & 0x1f;
      out += base32Alphabet[idx];
    }

    return `b${out}`;
  } catch {
    return null;
  }
}

export function buildLegacyCidCandidates(
  ipfsHash: string,
  options?: { requestId?: string },
): { cidPath: string; context: string }[] {
  const isFullCid = isFullCidString(ipfsHash);
  const hasRequestId = Boolean(options?.requestId);
  let candidates: string[] = [];

  if (hasRequestId && isFullCid && /^f01551220/i.test(ipfsHash)) {
    const dagPb = hexCidToBase32DagPb(ipfsHash);
    if (dagPb) {
      candidates = [dagPb];
    } else {
      const digest = extractDigestHexFromHexCid(ipfsHash);
      candidates = digest ? [`f01701220${digest}`, `f01551220${digest}`] : [ipfsHash];
    }
  } else if (isFullCid && /^f01/i.test(ipfsHash)) {
    if (ipfsHash.toLowerCase().startsWith('f01551220')) {
      const digest = extractDigestHexFromHexCid(ipfsHash);
      const dagPb = digest ? `f01701220${digest}` : null;
      candidates = dagPb ? [ipfsHash, dagPb] : [ipfsHash];
    } else {
      const digest = extractDigestHexFromHexCid(ipfsHash);
      const rawCid = digest ? `f01551220${digest}` : null;
      candidates = rawCid ? [ipfsHash, rawCid] : [ipfsHash];
    }
  } else if (isFullCid) {
    candidates = [ipfsHash];
  } else {
    candidates = buildCidV1HexCandidates(ipfsHash);
  }

  return candidates.map((cid) => {
    if (!hasRequestId) {
      return { cidPath: cid, context: cid };
    }
    const requestSegment = toDecimalRequestIdStrict(options!.requestId!);
    return { cidPath: `${cid}/${requestSegment}`, context: `${cid}/${requestSegment}` };
  });
}

/**
 * Fetch legacy content from HTTP IPFS gateways.
 * Tries the primary gateway first, falls back to IPFS.io.
 */
export async function fetchLegacyContent(
  digestHex: string,
  options?: { requestId?: string; timeoutMs?: number },
): Promise<unknown | null> {
  const candidates = buildLegacyCidCandidates(digestHex, options);
  const timeout = options?.timeoutMs ?? 10_000;

  for (const candidate of candidates) {
    const result = await tryGateway(candidate.cidPath, timeout);
    if (result !== null) return result;
  }
  return null;
}

async function tryGateway(cidPath: string, timeout: number): Promise<unknown | null> {
  const gatewayUrl = process.env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAY;

  for (const base of [gatewayUrl, FALLBACK_IPFS_GATEWAY]) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const response = await fetch(`${base}${cidPath}`, { signal: controller.signal });
      clearTimeout(timer);

      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return await response.json();
      }
      return { contentType, text: await response.text() };
    } catch {
      continue;
    }
  }
  return null;
}

export const __TEST__ = {
  buildLegacyCidCandidates,
  toDecimalRequestIdStrict,
  hexCidToBase32DagPb,
};
