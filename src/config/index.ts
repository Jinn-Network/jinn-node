/**
 * Canonical configuration module for Jinn Mech Worker.
 *
 * SINGLE SOURCE OF TRUTH — clean break, no legacy getters.
 *
 * Usage:
 *   import { config, secrets } from '../config/index.js';
 *   config.chain.rpcUrl        // string
 *   config.worker.pollBaseMs   // number
 *   secrets.operatePassword    // string | undefined
 *
 * Job context:
 *   import { getJobContext, setJobContext, clearJobContext } from '../config/index.js';
 *
 * Architecture:
 *   jinn.yaml → env var overrides → Zod validation → frozen typed singleton
 *   Secrets stay in .env. Runtime context (JINN_CTX_*) is in-memory.
 */

// ---------------------------------------------------------------------------
// Bootstrap: load .env before anything else
// ---------------------------------------------------------------------------
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __here = path.dirname(fileURLToPath(import.meta.url));
const __repoRoot = path.resolve(__here, '../..');

// Load .env idempotently (same pattern as old env/index.ts)
if (process.env.__ENV_LOADED !== '1') {
  try {
    const rootEnvPath = path.join(__repoRoot, '.env');
    try {
      dotenv.config({ path: rootEnvPath, override: false });
    } catch { /* .env missing is OK */ }

    // In test mode, also load .env.test
    if (process.env.VITEST === 'true') {
      const testEnvPath = path.join(__repoRoot, '.env.test');
      try {
        dotenv.config({ path: testEnvPath, override: true });
      } catch { /* .env.test missing is OK */ }
    }

    process.env.__ENV_LOADED = '1';
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------
import { loadNodeConfig, type NodeConfig, type FrozenNodeConfig } from './loader.js';
import { loadSecrets, type Secrets } from './secrets.js';

export { type NodeConfig, type FrozenNodeConfig } from './loader.js';
export { type Secrets } from './secrets.js';
export { type WorkerMechFilterMode } from './schema.js';
export {
  getJobContext,
  setJobContext,
  clearJobContext,
  snapshotJobContext,
  restoreJobContext,
  writeContextToEnv,
  readContextFromEnv,
  type JobContext,
} from './context.js';

// ---------------------------------------------------------------------------
// Singleton instances — initialized on first import
// ---------------------------------------------------------------------------

/** Frozen, typed configuration loaded from jinn.yaml + env overrides. */
export const config: FrozenNodeConfig = loadNodeConfig();

/** Secrets loaded from .env (API keys, passwords — never in YAML). */
export const secrets: Secrets = loadSecrets();
