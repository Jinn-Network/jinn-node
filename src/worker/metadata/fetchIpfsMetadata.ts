/**
 * IPFS metadata fetching and enrichment
 */

import { workerLogger } from '../../logging/index.js';
import {
  getOptionalIpfsGatewayUrl,
  getIpfsFetchTimeoutMs,
} from '../../agent/mcp/tools/shared/env.js';
import type { IpfsMetadata } from '../types.js';
import type { Helia } from '@helia/interface';

/**
 * Try to retrieve JSON from the private Helia IPFS node.
 * Returns null if Helia is unavailable or content not found.
 */
async function tryHeliaRetrieve(helia: Helia, ipfsHash: string): Promise<unknown | null> {
  try {
    const { ipfsRetrieveJson } = await import('../../ipfs/retrieve.js');
    return await ipfsRetrieveJson(helia, ipfsHash);
  } catch (err: any) {
    workerLogger.debug({ error: err?.message }, 'Helia retrieval failed, falling back to HTTP gateway');
    return null;
  }
}

/**
 * Fetch IPFS metadata — tries private Helia node first, then HTTP gateway fallback.
 */
export async function fetchIpfsMetadata(ipfsHash?: string, helia?: Helia): Promise<IpfsMetadata | null> {
  if (!ipfsHash) return null;
  try {
    let json: any;

    // Try private IPFS network first
    if (helia) {
      const heliaResult = await tryHeliaRetrieve(helia, ipfsHash);
      if (heliaResult !== null) {
        workerLogger.info({ hash: ipfsHash }, 'IPFS metadata retrieved from private network');
        json = heliaResult;
      }
    }

    // Fall back to HTTP gateway
    if (!json) {
      const hash = String(ipfsHash).replace(/^0x/, '');
      const gatewayBase = getOptionalIpfsGatewayUrl() || 'https://gateway.autonolas.tech/ipfs/';
      const url = gatewayBase.endsWith('/') ? `${gatewayBase}${hash}` : `${gatewayBase}/${hash}`;

      const timeoutMs = getIpfsFetchTimeoutMs() ?? 7000;
      workerLogger.info({ url, hash, timeout: timeoutMs }, 'Fetching IPFS metadata from HTTP gateway');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(timer);

      workerLogger.info({ status: res.status, statusText: res.statusText }, 'IPFS fetch response');

      if (!res.ok) {
        workerLogger.warn({ status: res.status, statusText: res.statusText, url }, 'IPFS fetch returned non-OK status');
        return null;
      }

      json = await res.json();
    }
    
    // Blueprint is at root level (new architecture)
    // Fall back to additionalContext.blueprint for backward compatibility
    // Fall back to prompt for legacy jobs
    const blueprint = json?.blueprint 
      ? String(json.blueprint) 
      : (json?.additionalContext?.blueprint 
          ? String(json.additionalContext.blueprint) 
          : (json?.prompt || json?.input || undefined));
    
    const enabledTools = Array.isArray(json?.enabledTools) ? json.enabledTools : undefined;
    const tools = Array.isArray(json?.tools) ? json.tools : undefined;
    const sourceRequestId = json?.sourceRequestId ? String(json.sourceRequestId) : undefined;
    const sourceJobDefinitionId = json?.sourceJobDefinitionId ? String(json.sourceJobDefinitionId) : undefined;
    const workstreamId = json?.workstreamId ? String(json.workstreamId) : undefined;
    const additionalContext = json?.additionalContext || undefined;
    const jobName = json?.jobName ? String(json.jobName) : undefined;
    const jobDefinitionId = json?.jobDefinitionId ? String(json.jobDefinitionId) : undefined;
    const codeMetadata = json?.codeMetadata && typeof json.codeMetadata === 'object'
      ? (json.codeMetadata as any)
      : undefined;
    const model = json?.model ? String(json.model) : undefined;
    const dependencies = Array.isArray(json?.dependencies) 
      ? json.dependencies 
      : (Array.isArray(json?.additionalContext?.dependencies) 
          ? json.additionalContext.dependencies 
          : undefined);
    const lineage = json?.lineage && typeof json.lineage === 'object'
      ? {
          dispatcherRequestId: json.lineage.dispatcherRequestId ? String(json.lineage.dispatcherRequestId) : undefined,
          dispatcherJobDefinitionId: json.lineage.dispatcherJobDefinitionId ? String(json.lineage.dispatcherJobDefinitionId) : undefined,
          parentDispatcherRequestId: json.lineage.parentDispatcherRequestId ? String(json.lineage.parentDispatcherRequestId) : undefined,
          dispatcherBranchName: json.lineage.dispatcherBranchName ? String(json.lineage.dispatcherBranchName) : undefined,
          dispatcherBaseBranch: json.lineage.dispatcherBaseBranch ? String(json.lineage.dispatcherBaseBranch) : undefined,
        }
      : undefined;

    // Template ID for tracking x402 template executions
    const templateId = json?.templateId ? String(json.templateId) : undefined;
    
    // OutputSpec for structured result extraction (passthrough from x402 gateway)
    const outputSpec = json?.outputSpec && typeof json.outputSpec === 'object'
      ? json.outputSpec
      : undefined;

    // Cyclic flag for continuous operation
    const cyclic = json?.cyclic === true;

    return {
      blueprint,
      enabledTools,
      tools,
      sourceRequestId,
      sourceJobDefinitionId,
      workstreamId,
      additionalContext,
      jobName,
      jobDefinitionId,
      codeMetadata,
      model,
      dependencies,
      lineage,
      templateId,
      outputSpec,
      cyclic,
    };
  } catch (e: any) {
    workerLogger.warn({ error: e?.message || String(e) }, 'Failed to fetch IPFS metadata; proceeding without it');
    return null;
  }
}
