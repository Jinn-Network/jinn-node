/**
 * IPFS metadata fetching and enrichment
 */

import { workerLogger } from '../../logging/index.js';
import type { IpfsMetadata } from '../types.js';
import type { Helia } from '@helia/interface';

/**
 * Fetch IPFS metadata from the private Helia node.
 *
 * NOTE: This does NOT fall back to HTTP gateways. The private IPFS network
 * is the sole retrieval path for metadata. If Helia cannot find the content,
 * this returns null.
 */
export async function fetchIpfsMetadata(ipfsHash?: string, helia?: Helia): Promise<IpfsMetadata | null> {
  if (!ipfsHash) return null;
  if (!helia) {
    workerLogger.warn({ hash: ipfsHash }, 'Cannot fetch IPFS metadata — Helia node not available');
    return null;
  }
  try {
    const { ipfsRetrieveJson } = await import('../../ipfs/retrieve.js');
    const json = await ipfsRetrieveJson(helia, ipfsHash) as any;

    if (!json) {
      workerLogger.warn({ hash: ipfsHash }, 'IPFS metadata not found in private network');
      return null;
    }

    workerLogger.info({ hash: ipfsHash }, 'IPFS metadata retrieved from private network');

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
