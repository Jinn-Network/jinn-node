/**
 * Credential-based job filtering for trusted operator routing.
 *
 * At startup the worker probes the credential bridge (x402-gateway) to discover
 * which providers the worker's address has ACL grants for. The bridge ACL is the
 * source of truth — no self-declared env vars needed.
 *
 * If CREDENTIAL_BRIDGE_URL is unset or the probe fails, the worker behaves as a
 * public operator (no filtering, no priority).
 *
 * IMPORTANT: When adding a new MCP tool that calls getCredential(),
 * add an entry to TOOL_CREDENTIAL_MAP below.
 */

import { workerLogger } from '../../logging/index.js';
import { getServicePrivateKey } from '../../env/operate-profile.js';

/**
 * Maps MCP tool names to the credential providers they require.
 * Provider names must match those used in getCredential('providerName')
 * calls and static-providers.ts entries.
 */
export const TOOL_CREDENTIAL_MAP: Record<string, string[]> = {
  // GitHub tools → 'github' (github_tools.ts)
  'get_file_contents': ['github'],
  'search_code': ['github'],
  'list_commits': ['github'],

  // Telegram tools → 'telegram' (telegram-messaging.ts)
  'telegram_send_message': ['telegram'],
  'telegram_send_photo': ['telegram'],
  'telegram_send_document': ['telegram'],

  // Twitter tools → 'twitter' (twitter-social.ts)
  'verify_trade_ideas': ['twitter'],

  // Blog analytics → 'umami' (blog-analytics.ts)
  'blog_get_stats': ['umami'],
  'blog_get_top_pages': ['umami'],
  'blog_get_referrers': ['umami'],
  'blog_get_metrics': ['umami'],
  'blog_get_pageviews': ['umami'],
  'blog_get_performance_summary': ['umami'],

  // OpenAI → 'openai' (shared/openai.ts)
  'embed_text': ['openai'],

  // Civitai → 'civitai' (shared/civitai.ts)
  'civitai_generate_image': ['civitai'],

  // Supabase-dependent tools (shared/supabase.ts)
  'search_services': ['supabase'],
  'service_registry': ['supabase'],

  // Meta-tools (blueprint names before expansion via toolPolicy.ts)
  'telegram_messaging': ['telegram'],
  'fireflies_meetings': ['fireflies'],
  'railway_deployment': ['railway'],
};

/**
 * Given a job's enabledTools list, return the set of credential providers
 * the job requires. Returns empty array if no credentials needed.
 */
export function getRequiredCredentials(enabledTools: string[]): string[] {
  const providers = new Set<string>();
  for (const tool of enabledTools) {
    const creds = TOOL_CREDENTIAL_MAP[tool];
    if (creds) {
      for (const cred of creds) {
        providers.add(cred);
      }
    }
  }
  return [...providers];
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

/**
 * Probe the credential bridge to discover which providers this worker has
 * ACL grants for. The worker signs the request directly with its private key
 * (no signing proxy needed — the worker has the key).
 *
 * Returns empty providers on any failure (bridge down, no URL, no key).
 */
export async function probeCredentialBridge(): Promise<WorkerCredentialInfo> {
  const bridgeUrl = process.env.CREDENTIAL_BRIDGE_URL;
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
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(privateKey as `0x${string}`);

    const body = {
      timestamp: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID(),
    };
    const message = JSON.stringify(body);
    const signature = await account.signMessage({ message });

    const url = `${bridgeUrl.replace(/\/$/, '')}/credentials/capabilities`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Signature': signature,
        'X-Agent-Address': account.address.toLowerCase(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      workerLogger.warn(
        { status: response.status, url },
        'Credential bridge probe failed — treating as no credentials',
      );
      return { providers: new Set(), isTrusted: false };
    }

    const data = await response.json() as { providers: string[] };
    const providers = new Set(data.providers);
    return { providers, isTrusted: providers.size > 0 };
  } catch (err) {
    workerLogger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Credential bridge probe error — treating as no credentials',
    );
    return { providers: new Set(), isTrusted: false };
  }
}

// Cached singleton (computed once at first call)
let _cachedInfo: WorkerCredentialInfo | null = null;

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

/** Reset cached info (for testing). */
export function _resetCredentialInfoCache(): void {
  _cachedInfo = null;
}
