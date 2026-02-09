/**
 * Venture Dispatch — dispatch finite workstreams from templates.
 *
 * Called by the venture watcher when a schedule entry is due.
 * Loads the template from Supabase, merges input, builds the IPFS payload,
 * and posts to the marketplace.
 */

import { randomUUID } from 'node:crypto';
import { workerLogger } from '../../logging/index.js';
import { getTemplate } from '../../scripts/templates/crud.js';
import { buildIpfsPayload } from '../../agent/shared/ipfs-payload-builder.js';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
import { getMechAddress, getServicePrivateKey, getMechChainConfig } from '../../env/operate-profile.js';
import { getRequiredRpcUrl } from '../../agent/mcp/tools/shared/env.js';
import { ensureUniversalTools } from '../../agent/toolPolicy.js';
import { extractToolPolicyFromBlueprint } from '../../shared/template-tools.js';
import type { Venture } from '../../data/ventures.js';
import type { ScheduleEntry } from '../../data/types/scheduleEntry.js';

/**
 * Dispatch a finite workstream from a template + venture schedule entry.
 */
export async function dispatchFromTemplate(
  venture: Venture,
  entry: ScheduleEntry,
): Promise<{ requestIds: string[] }> {
  // 1. Load template from Supabase
  const template = await getTemplate(entry.templateId);
  if (!template) {
    throw new Error(`Template not found: ${entry.templateId}`);
  }

  // 2. Merge input: entry.input overrides template input_schema defaults
  const mergedInput = mergeInput(
    template.input_schema as Record<string, any> || {},
    entry.input || {}
  );

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
    : (template.enabled_tools || []);

  // 7. Generate a unique job definition ID
  const jobDefinitionId = randomUUID();
  const jobName = entry.label
    ? `${venture.name} — ${entry.label}`
    : `${venture.name} — ${template.name}`;

  // 8. Build IPFS payload
  const { ipfsJsonContents } = await buildIpfsPayload({
    blueprint: blueprintStr,
    jobName,
    jobDefinitionId,
    enabledTools,
    cyclic: false,
    ventureId: venture.id,
    templateId: template.id,
    skipBranch: true,
    additionalContextOverrides: {
      env: mergedInput.env || undefined,
    },
  });

  // Inject ventureContext into additionalContext
  if (ipfsJsonContents[0].additionalContext) {
    ipfsJsonContents[0].additionalContext.ventureContext = ventureContext;
  } else {
    ipfsJsonContents[0].additionalContext = { ventureContext };
  }

  // Include outputSpec from template if available
  if (template.output_spec && typeof template.output_spec === 'object') {
    ipfsJsonContents[0].outputSpec = template.output_spec;
  }

  // 9. Post to marketplace
  const mechAddress = getMechAddress();
  const privateKey = getServicePrivateKey();
  const chainConfig = getMechChainConfig();
  const rpcHttpUrl = getRequiredRpcUrl();

  if (!mechAddress || !privateKey) {
    throw new Error('Missing mech credentials for venture dispatch');
  }

  workerLogger.info(
    { ventureId: venture.id, templateId: template.id, jobName, jobDefinitionId },
    'Venture dispatch: posting to marketplace'
  );

  const result = await (marketplaceInteract as any)({
    prompts: [blueprintStr],
    priorityMech: mechAddress,
    tools: enabledTools,
    ipfsJsonContents,
    chainConfig,
    keyConfig: { source: 'value', value: privateKey },
    postOnly: true,
    responseTimeout: 300,
    rpcHttpUrl,
  });

  const requestIds = Array.isArray(result?.requestIds)
    ? result.requestIds.map((id: any) => String(id))
    : [];

  workerLogger.info(
    { ventureId: venture.id, templateId: template.id, requestIds },
    'Venture dispatch: marketplace request posted'
  );

  return { requestIds };
}

/**
 * Merge template input_schema defaults with schedule entry input overrides.
 */
function mergeInput(
  inputSchema: Record<string, any>,
  entryInput: Record<string, any>
): Record<string, any> {
  const result: Record<string, any> = {};

  // Extract defaults from input_schema properties
  if (inputSchema.properties) {
    for (const [key, spec] of Object.entries(inputSchema.properties as Record<string, any>)) {
      if (spec.default !== undefined) {
        result[key] = spec.default;
      }
    }
  }

  // Override with entry input
  return { ...result, ...entryInput };
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
