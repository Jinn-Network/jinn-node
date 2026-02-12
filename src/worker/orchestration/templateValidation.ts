/**
 * Dynamic template validation for worker job pickup.
 *
 * Replaces the static VENTURE_TEMPLATE_IDS env var allowlist with a
 * Supabase-backed check: a template is authorized if it exists in the
 * templates table with status='published' AND olas_agent_id IS NOT NULL.
 *
 * Results are cached for 5 minutes. On Supabase error, falls back to
 * VENTURE_TEMPLATE_IDS env var if set (graceful degradation).
 */

import { workerLogger } from '../../logging/index.js';

// Cache entry: valid flag + timestamp
interface CacheEntry {
  valid: boolean;
  checkedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry>();

/**
 * Parse VENTURE_TEMPLATE_IDS env var (legacy fallback).
 */
function getLegacyAllowlist(): string[] {
  const raw = process.env.VENTURE_TEMPLATE_IDS;
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(s => String(s).trim()).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }

  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Validate a template ID against Supabase.
 *
 * Returns true if the template is published and has an OLAS agent ID.
 * On Supabase error, falls back to VENTURE_TEMPLATE_IDS env var if set.
 */
export async function validateTemplateAuthorized(templateId: string): Promise<boolean> {
  // Check cache first
  const cached = cache.get(templateId);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.valid;
  }

  try {
    // Lazy import to avoid circular deps and to only load when needed
    const { supabase } = await import('../../agent/mcp/tools/shared/supabase.js');

    const { data, error } = await supabase
      .from('templates')
      .select('id, status, olas_agent_id')
      .eq('id', templateId)
      .single();

    if (error) {
      // PGRST116 = row not found — that's a valid "not authorized" result
      if (error.code === 'PGRST116') {
        cache.set(templateId, { valid: false, checkedAt: Date.now() });
        return false;
      }
      throw error;
    }

    const valid = data?.status === 'published' && data?.olas_agent_id != null;
    cache.set(templateId, { valid, checkedAt: Date.now() });

    workerLogger.debug({
      templateId,
      status: data?.status,
      olasAgentId: data?.olas_agent_id,
      valid,
    }, 'Template validation result');

    return valid;
  } catch (err: any) {
    workerLogger.warn({
      templateId,
      error: err?.message || String(err),
    }, 'Supabase template validation failed; falling back to VENTURE_TEMPLATE_IDS');

    // Graceful degradation: fall back to env var allowlist
    const allowlist = getLegacyAllowlist();
    if (allowlist.length > 0) {
      const valid = allowlist.includes(templateId);
      // Don't cache fallback results (we want to retry Supabase next time)
      return valid;
    }

    // No fallback available — reject to be safe
    return false;
  }
}
