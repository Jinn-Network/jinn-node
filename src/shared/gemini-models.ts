/**
 * Utilities for normalizing Gemini model names across dispatch and execution.
 *
 * Context:
 * - Gemini 3 models are exposed as preview variants (e.g., gemini-3-pro-preview).
 * - Some callers (or legacy jobs) may specify non-preview names like gemini-3-pro,
 *   which can produce 404 errors from the Gemini API / Gemini CLI.
 */

export const DEFAULT_WORKER_MODEL = 'gemini-3-flash';

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
  'gemini-2.0-flash-thinking-exp-1219': 'gemini-3-flash',
  'gemini-2.0-flash-thinking-exp': 'gemini-3-flash',
  'gemini-2.0-flash-exp': 'gemini-3-flash',
  // Gemini 2.0 Flash variants — removed from Google API as of Feb 2026
  'gemini-2.0-flash-001': 'gemini-3-flash',
  'gemini-2.0-flash': 'gemini-3-flash',
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
  // Gemini 2.0 Flash variants — removed from Google API as of Feb 2026
  'gemini-2.0-flash-001',
  'gemini-2.0-flash',
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

function isExperimentalModel(model: string): boolean {
  // These models are commonly suggested by upstream LLMs but often 404 in Gemini CLI/API.
  // Treat them as disallowed unless explicitly allowlisted by policy.
  return model.includes('-exp');
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

export type GeminiModelPolicy = {
  /**
   * If non-empty, the requested model must be in this allowlist (after normalization).
   * If empty/undefined, any non-deprecated model is allowed.
   */
  allowedModels?: string[] | null;
  /**
   * Fallback/default model when requested model is empty or disallowed.
   */
  defaultModel?: string | null;
};

export type GeminiModelSelection = {
  requested: string;
  normalizedRequested: string;
  selected: string;
  changed: boolean;
  reason: 'empty_fallback' | 'normalized' | 'policy_fallback' | 'deprecated_fallback';
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

function normalizeAllowlist(allowedModels: string[], defaultModel: string): string[] {
  // Preserve order but normalize names so comparisons are stable (preview aliases, strip "models/", etc).
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const m of allowedModels) {
    if (typeof m !== 'string') continue;
    const n = normalizeGeminiModel(m, defaultModel).normalized;
    if (!validateModelAllowed(n).ok) continue;
    if (!seen.has(n)) {
      seen.add(n);
      normalized.push(n);
    }
  }
  return normalized;
}

/**
 * Select the effective Gemini model to run under a model policy.
 *
 * Behavior:
 * - Empty requested model uses policy default (or worker default).
 * - Deprecated/experimental models fall back to policy default.
 * - If allowlist is present, models outside it fall back to policy default.
 */
export function selectGeminiModelWithPolicy(
  requestedModel: string | null | undefined,
  policy: GeminiModelPolicy | null | undefined,
  workerDefaultModel: string = DEFAULT_WORKER_MODEL,
): GeminiModelSelection {
  const policyDefaultRaw = (policy?.defaultModel ?? '').trim();
  let policyDefault = normalizeGeminiModel(
    policyDefaultRaw.length > 0 ? policyDefaultRaw : workerDefaultModel,
    workerDefaultModel,
  ).normalized;
  if (!validateModelAllowed(policyDefault).ok || isExperimentalModel(policyDefault)) {
    policyDefault = normalizeGeminiModel(workerDefaultModel, workerDefaultModel).normalized;
  }

  const requestedRaw = (requestedModel ?? '').trim();
  if (requestedRaw.length === 0) {
    return {
      requested: policyDefault,
      normalizedRequested: policyDefault,
      selected: policyDefault,
      changed: true,
      reason: 'empty_fallback',
    };
  }

  const normalizedRequested = normalizeGeminiModel(requestedRaw, policyDefault).normalized;

  const allowedModels = Array.isArray(policy?.allowedModels) ? policy!.allowedModels!.filter((m) => typeof m === 'string') : [];
  const normalizedAllowed = allowedModels.length > 0 ? normalizeAllowlist(allowedModels, policyDefault) : [];
  const allowedSet = new Set(normalizedAllowed);

  // Block experimental models unless explicitly allowlisted.
  if (isExperimentalModel(normalizedRequested) && !allowedSet.has(normalizedRequested)) {
    const fallback = allowedSet.has(policyDefault) ? policyDefault : (normalizedAllowed[0] ?? policyDefault);
    return {
      requested: requestedRaw,
      normalizedRequested,
      selected: fallback,
      changed: true,
      reason: 'policy_fallback',
    };
  }

  const validation = validateModelAllowed(normalizedRequested);
  if (!validation.ok) {
    return {
      requested: requestedRaw,
      normalizedRequested,
      selected: policyDefault,
      changed: true,
      reason: 'deprecated_fallback',
    };
  }

  if (normalizedAllowed.length > 0) {
    if (!allowedSet.has(normalizedRequested)) {
      // Ensure we always pick something from the allowlist if possible.
      const fallback = allowedSet.has(policyDefault) ? policyDefault : (normalizedAllowed[0] ?? policyDefault);
      return {
        requested: requestedRaw,
        normalizedRequested,
        selected: fallback,
        changed: true,
        reason: 'policy_fallback',
      };
    }
  }

  return {
    requested: requestedRaw,
    normalizedRequested,
    selected: normalizedRequested,
    changed: normalizedRequested !== requestedRaw,
    reason: 'normalized',
  };
}
