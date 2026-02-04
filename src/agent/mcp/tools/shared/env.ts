/**
 * MCP tools environment configuration module
 *
 * This module re-exports configuration getters from the shared config module.
 * It provides backward compatibility for MCP tools during migration.
 *
 * New code should import directly from '../../../../config/index.js' instead.
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ============================================================================
// Re-exports from shared config module
// ============================================================================

export {
  // Core blockchain
  getRequiredRpcUrl,
  getRequiredChainId,
  getOptionalWorkerPrivateKey,
  getRequiredWorkerPrivateKey,

  // Mech service
  getOptionalMechAddress,
  getRequiredMechAddress,
  getOptionalMechSafeAddress,
  getRequiredMechSafeAddress,
  getOptionalMechMarketplaceAddress,
  getOptionalMechReclaimAfterMinutes,
  getEnableAutoRepost,
  getOptionalMechChainConfig,
  getOptionalMechTargetRequestId,

  // Ponder
  getPonderPort,
  getPonderGraphqlUrl,
  getOptionalPonderStartBlock,
  getOptionalPonderEndBlock,

  // Control API
  getOptionalControlApiUrl,
  getOptionalControlApiServiceKey,
  getUseControlApi,

  // Supabase
  getOptionalSupabaseUrl,
  getRequiredSupabaseUrl,
  getOptionalSupabaseServiceRoleKey,
  getRequiredSupabaseServiceRoleKey,

  // IPFS
  getOptionalIpfsGatewayUrl,
  getIpfsGatewayUrl,
  getOptionalIpfsFetchTimeoutMs,
  getIpfsFetchTimeoutMs,

  // LLM APIs
  getOptionalGeminiApiKey,
  getRequiredGeminiApiKey,
  getOptionalOpenAiApiKey,
  getRequiredOpenAiApiKey,

  // External services
  getOptionalGithubToken,
  getOptionalCivitaiApiKey,
  getOptionalCivitaiAirWait,
  getOptionalZoraApiKey,

  // Job context
  getOptionalJobId,
  getOptionalJobName,
  getOptionalJobDefinitionId,
  getOptionalProjectRunId,
  getOptionalProjectDefinitionId,
  getOptionalRequestId,
  getOptionalSourceEventId,
  getOptionalThreadId,
  getOptionalJobMechAddress,

  // OLAS operate
  getOptionalOperatePassword,

  // Dev/testing
  getNodeEnv,
  isTestEnv,
  getMcpDebugMechClient,
  getOptionalPlaywrightProfileDir,
  getPlaywrightHeadless,
} from '../../../../config/index.js';

// ============================================================================
// Legacy .env loader (kept for backward compatibility)
// ============================================================================

/**
 * Centralized, idempotent .env loader for the MCP server and all tools.
 *
 * Load order (first found wins):
 * 1) Explicit file via JINN_ENV_PATH
 * 2) process.cwd()/.env and up to 3 parent dirs
 * 3) __dirname/.env and up to 6 parent dirs (covers repo root when bundled)
 *
 * @deprecated .env loading now happens automatically via config/index.ts
 * This function is kept for backward compatibility during migration.
 */
export function loadEnvOnce(): void {
  console.error('[loadEnvOnce] Called. __ENV_LOADED=', process.env.__ENV_LOADED, 'MECHX_CHAIN_RPC=', process.env.MECHX_CHAIN_RPC?.slice(0, 60));
  if (process.env.__ENV_LOADED === '1') {
    console.error('[loadEnvOnce] Already loaded, returning early');
    return;
  }

  const candidates: string[] = [];

  // Detect if running in test environment (Vitest automatically sets this)
  const isTestEnv = process.env.VITEST === 'true';
  if (!process.env.RUNTIME_ENVIRONMENT) {
    process.env.RUNTIME_ENVIRONMENT = isTestEnv ? 'test' : 'default';
  }
  const runtimeMode = process.env.RUNTIME_ENVIRONMENT || 'default';
  const preserveKeys = new Set<string>();
  if (runtimeMode === 'test' || runtimeMode === 'review') {
    [
      'RPC_URL',
      'PONDER_GRAPHQL_URL',
      'PONDER_START_BLOCK',
      'PONDER_END_BLOCK',
      'MECH_RPC_HTTP_URL',
      'MECHX_CHAIN_RPC',
      'BASE_RPC_URL',
      'CONTROL_API_URL',
      'CONTROL_API_PORT',
    ]
      .forEach((key) => preserveKeys.add(key));
  }

  // Always preserve CODE_METADATA_REPO_ROOT - this enables parallel workstreams
  // with isolated repository clones (set via launch-local-arcade.ts --repo flag)
  preserveKeys.add('CODE_METADATA_REPO_ROOT');

  // 1) Explicit path override
  const explicit = process.env.JINN_ENV_PATH;
  if (explicit) {
    candidates.push(path.resolve(explicit));
  }

  // 2) From current working directory, walk up to 3 levels
  const cwd = process.cwd();
  let cur = cwd;
  for (let i = 0; i < 4; i++) {
    // In test mode, prefer .env.test over .env if present
    if (isTestEnv) {
      candidates.push(path.join(cur, '.env.test'));
    }
    candidates.push(path.join(cur, '.env'));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 3) From this file's directory, walk up to 6 levels
  // In ESM, derive __dirname from import.meta.url
  const here = path.dirname(fileURLToPath(import.meta.url));
  cur = here;
  for (let i = 0; i < 7; i++) {
    // In test mode, prefer .env.test over .env if present
    if (isTestEnv) {
      candidates.push(path.join(cur, '.env.test'));
    }
    candidates.push(path.join(cur, '.env'));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  const tried: string[] = [];
  for (const p of candidates) {
    const abs = path.resolve(p);
    if (tried.includes(abs)) continue;
    tried.push(abs);
    if (!fs.existsSync(abs)) continue;
    // Silence dotenv stdout to protect MCP stdio JSON
    const origWrite = process.stdout.write as any;
    try {
      (process.stdout as any).write = () => true;
      const preserved: Record<string, string | undefined> = {};
      for (const key of preserveKeys) {
        preserved[key] = process.env[key];
      }
      const res = dotenv.config({ path: abs, override: true });
      for (const [key, value] of Object.entries(preserved)) {
        if (value !== undefined) {
          process.env[key] = value;
        }
      }
      if (!res.error) {
        process.env.__ENV_LOADED = '1';
        return;
      }
    } finally {
      (process.stdout as any).write = origWrite;
    }
  }
}

// ============================================================================
// Legacy helpers (kept for backward compatibility)
// ============================================================================

/**
 * Legacy helper: Get optional string from environment
 * @deprecated Use getOptional*() getters from '../../../../config/index.js' instead
 */
export function envString(name: string, defaultValue?: string): string | undefined {
  // TODO(JINN-234): Migrate callers to use specific getters from config/index.ts
  const v = process.env[name];
  return v !== undefined ? v : defaultValue;
}

/**
 * Legacy helper: Get boolean from environment
 * @deprecated Use specific boolean getters from '../../../../config/index.js' instead
 */
export function envBool(name: string, defaultValue = false): boolean {
  // TODO(JINN-234): Migrate callers to use specific getters from config/index.ts
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  const val = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(val)) return true;
  if (['0', 'false', 'no', 'off'].includes(val)) return false;
  return defaultValue;
}
