/**
 * Venture Dispatch — dispatch jobs from venture templates.
 *
 * Called by the venture watcher when a schedule entry is due.
 * Loads the venture template from the `venture_templates` table,
 * builds the IPFS payload, and posts to the marketplace.
 */

import { randomUUID } from 'node:crypto';
import { workerLogger } from '../../logging/index.js';
import { getVentureTemplate } from '../../data/ventureTemplates.js';
import { getTemplate } from '../../scripts/templates/crud.js';
import { dispatchToMarketplace } from '../../agent/shared/dispatch-core.js';
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
  // 1. Load template — try venture_templates first, fall back to shared templates
  const ventureTemplate = await getVentureTemplate(entry.templateId);
  const sharedTemplate = ventureTemplate ? null : await getTemplate(entry.templateId);
  const template = ventureTemplate ?? sharedTemplate;
  if (!template) {
    throw new Error(`Template not found in venture_templates or templates: ${entry.templateId}`);
  }

  // 2. Merge input: entry.input provides runtime overrides (+ input_schema defaults for shared templates)
  const mergedInput = sharedTemplate?.input_schema
    ? { ...extractDefaults(sharedTemplate.input_schema as Record<string, any>), ...entry.input }
    : (entry.input || {});

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

  // 7. Generate a unique job definition ID
  const jobDefinitionId = randomUUID();
  const jobName = entry.label
    ? `${venture.name} — ${entry.label}`
    : `${venture.name} — ${template.name}`;

  workerLogger.info(
    { ventureId: venture.id, templateId: template.id, jobName, jobDefinitionId },
    'Venture dispatch: posting to marketplace'
  );

  // 8. Dispatch via shared core with payload transform for venture context
  const result = await dispatchToMarketplace({
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
    transformPayload: (payload) => {
      // Inject ventureContext into additionalContext
      if (payload.additionalContext) {
        payload.additionalContext.ventureContext = ventureContext;
      } else {
        payload.additionalContext = { ventureContext };
      }

      // Inject model preference from venture template
      if (ventureTemplate?.model) {
        payload.additionalContext = payload.additionalContext || {};
        payload.additionalContext.model = ventureTemplate.model;
      }

      // Include outputSpec from shared templates if available
      if (sharedTemplate?.output_spec && typeof sharedTemplate.output_spec === 'object') {
        payload.outputSpec = sharedTemplate.output_spec;
      }

      return payload;
    },
  });

  workerLogger.info(
    { ventureId: venture.id, templateId: template.id, requestIds: result.requestIds },
    'Venture dispatch: marketplace request posted'
  );

  return { requestIds: result.requestIds };
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
