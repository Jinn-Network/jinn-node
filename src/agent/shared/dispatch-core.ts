/**
 * Dispatch Core — shared "post to marketplace" logic.
 *
 * Used by:
 *  - dispatch_new_job  (MCP tool, agent-initiated → routes through signing proxy)
 *  - ventureDispatch   (worker, schedule-initiated → calls marketplaceInteract directly)
 *
 * When AGENT_SIGNING_PROXY_URL is set (agent context), dispatch routes through
 * the signing proxy so the agent process never touches private keys.
 * When not set (worker context), falls back to direct marketplaceInteract.
 */

import { buildIpfsPayload, type BuildIpfsPayloadOptions, type BuildIpfsPayloadResult } from './ipfs-payload-builder.js';
import { proxyDispatch, type DispatchResult } from './signing-proxy-client.js';
import { getMechAddress, getServicePrivateKey, getMechChainConfig } from '../../env/operate-profile.js';
import { getRequiredRpcUrl } from '../mcp/tools/shared/env.js';
import { getRandomStakedMech } from '../../worker/filters/stakingFilter.js';

export interface DispatchCoreParams extends BuildIpfsPayloadOptions {
  /**
   * Response timeout for marketplace request (seconds). Default 300.
   */
  responseTimeout?: number;

  /**
   * Optional transform applied to ipfsJsonContents[0] before posting.
   * Use this to inject additional context (e.g. ventureContext, outputSpec)
   * without duplicating the build+post flow.
   */
  transformPayload?: (payload: any) => any;
}

export interface DispatchCoreResult {
  /** On-chain request IDs returned by the marketplace */
  requestIds: string[];
  /** The job definition UUID used */
  jobDefinitionId: string;
  /** Raw marketplace result for callers that need extra fields */
  rawResult: any;
  /** IPFS payload build result (includes branchResult, codeMetadata) */
  buildResult: BuildIpfsPayloadResult;
}

/**
 * Build an IPFS payload and post it to the on-chain marketplace.
 *
 * Routes through the signing proxy when AGENT_SIGNING_PROXY_URL is set (agent context),
 * otherwise falls back to direct marketplaceInteract (worker context).
 */
export async function dispatchToMarketplace(params: DispatchCoreParams): Promise<DispatchCoreResult> {
  const { responseTimeout = 300, transformPayload, ...buildOpts } = params;

  // 1. Build IPFS payload
  const buildResult = await buildIpfsPayload(buildOpts);
  let { ipfsJsonContents } = buildResult;

  // 2. Apply optional transform (e.g. inject ventureContext)
  if (transformPayload && ipfsJsonContents.length > 0) {
    ipfsJsonContents[0] = transformPayload(ipfsJsonContents[0]);
  }

  // 3. Determine dispatch path
  const useProxy = !!process.env.AGENT_SIGNING_PROXY_URL;
  let result: any;

  if (useProxy) {
    // Agent context: route through signing proxy — private key never leaves worker process
    result = await proxyDispatch({
      prompts: [buildOpts.blueprint],
      tools: buildOpts.enabledTools || [],
      ipfsJsonContents,
      postOnly: true,
      responseTimeout,
    });
  } else {
    // Worker context: direct marketplaceInteract with local credentials
    const { marketplaceInteract } = await import('@jinn-network/mech-client-ts/dist/marketplace_interact.js');

    const mechAddress = getMechAddress();
    const privateKey = getServicePrivateKey();
    const chainConfig = getMechChainConfig();
    const rpcHttpUrl = getRequiredRpcUrl();

    if (!mechAddress) {
      throw new Error('Service target mech address not configured. Check .operate service config (MECH_TO_CONFIG).');
    }

    if (!privateKey) {
      throw new Error('Service agent private key not found. Check .operate/keys directory.');
    }

    const priorityMech = await getRandomStakedMech(mechAddress);

    result = await (marketplaceInteract as any)({
      prompts: [buildOpts.blueprint],
      priorityMech,
      tools: buildOpts.enabledTools || [],
      ipfsJsonContents,
      chainConfig,
      keyConfig: { source: 'value', value: privateKey },
      postOnly: true,
      responseTimeout,
      rpcHttpUrl,
    });
  }

  // 4. Normalize request IDs
  const rawIds = result?.request_ids ?? result?.requestIds ?? [];
  const requestIds = Array.isArray(rawIds)
    ? rawIds.map((id: any) => String(id))
    : [];

  return {
    requestIds,
    jobDefinitionId: buildOpts.jobDefinitionId,
    rawResult: result,
    buildResult,
  };
}
