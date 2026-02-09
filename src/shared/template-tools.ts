import {
  EXTENSION_META_TOOLS,
  TELEGRAM_TOOLS,
  FIREFLIES_TOOLS,
  RAILWAY_TOOLS,
} from '../agent/toolPolicy.js';

export type TemplateToolSpec = {
  name: string;
  required?: boolean;
};

export interface TemplateToolPolicy {
  requiredTools: string[];
  availableTools: string[];
}

function normalizeToolName(tool: unknown): string | null {
  if (typeof tool !== 'string') {
    return null;
  }
  const trimmed = tool.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extract tool name from either string or object format.
 * Handles both "toolName" and {name: "toolName", required: true}
 */
export function extractToolName(tool: unknown): string | null {
  if (typeof tool === 'string') {
    const trimmed = tool.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (tool && typeof tool === 'object' && 'name' in tool) {
    const name = (tool as TemplateToolSpec).name;
    if (typeof name === 'string') {
      const trimmed = name.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }

  return null;
}

/**
 * Normalize array of tools (strings or objects) to string names.
 * Filters out invalid entries and corrupted data like "[object Object]".
 */
export function normalizeToolArray(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }

  const result: string[] = [];
  for (const tool of tools) {
    const name = extractToolName(tool);
    // Filter out invalid tool names and corrupted "[object Object]" strings
    // that may exist in older IPFS metadata
    if (name && name !== '[object Object]') {
      result.push(name);
    }
  }
  return result;
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/**
 * Expand meta-tools to their individual tool names.
 * This ensures validation accepts both meta-tool names and their expanded tools.
 *
 * When a template specifies a meta-tool like "workstream_analysis", agents may
 * dispatch children requesting the expanded tools (e.g., "inspect_workstream").
 * This expansion ensures those individual tools are recognized as allowed.
 */
function expandMetaTools(tools: string[]): string[] {
  const expanded: string[] = [];

  for (const tool of tools) {
    expanded.push(tool); // Keep the meta-tool name itself

    // Expand extension meta-tools (workstream_analysis, ventures_registry, etc.)
    if (tool in EXTENSION_META_TOOLS) {
      const config = EXTENSION_META_TOOLS[tool as keyof typeof EXTENSION_META_TOOLS];
      if (config?.tools) {
        expanded.push(...config.tools);
      }
    }

    // Expand other meta-tools that aren't in EXTENSION_META_TOOLS
    if (tool === 'telegram_messaging') {
      expanded.push(...TELEGRAM_TOOLS);
    }
    if (tool === 'fireflies_meetings') {
      expanded.push(...FIREFLIES_TOOLS);
    }
    if (tool === 'railway_deployment') {
      expanded.push(...RAILWAY_TOOLS);
    }
    // nano_banana: deprecated — silently ignored
  }

  return expanded;
}

export function parseAnnotatedTools(tools: unknown): TemplateToolPolicy {
  if (!Array.isArray(tools)) {
    return { requiredTools: [], availableTools: [] };
  }

  const requiredTools: string[] = [];
  const availableTools: string[] = [];

  for (const entry of tools) {
    if (typeof entry === 'string') {
      const name = normalizeToolName(entry);
      if (name) {
        availableTools.push(name);
      }
      continue;
    }

    if (entry && typeof entry === 'object') {
      const name = normalizeToolName((entry as TemplateToolSpec).name);
      if (name) {
        availableTools.push(name);
        if ((entry as TemplateToolSpec).required === true) {
          requiredTools.push(name);
        }
      }
    }
  }

  return {
    requiredTools: uniqueOrdered(requiredTools),
    availableTools: uniqueOrdered(expandMetaTools(availableTools)),
  };
}

export function buildAnnotatedTools(policy: TemplateToolPolicy): TemplateToolSpec[] {
  const requiredSet = new Set(policy.requiredTools);
  return policy.availableTools.map((name) => ({
    name,
    ...(requiredSet.has(name) ? { required: true } : {}),
  }));
}

export function extractToolPolicyFromBlueprint(blueprint: any): TemplateToolPolicy {
  const templateMeta = blueprint?.templateMeta && typeof blueprint.templateMeta === 'object'
    ? blueprint.templateMeta
    : null;

  if (templateMeta?.tools) {
    return parseAnnotatedTools(templateMeta.tools);
  }

  if (blueprint?.tools) {
    return parseAnnotatedTools(blueprint.tools);
  }

  return { requiredTools: [], availableTools: [] };
}

// ============================================================================
// Model Policy
// ============================================================================

const DEFAULT_MODEL = 'gemini-3-flash';

export interface TemplateModelPolicy {
  allowedModels: string[];  // Whitelist of valid models (empty = no restriction)
  defaultModel: string;     // Model to use when not specified
}

/**
 * Extract model policy from a blueprint/template.
 *
 * Supports multiple formats:
 * 1. Full config: { models: { allowed: [...], default: "..." } }
 * 2. Shorthand array: { models: ["model1", "model2"] } - first is default
 * 3. Legacy single: { model: "model-name" }
 *
 * Can be in templateMeta or at blueprint root (templateMeta preferred).
 */
export function extractModelPolicyFromBlueprint(blueprint: any): TemplateModelPolicy {
  const templateMeta = blueprint?.templateMeta && typeof blueprint.templateMeta === 'object'
    ? blueprint.templateMeta
    : null;

  const defaultPolicy: TemplateModelPolicy = {
    allowedModels: [],  // Empty = no restriction (any non-deprecated model allowed)
    defaultModel: DEFAULT_MODEL,
  };

  // Check templateMeta first (preferred), then blueprint root
  const source = templateMeta || blueprint;
  if (!source) {
    return defaultPolicy;
  }

  // Format 1 & 2: models field
  if (source.models) {
    // Full config: { allowed: [...], default: "..." }
    if (typeof source.models === 'object' && !Array.isArray(source.models)) {
      const modelsConfig = source.models;
      return {
        allowedModels: Array.isArray(modelsConfig.allowed)
          ? modelsConfig.allowed.filter((m: unknown) => typeof m === 'string')
          : [],
        defaultModel: typeof modelsConfig.default === 'string'
          ? modelsConfig.default
          : defaultPolicy.defaultModel,
      };
    }

    // Shorthand: just an array of allowed models (first is default)
    if (Array.isArray(source.models)) {
      const validModels = source.models.filter((m: unknown) => typeof m === 'string');
      return {
        allowedModels: validModels,
        defaultModel: validModels[0] || defaultPolicy.defaultModel,
      };
    }
  }

  // Format 3: Legacy single model field
  if (typeof source.model === 'string' && source.model.trim().length > 0) {
    const model = source.model.trim();
    return {
      allowedModels: [model],
      defaultModel: model,
    };
  }

  return defaultPolicy;
}
