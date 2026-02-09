/**
 * Signing Proxy Client
 *
 * Agent-side client for the signing proxy running in the worker process.
 * All private key operations are delegated to the proxy over localhost HTTP.
 *
 * Environment variables:
 * - JINN_SIGNING_PROXY_URL: Proxy base URL (e.g., http://127.0.0.1:12345)
 * - JINN_SIGNING_PROXY_SECRET: Bearer token for auth
 */

function getConfig(): { url: string; secret: string } {
  const url = process.env.JINN_SIGNING_PROXY_URL;
  const secret = process.env.JINN_SIGNING_PROXY_SECRET;
  if (!url || !secret) {
    throw new Error('Signing proxy not configured (JINN_SIGNING_PROXY_URL / JINN_SIGNING_PROXY_SECRET)');
  }
  return { url, secret };
}

async function proxyRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { url, secret } = getConfig();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${secret}`,
  };
  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${url}${path}`, init);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown proxy error', code: 'UNKNOWN' }));
    throw new Error(`Signing proxy error (${response.status}): ${(error as any).error} [${(error as any).code}]`);
  }

  return response.json() as Promise<T>;
}

/**
 * Get the agent's address derived from the service private key.
 */
export async function proxyGetAddress(): Promise<string> {
  const result = await proxyRequest<{ address: string }>('GET', '/address');
  return result.address;
}

/**
 * Sign a message with EIP-191 personal_sign via the signing proxy.
 */
export async function proxySign(message: string): Promise<{ signature: string; address: string }> {
  return proxyRequest<{ signature: string; address: string }>('POST', '/sign', { message });
}

/**
 * Sign EIP-712 typed data via the signing proxy.
 */
export async function proxySignTypedData(params: {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}): Promise<{ signature: string; address: string }> {
  return proxyRequest<{ signature: string; address: string }>('POST', '/sign-typed-data', params);
}

export interface DispatchParams {
  prompts: string[];
  priorityMech?: string;
  tools?: string[];
  ipfsJsonContents: unknown[];
  chainConfig?: string;
  postOnly?: boolean;
  responseTimeout?: number;
}

export interface DispatchResult {
  request_ids?: string[];
  [key: string]: unknown;
}

/**
 * Dispatch a marketplace request via the signing proxy.
 * The proxy has the private key and calls marketplaceInteract() internally.
 */
export async function proxyDispatch(params: DispatchParams): Promise<DispatchResult> {
  return proxyRequest<DispatchResult>('POST', '/dispatch', params);
}
