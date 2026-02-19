/**
 * Dispatch Core — shared "post to marketplace" logic.
 *
 * Used by:
 *  - dispatch_new_job  (MCP tool, agent-initiated)
 *  - ventureDispatch   (worker, schedule-initiated)
 *
 * This module owns the credential-loading + marketplaceInteract call so that
 * callers only need to worry about building the IPFS payload.
 */

import { buildIpfsPayload, type BuildIpfsPayloadOptions, type BuildIpfsPayloadResult } from './ipfs-payload-builder.js';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
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
 * Loads mech credentials from the operate profile and calls marketplaceInteract
 * with postOnly: true.
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

  // 3. Load credentials
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

  // 4. Select a random staked mech for fair distribution
  const priorityMech = await getRandomStakedMech(mechAddress);

  // 5. Post to marketplace
  const result = await (marketplaceInteract as any)({
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

  // 5. Normalize request IDs
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
