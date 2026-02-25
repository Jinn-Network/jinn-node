/**
 * Venture Dispatch — dispatch jobs from workstream templates.
 *
 * Called by the venture watcher when a schedule entry is due.
 * Loads the workstream template from the `templates` table,
 * builds the IPFS payload, and posts to the marketplace.
 */

import { randomUUID } from 'node:crypto';
import { workerLogger } from '../../logging/index.js';
import { getTemplate } from '../../scripts/templates/crud.js';
import { buildIpfsPayload } from '../../agent/shared/ipfs-payload-builder.js';
import { extractToolPolicyFromBlueprint } from '../../shared/template-tools.js';
import { extractSchemaEnvVars } from '../../shared/job-env.js';
import { getMechAddress, getServicePrivateKey, getMechChainConfig } from '../../env/operate-profile.js';
import { getRequiredRpcUrl } from '../../agent/mcp/tools/shared/env.js';
import { getRandomStakedMech } from '../filters/stakingFilter.js';
import type { Venture } from '../../data/ventures.js';
import type { ScheduleEntry } from '../../data/types/scheduleEntry.js';

type DispatchFromTemplateOptions = {
  /**
   * Optional deterministic job definition ID.
   * If omitted, a random UUID is generated (legacy behavior).
   */
  jobDefinitionId?: string;
};

/**
 * Dispatch a finite workstream from a template + venture schedule entry.
 */
export async function dispatchFromTemplate(
  venture: Venture,
  entry: ScheduleEntry,
  options?: DispatchFromTemplateOptions,
): Promise<{ requestIds: string[] }> {
  // 1. Load workstream template from templates table
  const template = await getTemplate(entry.templateId);
  if (!template) {
    throw new Error(`Template not found: ${entry.templateId}`);
  }

  // 2. Merge input: entry.input provides runtime overrides (+ input_schema defaults)
  const mergedInput = template.input_schema
    ? { ...extractDefaults(template.input_schema as Record<string, any>), ...entry.input }
    : (entry.input || {});

  // 2b. Extract env vars from input_schema envVar mappings
  const extractedEnv = template.input_schema
    ? extractSchemaEnvVars(template.input_schema as Record<string, any>, mergedInput, 'inputSchema.properties')
    : undefined;

  // Merge: schema-extracted base, explicit entry.input.env overrides
  const mergedEnv = (extractedEnv || mergedInput.env)
    ? { ...extractedEnv, ...(mergedInput.env || {}) }
    : undefined;

  if (extractedEnv) {
    workerLogger.info(
      { ventureId: venture.id, templateId: template.id, envKeys: Object.keys(extractedEnv) },
      'Venture dispatch: extracted env vars from input schema'
    );
  }

  // 3. Build blueprint with substitution
  const blueprintObj = typeof template.blueprint === 'string'
    ? JSON.parse(template.blueprint)
    : template.blueprint;

  // Substitute {{variables}} in blueprint with merged input
  const substitutedBlueprint = deepSubstitute(blueprintObj, mergedInput);
  const blueprintStr = JSON.stringify(substitutedBlueprint);

  // 4. Extract venture invariants (FLOOR/CEILING/RANGE) for context
  const ventureBlueprint = venture.blueprint as any;
  const ventureInvariants = Array.isArray(ventureBlueprint?.invariants)
    ? ventureBlueprint.invariants.filter((inv: any) =>
        inv.type === 'FLOOR' || inv.type === 'CEILING' || inv.type === 'RANGE'
      )
    : [];

  // 5. Build venture context for the agent
  const ventureContext: Record<string, any> = {
    ventureId: venture.id,
    ventureName: venture.name,
    ventureInvariants,
  };

  // 6. Extract tools from template
  const toolPolicy = extractToolPolicyFromBlueprint(substitutedBlueprint);
  const enabledTools = toolPolicy.availableTools.length > 0
    ? toolPolicy.availableTools
    : (Array.isArray(template.enabled_tools) ? template.enabled_tools : []);

  // 7. Generate a unique job definition ID (or use deterministic override)
  const jobDefinitionId = options?.jobDefinitionId || randomUUID();
  const jobName = entry.label
    ? `${venture.name} — ${entry.label}`
    : `${venture.name} — ${template.name}`;

  workerLogger.info(
    { ventureId: venture.id, templateId: template.id, jobName, jobDefinitionId },
    'Venture dispatch: posting to marketplace'
  );

  // 8. Build IPFS payload
  const buildResult = await buildIpfsPayload({
    blueprint: blueprintStr,
    jobName,
    jobDefinitionId,
    enabledTools,
    cyclic: false,
    ventureId: venture.id,
    templateId: template.id,
    skipBranch: true,
    additionalContextOverrides: {
      env: mergedEnv,
    },
  });
  const { ipfsJsonContents } = buildResult;

  // 9. Apply venture context transform to payload
  if (ipfsJsonContents.length > 0) {
    const payload = ipfsJsonContents[0];

    // Inject ventureContext into additionalContext
    if (payload.additionalContext) {
      payload.additionalContext.ventureContext = ventureContext;
    } else {
      payload.additionalContext = { ventureContext };
    }

    // Inject model preference from schedule entry input
    if (mergedInput.model) {
      payload.additionalContext = payload.additionalContext || {};
      payload.additionalContext.model = mergedInput.model;
    }

    // Include outputSpec from template if available
    if (template.output_spec && typeof template.output_spec === 'object') {
      payload.outputSpec = template.output_spec;
    }
  }

  // 10. Post to marketplace directly with worker credentials
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

  const result = await (marketplaceInteract as any)({
    prompts: [blueprintStr],
    priorityMech,
    tools: enabledTools,
    ipfsJsonContents,
    chainConfig,
    keyConfig: { source: 'value', value: privateKey },
    postOnly: true,
    responseTimeout: 300,
    rpcHttpUrl,
  });

  // 11. Normalize request IDs
  const rawIds = result?.request_ids ?? result?.requestIds ?? [];
  const requestIds: string[] = Array.isArray(rawIds) ? rawIds.map(String) : [];

  workerLogger.info(
    { ventureId: venture.id, templateId: template.id, requestIds },
    'Venture dispatch: marketplace request posted'
  );

  return { requestIds };
}

/**
 * Extract default values from a JSON Schema input_schema.
 */
function extractDefaults(inputSchema: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  if (inputSchema.properties) {
    for (const [key, spec] of Object.entries(inputSchema.properties as Record<string, any>)) {
      if (spec.default !== undefined) result[key] = spec.default;
    }
  }
  return result;
}

/**
 * Recursively substitute {{variable}} placeholders in an object.
 */
function deepSubstitute(obj: any, input: Record<string, any>): any {
  if (typeof obj === 'string') {
    return obj.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path) => {
      const value = resolvePath(input, path);
      if (value === undefined) return _match;
      if (Array.isArray(value)) return value.join('\n');
      return String(value);
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(item => deepSubstitute(item, input));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepSubstitute(value, input);
    }
    return result;
  }
  return obj;
}

function resolvePath(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}
