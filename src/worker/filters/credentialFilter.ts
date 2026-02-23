/**
 * Capability-based job filtering for trusted operator routing.
 *
 * At startup the worker probes the credential bridge (x402-gateway) to discover
 * which providers the worker's address has ACL grants for. The bridge ACL is the
 * source of truth — no self-declared env vars needed.
 *
 * Worker-local operator capabilities (e.g. GitHub token validity) are probed
 * independently from bridge capabilities.
 */

import { workerLogger } from '../../logging/index.js';
import { getServicePrivateKey } from '../../env/operate-profile.js';
import {
  TOOL_CREDENTIAL_MAP,
  TOOL_OPERATOR_CAPABILITY_MAP,
  getRequiredCredentialProviders,
  getRequiredOperatorCapabilities as getRequiredOperatorCapabilitiesFromTools,
} from '../../shared/tool-credential-requirements.js';
import {
  createPrivateKeyHttpSigner,
  resolveChainId,
  signRequestWithErc8128,
} from '../../http/erc8128.js';

/**
 * Legacy re-export for tests and callers.
 */
export { TOOL_CREDENTIAL_MAP, TOOL_OPERATOR_CAPABILITY_MAP };

/**
 * Given a job's enabledTools list, return the set of credential providers
 * the job requires. Returns empty array if no credentials needed.
 */
export function getRequiredCredentials(enabledTools: string[]): string[] {
  return getRequiredCredentialProviders(enabledTools);
}

/**
 * Given a job's enabledTools list, return operator-local capabilities required
 * by the job. Returns empty array if no operator-local capabilities needed.
 */
export function getRequiredOperatorCapabilities(enabledTools: string[]): string[] {
  return getRequiredOperatorCapabilitiesFromTools(enabledTools);
}

/**
 * Resolve which operator capabilities a worker is missing for a given job.
 */
export function resolveMissingOperatorCapabilities(
  enabledTools: string[] | undefined,
  workerOperatorCapabilities: Set<string>,
): string[] {
  if (!enabledTools || enabledTools.length === 0) return [];
  const required = getRequiredOperatorCapabilities(enabledTools);
  if (required.length === 0) return [];
  return required.filter(capability => !workerOperatorCapabilities.has(capability));
}

/**
 * Check if a job is eligible for this worker based on operator-local capabilities.
 */
export function isJobEligibleForOperatorCapabilities(
  enabledTools: string[] | undefined,
  workerOperatorCapabilities: Set<string>,
): boolean {
  return resolveMissingOperatorCapabilities(enabledTools, workerOperatorCapabilities).length === 0;
}

/**
 * Check if a job is eligible for this worker based on credential availability.
 * Returns true if the worker has all required credentials (or the job needs none).
 */
export function isJobEligibleForWorker(
  enabledTools: string[] | undefined,
  workerCredentials: Set<string>,
): boolean {
  if (!enabledTools || enabledTools.length === 0) return true;

  const required = getRequiredCredentials(enabledTools);
  if (required.length === 0) return true;

  return required.every(cred => workerCredentials.has(cred));
}

/**
 * Check if a job requires any credentials at all.
 * Used for priority sorting: credential jobs first for trusted operators.
 */
export function jobRequiresCredentials(enabledTools: string[] | undefined): boolean {
  if (!enabledTools || enabledTools.length === 0) return false;
  return getRequiredCredentials(enabledTools).length > 0;
}

export interface WorkerCredentialInfo {
  providers: Set<string>;
  isTrusted: boolean;
}

export interface WorkerOperatorCapabilityInfo {
  capabilities: Set<string>;
  isTrusted: boolean;
}

const GITHUB_CAPABILITY = 'github';

/**
 * Probe the credential bridge to discover which providers this worker has
 * ACL grants for. The worker signs the request directly with its private key
 * (no signing proxy needed — the worker has the key).
 *
 * If requestId is provided, the probe also returns venture-scoped providers
 * for the job's venture context (union of global + venture-scoped).
 *
 * Returns empty providers on any failure (bridge down, no URL, no key).
 */
export async function probeCredentialBridge(requestId?: string): Promise<WorkerCredentialInfo> {
  const bridgeUrl = process.env.X402_GATEWAY_URL;
  if (!bridgeUrl) {
    return { providers: new Set(), isTrusted: false };
  }

  let privateKey: string | undefined;
  try {
    privateKey = getServicePrivateKey();
  } catch {
    workerLogger.warn('No service private key available — skipping credential bridge probe');
    return { providers: new Set(), isTrusted: false };
  }

  if (!privateKey) {
    return { providers: new Set(), isTrusted: false };
  }

  try {
    const signer = createPrivateKeyHttpSigner(
      privateKey as `0x${string}`,
      resolveChainId(process.env.CHAIN_ID || process.env.CHAIN_CONFIG || 'base'),
    );
    const body: { requestId?: string } = {};
    if (requestId) body.requestId = requestId;

    const url = `${bridgeUrl.replace(/\/$/, '')}/credentials/capabilities`;
    const request = await signRequestWithErc8128({
      signer,
      input: url,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
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
      workerLogger.warn(
        { status: response.status, url },
        'Credential bridge probe failed — treating as no credentials',
      );
      return { providers: new Set(), isTrusted: false };
    }

    const data = await response.json() as { providers: unknown };
    const providerList = Array.isArray(data.providers) ? data.providers.filter((p): p is string => typeof p === 'string') : [];
    const providers = new Set(providerList);
    return { providers, isTrusted: providers.size > 0 };
  } catch (err) {
    workerLogger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Credential bridge probe error — treating as no credentials',
    );
    return { providers: new Set(), isTrusted: false };
  }
}

/**
 * Probe worker-local operator capabilities.
 *
 * Currently validates GitHub capability by checking that GITHUB_TOKEN exists
 * and succeeds against ${GITHUB_API_URL}/user.
 */
export async function probeOperatorCapabilities(): Promise<WorkerOperatorCapabilityInfo> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { capabilities: new Set(), isTrusted: false };
  }

  const githubApiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const url = `${githubApiUrl}/user`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'jinn-mech-worker',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      workerLogger.warn(
        { status: response.status },
        'GitHub capability probe failed — treating as no github capability',
      );
      return { capabilities: new Set(), isTrusted: false };
    }

    return { capabilities: new Set([GITHUB_CAPABILITY]), isTrusted: true };
  } catch (err) {
    workerLogger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'GitHub capability probe error — treating as no github capability',
    );
    return { capabilities: new Set(), isTrusted: false };
  }
}

// Cached singleton (computed once at first call)
let _cachedInfo: WorkerCredentialInfo | null = null;
let _cachedOperatorInfo: WorkerOperatorCapabilityInfo | null = null;

/**
 * Get the worker's credential capability info (cached after first call).
 * Async because the bridge probe is an HTTP call on first invocation.
 */
export async function getWorkerCredentialInfo(): Promise<WorkerCredentialInfo> {
  if (_cachedInfo) return _cachedInfo;
  _cachedInfo = await probeCredentialBridge();
  if (_cachedInfo.providers.size > 0) {
    workerLogger.info(
      { providers: [..._cachedInfo.providers] },
      'Worker credential capabilities discovered via bridge',
    );
  }
  return _cachedInfo;
}

/**
 * Get the worker's operator-local capabilities (cached after first call).
 */
export async function getWorkerOperatorCapabilityInfo(): Promise<WorkerOperatorCapabilityInfo> {
  if (_cachedOperatorInfo) return _cachedOperatorInfo;
  _cachedOperatorInfo = await probeOperatorCapabilities();
  if (_cachedOperatorInfo.capabilities.size > 0) {
    workerLogger.info(
      { capabilities: [..._cachedOperatorInfo.capabilities] },
      'Worker operator capabilities discovered',
    );
  }
  return _cachedOperatorInfo;
}

/**
 * Re-probe the credential bridge with a specific requestId to discover
 * venture-scoped credentials. Called after claiming a job when requestId is known.
 *
 * Returns the full set of providers (global + venture-scoped).
 * Does NOT update the cached startup info — this is per-job.
 */
export async function reprobeWithRequestId(requestId: string): Promise<WorkerCredentialInfo> {
  return probeCredentialBridge(requestId);
}

/** Reset cached credential info (called on service rotation + tests). */
export function resetCredentialInfoCache(): void {
  _cachedInfo = null;
  _cachedOperatorInfo = null;
}

/** Reset operator capability cache (for testing). */
export function _resetOperatorCapabilityInfoCache(): void {
  _cachedOperatorInfo = null;
}
