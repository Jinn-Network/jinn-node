import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

// Idempotent load guard
if (process.env.__ENV_LOADED !== '1') {
  try {
    // Resolve repo root based on this file's location
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..');

    // Detect test environment (Vitest sets VITEST='true')
    const isTestEnv = process.env.VITEST === 'true';
    if (!process.env.RUNTIME_ENVIRONMENT) {
      process.env.RUNTIME_ENVIRONMENT = isTestEnv ? 'test' : 'default';
    }

    const runtimeMode = process.env.RUNTIME_ENVIRONMENT || 'default';
    const preservedKeys = new Set<string>();
    const preservedValues: Record<string, string | undefined> = {};
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
        .forEach((key) => {
          preservedKeys.add(key);
          preservedValues[key] = process.env[key];
        });
    }

    // Always preserve CODE_METADATA_REPO_ROOT - this enables parallel workstreams
    // with isolated repository clones (set via launch-local-arcade.ts --repo flag)
    if (process.env.CODE_METADATA_REPO_ROOT) {
      preservedKeys.add('CODE_METADATA_REPO_ROOT');
      preservedValues['CODE_METADATA_REPO_ROOT'] = process.env.CODE_METADATA_REPO_ROOT;
    }

    // Load base .env first
    const rootEnvPath = path.join(repoRoot, '.env');
    let parsed: Record<string, string> = {};
    try {
      const raw = readFileSync(rootEnvPath, 'utf8');
      parsed = dotenv.parse(raw);
    } catch {
      // If .env missing, keep parsed empty
      parsed = {};
    }

    // Load .env into process.env, overriding any existing values
    dotenv.config({ path: rootEnvPath, override: true });

    // In test mode, load .env.test after .env (test values override production values)
    if (isTestEnv) {
      const testEnvPath = path.join(repoRoot, '.env.test');
      try {
        const testRaw = readFileSync(testEnvPath, 'utf8');
        const testParsed = dotenv.parse(testRaw);
        // Merge test config into parsed (for enforcement logic below)
        parsed = { ...parsed, ...testParsed };
        // Load .env.test, overriding .env values
        dotenv.config({ path: testEnvPath, override: true });
      } catch {
        // .env.test missing is OK - just use .env
      }
    }

    // Enforce that only variables defined in project's .env are honored for our namespaces
    for (const [key, value] of Object.entries(preservedValues)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }

    const enforcedPrefixes = [
      'PONDER_',
      'CONTROL_API_',
      'MECH_',
      'MECHX_',
      'SUPABASE_',
      'OPENAI_',
      'GEMINI_',
      'CIVITAI_',
      'TENDERLY_',
      'PLAYWRIGHT_',
      'ZORA_',
      'OLAS_',
      'BASE_',
      'OPERATE_',
      'STAKING_',
    ];
    const enforcedSingles = new Set<string>([
      'RPC_URL',
      'CHAIN_ID',
      'ENABLE_TRANSACTION_EXECUTOR',
      'WORKER_PRIVATE_KEY',
      'ATTENDED',
    ]);

    for (const key of Object.keys(process.env)) {
      const isEnforced = enforcedPrefixes.some((p) => key.startsWith(p)) || enforcedSingles.has(key);
      if (!isEnforced) continue;

      if (preservedKeys.has(key)) {
        continue;
      }

      if (key in parsed) {
        // If the key is present in .env, use that value (local development override)
        process.env[key] = parsed[key];
      } else {
        // If the key is NOT in .env but exists in process.env, preserve it
        // This allows production environments to inject secrets without a .env file
        // The existing value in process.env is kept unchanged
      }
    }

    // RPC Consolidation: Map all RPC variables to use the single RPC_URL
    if (parsed.RPC_URL) {
      // Set fallback RPC variables to use the main RPC_URL if they're not explicitly set
      // In test/review mode, respect preserved keys to avoid overwriting dynamically-set values
      if (!parsed.MECH_RPC_HTTP_URL && !preservedKeys.has('MECH_RPC_HTTP_URL')) {
        process.env.MECH_RPC_HTTP_URL = parsed.RPC_URL;
      }
      if (!parsed.MECHX_CHAIN_RPC && !preservedKeys.has('MECHX_CHAIN_RPC')) {
        process.env.MECHX_CHAIN_RPC = parsed.RPC_URL;
      }
      if (!parsed.BASE_RPC_URL && !preservedKeys.has('BASE_RPC_URL')) {
        process.env.BASE_RPC_URL = parsed.RPC_URL;
      }
    }

    // Normalize legacy aliases so runtime code only needs RPC_URL
    const runtimeBaseRpc = process.env.BASE_RPC_URL;
    let runtimeRpcUrl = process.env.RPC_URL;
    if (!runtimeRpcUrl && runtimeBaseRpc) {
      process.env.RPC_URL = runtimeBaseRpc;
      runtimeRpcUrl = runtimeBaseRpc;
    } else if (!runtimeBaseRpc && runtimeRpcUrl) {
      process.env.BASE_RPC_URL = runtimeRpcUrl;
    } else if (runtimeRpcUrl && runtimeBaseRpc && runtimeRpcUrl !== runtimeBaseRpc) {
      console.warn('[env] BASE_RPC_URL differs from RPC_URL; using RPC_URL and updating BASE_RPC_URL to match');
      process.env.BASE_RPC_URL = runtimeRpcUrl;
    }

    // Ensure mech-client specific RPC aliases inherit from the canonical RPC_URL
    // In test/review mode, respect preserved keys to avoid overwriting dynamically-set values
    if (runtimeRpcUrl) {
      if (!process.env.MECH_RPC_HTTP_URL && !preservedKeys.has('MECH_RPC_HTTP_URL')) {
        process.env.MECH_RPC_HTTP_URL = runtimeRpcUrl;
      }
      if (!process.env.MECHX_CHAIN_RPC && !preservedKeys.has('MECHX_CHAIN_RPC')) {
        process.env.MECHX_CHAIN_RPC = runtimeRpcUrl;
      }
      if (!process.env.MECHX_LEDGER_ADDRESS && !preservedKeys.has('MECHX_LEDGER_ADDRESS')) {
        process.env.MECHX_LEDGER_ADDRESS = runtimeRpcUrl;
      }
    }

    process.env.__ENV_LOADED = '1';
  } catch {
    // Best-effort; do not throw in bootstrap
  }
}

export { };
