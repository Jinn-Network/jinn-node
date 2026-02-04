/**
 * Utilities for normalizing Gemini model names across dispatch and execution.
 *
 * Context:
 * - Gemini 3 models are exposed as preview variants (e.g., gemini-3-pro-preview).
 * - Some callers (or legacy jobs) may specify non-preview names like gemini-3-pro,
 *   which can produce 404 errors from the Gemini API / Gemini CLI.
 */

export const DEFAULT_WORKER_MODEL = 'auto-gemini-3';

const MODELS_PREFIX = 'models/';

/**
 * Map legacy / commonly-mistyped model names to the currently valid equivalents.
 * Keep this intentionally small and explicit.
 */
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3-pro-latest': 'gemini-3-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3-flash-latest': 'gemini-3-flash-preview',
  // Deprecated experimental models - agent LLMs sometimes suggest these from training data
  'gemini-2.0-flash-thinking-exp-1219': 'auto-gemini-3',
  'gemini-2.0-flash-thinking-exp': 'auto-gemini-3',
  'gemini-2.0-flash-exp': 'auto-gemini-3',
};

/**
 * Models that have been deprecated or removed from the Gemini API.
 * These will be rejected at dispatch time with a helpful suggestion.
 */
const DEPRECATED_MODELS = new Set([
  'gemini-2.0-flash-thinking-exp-1219',
  'gemini-2.0-flash-thinking-exp-01-21',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.0-flash-thinking',
  // Add other deprecated models as they are removed
]);

/**
 * Check if a model matches any deprecated pattern (e.g., gemini-2.0-flash-thinking-exp-*)
 */
function matchesDeprecatedPattern(model: string): boolean {
  // All gemini-2.0-flash-thinking experimental models are deprecated
  if (model.startsWith('gemini-2.0-flash-thinking')) {
    return true;
  }
  return false;
}

export type ModelValidationResult = {
  ok: boolean;
  reason?: string;
  suggestion?: string;
};

/**
 * Check if a model is valid and not deprecated.
 * Deprecated models are rejected with a suggestion for a valid alternative.
 */
export function validateModelAllowed(model: string): ModelValidationResult {
  const stripped = stripModelsPrefix(model.trim());

  // Check if the model or its normalized form is deprecated (exact match or pattern)
  if (DEPRECATED_MODELS.has(model) || DEPRECATED_MODELS.has(stripped) || matchesDeprecatedPattern(stripped)) {
    return {
      ok: false,
      reason: `Model '${model}' is deprecated and no longer available`,
      suggestion: DEFAULT_WORKER_MODEL,
    };
  }

  return { ok: true };
}

export type GeminiModelNormalization = {
  requested: string;
  normalized: string;
  changed: boolean;
  reason?: string;
};

function stripModelsPrefix(model: string): string {
  return model.startsWith(MODELS_PREFIX) ? model.slice(MODELS_PREFIX.length) : model;
}

/**
 * Normalize a Gemini model name for Gemini CLI usage.
 *
 * This:
 * - trims whitespace
 * - removes a leading "models/" prefix if present
 * - upgrades known Gemini 3 legacy names to their preview equivalents
 * - falls back to a safe default when the input is empty
 */
export function normalizeGeminiModel(
  model: string | null | undefined,
  defaultModel: string = DEFAULT_WORKER_MODEL,
): GeminiModelNormalization {
  const requestedRaw = (model ?? '').trim();
  const requested = requestedRaw.length > 0 ? requestedRaw : defaultModel;
  const stripped = stripModelsPrefix(requested);
  const aliasTarget = LEGACY_MODEL_ALIASES[stripped];

  if (aliasTarget) {
    return {
      requested,
      normalized: aliasTarget,
      changed: aliasTarget !== requested,
      reason: `legacy_alias:${stripped}`,
    };
  }

  if (stripped !== requested) {
    return {
      requested,
      normalized: stripped,
      changed: true,
      reason: 'strip_models_prefix',
    };
  }

  return {
    requested,
    normalized: stripped,
    changed: false,
  };
}

