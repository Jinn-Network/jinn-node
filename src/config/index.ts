/**
 * Canonical configuration module for Jinn Mech Worker
 *
 * This module provides the single source of truth for all environment variable access.
 * All runtime code should import configuration through the typed getters exported here.
 *
 * Design principles:
 * - Fail fast: Invalid configuration throws clear errors at startup
 * - Centralized validation: All env vars validated with Zod schemas
 * - Legacy alias support: Old env var names mapped to canonical names internally
 * - Typed getters: Explicit functions (getRequiredRpcUrl, getOptionalGeminiApiKey, etc.)
 *
 * Note: Calling code is responsible for loading .env files (via env/index.ts or loadEnvOnce())
 * BEFORE importing from this module. This ensures test env var overrides work correctly.
 *
 * See: docs/code-spec/spec.md "Centralize configuration access"
 */

import { z } from 'zod';
import {
  getMechAddress as getOperateMechAddress,
  getServiceSafeAddress,
  getServicePrivateKey as getOperatePrivateKey,
} from '../env/operate-profile.js';

// ============================================================================
// Configuration Schema
// ============================================================================

/**
 * Core blockchain configuration schema
 * Required for all blockchain interactions
 */
const coreBlockchainSchema = z.object({
  // RPC_URL: Canonical HTTP(S) RPC endpoint
  // Legacy aliases: MECHX_CHAIN_RPC, MECH_RPC_HTTP_URL, BASE_RPC_URL
  RPC_URL: z.string().url('RPC_URL must be a valid HTTP/HTTPS URL'),

  // CHAIN_ID: Network identifier (8453 = Base mainnet, 84532 = Base Sepolia)
  CHAIN_ID: z.coerce.number().int().positive('CHAIN_ID must be a positive integer'),

  // WORKER_PRIVATE_KEY: EOA private key for the agent's on-chain identity
  WORKER_PRIVATE_KEY: z.string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'WORKER_PRIVATE_KEY must be a 66-character hex string with 0x prefix')
    .optional(),
});

/**
 * Mech service configuration schema
 * Addresses and identifiers for mech operations
 */
const mechServiceSchema = z.object({
  // MECH_ADDRESS: Address of the mech contract to interact with
  // Legacy aliases: MECH_WORKER_ADDRESS
  // Also reads from .operate profile if not set
  MECH_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),

  // MECH_SAFE_ADDRESS: Gnosis Safe address for the service
  // Reads from .operate profile if not set
  MECH_SAFE_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),

  // MECH_MARKETPLACE_ADDRESS_BASE: Marketplace contract address
  MECH_MARKETPLACE_ADDRESS_BASE: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),

  // MECH_MODEL: Default AI model for mech operations
  MECH_MODEL: z.string().optional(),

  // MECH_RECLAIM_AFTER_MINUTES: When to reclaim undelivered requests
  MECH_RECLAIM_AFTER_MINUTES: z.coerce.number().int().positive().optional(),
});

/**
 * Ponder indexer configuration schema
 * For on-chain event indexing and GraphQL API
 */
const ponderSchema = z.object({
  // PONDER_PORT: GraphQL server port (default: 42069)
  PONDER_PORT: z.coerce.number().int().positive().default(42069),

  // PONDER_GRAPHQL_URL: Explicit GraphQL URL (derived from PONDER_PORT if not set)
  PONDER_GRAPHQL_URL: z.string().url().optional(),

  // PONDER_START_BLOCK: Start indexing from this block
  PONDER_START_BLOCK: z.coerce.number().int().positive().optional(),

  // PONDER_END_BLOCK: Stop indexing at this block (for deterministic testing)
  PONDER_END_BLOCK: z.coerce.number().int().positive().optional(),

  // NEXT_PUBLIC_PONDER_PORT: Frontend convenience (mirrors PONDER_PORT)
  NEXT_PUBLIC_PONDER_PORT: z.coerce.number().int().positive().optional(),
});

/**
 * Control API configuration schema
 * For job management and coordination
 */
const controlApiSchema = z.object({
  // CONTROL_API_URL: GraphQL endpoint for Control API (defaults to hosted Control API)
  CONTROL_API_URL: z.string().url().optional(),

  // CONTROL_API_PORT: Server port when running Control API locally
  CONTROL_API_PORT: z.coerce.number().int().positive().optional(),

  // CONTROL_API_SERVICE_KEY: Authentication key for Control API
  CONTROL_API_SERVICE_KEY: z.string().optional(),

  // USE_CONTROL_API: Feature flag to enable Control API usage
  // Note: z.coerce.boolean() treats any non-empty string as true, so we need custom logic
  USE_CONTROL_API: z.string().optional().transform(v => v !== 'false' && v !== '0'),
});

/**
 * Supabase configuration schema
 * For Control API backend storage
 */
const supabaseSchema = z.object({
  // SUPABASE_URL: Supabase project URL
  SUPABASE_URL: z.string().url().optional(),

  // SUPABASE_SERVICE_ROLE_KEY: Service role key (full access)
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // SUPABASE_SERVICE_ANON_KEY: Anonymous key (limited access)
  SUPABASE_SERVICE_ANON_KEY: z.string().optional(),
});

/**
 * OLAS Operate middleware configuration schema
 * For service deployment and management
 */
const olasOperateSchema = z.object({
  // OPERATE_PASSWORD: Password for olas-operate-middleware (encrypts keystore)
  OPERATE_PASSWORD: z.string().optional(),

  // ATTENDED: Interactive mode vs automated
  ATTENDED: z.coerce.boolean().optional(),

  // STAKING_PROGRAM: Staking configuration (no_staking, custom_staking)
  STAKING_PROGRAM: z.string().optional(),

  // STAKING_INTERVAL_MS_OVERRIDE: Override staking check interval
  STAKING_INTERVAL_MS_OVERRIDE: z.coerce.number().int().positive().optional(),

  // OLAS_SERVICE_CONFIG_PATH: Path to service config
  OLAS_SERVICE_CONFIG_PATH: z.string().optional(),

  // OLAS_MIDDLEWARE_PATH: Path to middleware installation
  OLAS_MIDDLEWARE_PATH: z.string().optional(),

  // MIDDLEWARE_PATH: Alternative middleware path
  MIDDLEWARE_PATH: z.string().optional(),
});

/**
 * IPFS configuration schema
 * For request/delivery data storage
 */
const ipfsSchema = z.object({
  // IPFS_GATEWAY_URL: IPFS gateway for fetching and uploading
  IPFS_GATEWAY_URL: z.string().url().optional(),

  // IPFS_FETCH_TIMEOUT_MS: Timeout for IPFS fetch operations
  IPFS_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});

/**
 * LLM API configuration schema
 * For AI-powered job execution
 */
const llmApiSchema = z.object({
  // GEMINI_API_KEY: Google Gemini API key
  GEMINI_API_KEY: z.string().optional(),

  // GEMINI_QUOTA_CHECK_MODEL: Model used for quota check pings
  GEMINI_QUOTA_CHECK_MODEL: z.string().optional(),

  // GEMINI_QUOTA_CHECK_TIMEOUT_MS: Timeout for quota check HTTP calls
  GEMINI_QUOTA_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  // GEMINI_QUOTA_BACKOFF_MS: Base backoff for quota polling
  GEMINI_QUOTA_BACKOFF_MS: z.coerce.number().int().positive().optional(),

  // GEMINI_QUOTA_MAX_BACKOFF_MS: Max backoff for quota polling
  GEMINI_QUOTA_MAX_BACKOFF_MS: z.coerce.number().int().positive().optional(),

  // OPENAI_API_KEY: OpenAI API key
  OPENAI_API_KEY: z.string().optional(),
});

/**
 * External service API keys schema
 */
const externalApisSchema = z.object({
  // GITHUB_TOKEN: GitHub Personal Access Token for MCP server
  GITHUB_TOKEN: z.string().optional(),

  // CIVITAI_API_KEY: Civitai API key
  CIVITAI_API_KEY: z.string().optional(),

  // CIVITAI_API_TOKEN: Alternative Civitai token
  CIVITAI_API_TOKEN: z.string().optional(),

  // CIVITAI_AIR_WAIT: Wait time for AIR generation
  CIVITAI_AIR_WAIT: z.coerce.number().int().positive().optional(),

  // ZORA_API_KEY: Zora API key
  ZORA_API_KEY: z.string().optional(),

  // TENDERLY_ACCESS_KEY: Tenderly access key for VNet testing
  TENDERLY_ACCESS_KEY: z.string().optional(),

  // TENDERLY_ACCOUNT_SLUG: Tenderly account identifier
  TENDERLY_ACCOUNT_SLUG: z.string().optional(),

  // TENDERLY_PROJECT_SLUG: Tenderly project identifier
  TENDERLY_PROJECT_SLUG: z.string().optional(),

  // SNYK_TOKEN: Snyk security scanning token
  SNYK_TOKEN: z.string().optional(),
});

/**
 * Job context configuration schema
 * Runtime values set by job execution system
 */
const jobContextSchema = z.object({
  // JINN_JOB_ID: Current job identifier
  JINN_JOB_ID: z.string().optional(),

  // JINN_JOB_NAME: Current job name
  JINN_JOB_NAME: z.string().optional(),

  // JINN_JOB_DEFINITION_ID: Job definition identifier
  JINN_JOB_DEFINITION_ID: z.string().optional(),

  // JINN_PROJECT_RUN_ID: Project run identifier
  JINN_PROJECT_RUN_ID: z.string().optional(),

  // JINN_PROJECT_DEFINITION_ID: Project definition identifier
  JINN_PROJECT_DEFINITION_ID: z.string().optional(),

  // JINN_REQUEST_ID: Mech request identifier
  JINN_REQUEST_ID: z.string().optional(),

  // JINN_SOURCE_EVENT_ID: Source event identifier
  JINN_SOURCE_EVENT_ID: z.string().optional(),

  // JINN_THREAD_ID: Thread identifier for conversations
  JINN_THREAD_ID: z.string().optional(),

  // JINN_MECH_ADDRESS: Mech address for current job
  JINN_MECH_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),

  // JINN_WALLET_STORAGE_PATH: Override wallet storage for testing
  JINN_WALLET_STORAGE_PATH: z.string().optional(),

  // JINN_ENV_PATH: Override .env file path
  JINN_ENV_PATH: z.string().optional(),
});

/**
 * Git workflow configuration schema
 * For code-based job execution with git lineage
 */
const gitWorkflowSchema = z.object({
  // JINN_WORKSPACE_DIR: Directory where venture repositories are cloned
  // Defaults to ~/jinn-repos if not set
  JINN_WORKSPACE_DIR: z.string().optional(),

  // CODE_METADATA_REPO_ROOT: Repository root for code metadata operations
  // Legacy: Use JINN_WORKSPACE_DIR for ventures instead
  CODE_METADATA_REPO_ROOT: z.string().optional(),

  // CODE_METADATA_DEFAULT_BASE_BRANCH: Default base branch for new job definitions
  CODE_METADATA_DEFAULT_BASE_BRANCH: z.string().default('main'),

  // CODE_METADATA_DEBUG: Enable debug logging for code metadata operations
  CODE_METADATA_DEBUG: z.coerce.boolean().optional(),

  // CODE_METADATA_REMOTE_NAME: Git remote name for push operations
  CODE_METADATA_REMOTE_NAME: z.string().default('origin'),

  // GITHUB_API_URL: GitHub API base URL
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),

  // GITHUB_REPOSITORY: GitHub repository in format "owner/repo"
  GITHUB_REPOSITORY: z.string().optional(),

  // JINN_BASE_BRANCH: Base branch for current job (runtime context)
  JINN_BASE_BRANCH: z.string().optional(),

  // JINN_REPO_ROOT: Repository root override for test scenarios
  JINN_REPO_ROOT: z.string().optional(),

  // GIT_AUTHOR_NAME: Git commit author name for agent commits
  // REQUIRED for worker deployments to ensure correct git identity
  GIT_AUTHOR_NAME: z.string().optional(),

  // GIT_AUTHOR_EMAIL: Git commit author email for agent commits
  // REQUIRED for worker deployments to ensure correct git identity
  GIT_AUTHOR_EMAIL: z.string().email('GIT_AUTHOR_EMAIL must be a valid email').optional(),
});

/**
 * Development and testing configuration schema
 */
const devTestingSchema = z.object({
  // NODE_ENV: Node environment (development, production, test)
  NODE_ENV: z.enum(['development', 'production', 'test']).optional(),

  // VITEST: Set by Vitest test runner
  VITEST: z.coerce.boolean().optional(),

  // RUNTIME_ENVIRONMENT: Controls config override behavior (default | test | review)
  RUNTIME_ENVIRONMENT: z.enum(['default', 'test', 'review']).default('default'),

  // DRY_RUN: Skip actual execution, log only
  DRY_RUN: z.coerce.boolean().optional(),

  // DISABLE_STS_CHECKS: Disable Safe Transaction Service checks (for Tenderly)
  DISABLE_STS_CHECKS: z.coerce.boolean().optional(),

  // TEST_RPC_URL: Override RPC URL for testing
  TEST_RPC_URL: z.string().url().optional(),

  // MCP_LOG_LEVEL: MCP server log level
  MCP_LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).optional(),

  // MCP_DEBUG_MECH_CLIENT: Debug flag for mech client
  MCP_DEBUG_MECH_CLIENT: z.coerce.boolean().optional(),

  // USE_TSX_MCP: Enable TSX mode for MCP development
  USE_TSX_MCP: z.coerce.boolean().optional(),

  // LOCAL_QUEUE_DB_PATH: Local transaction queue database
  LOCAL_QUEUE_DB_PATH: z.string().optional(),

  // ENABLE_TRANSACTION_EXECUTOR: Feature flag for transaction executor
  ENABLE_TRANSACTION_EXECUTOR: z.coerce.boolean().optional(),

  // WORKER_ID: Worker identifier for multi-worker setups
  WORKER_ID: z.string().optional(),

  // WORKER_TX_CONFIRMATIONS: Number of confirmations to wait for
  WORKER_TX_CONFIRMATIONS: z.coerce.number().int().positive().default(3),

  // WORKER_JOB_DELAY_MS: Delay (ms) after each job execution before next poll cycle
  // Helps spread API usage when hitting quota limits. Default: 0 (no delay)
  WORKER_JOB_DELAY_MS: z.coerce.number().int().nonnegative().optional(),

  // WORKER_MECH_FILTER_MODE: How to filter which mechs to accept requests from
  // Values: 'any' (all mechs), 'list' (WORKER_MECH_FILTER_LIST), 'single' (getMechAddress()),
  //         'staking' (dynamic from WORKER_STAKING_CONTRACT)
  // Default: Falls back to 'single' if not set
  WORKER_MECH_FILTER_MODE: z.enum(['any', 'list', 'single', 'staking']).optional(),

  // WORKER_STAKING_CONTRACT: Staking contract address for 'staking' filter mode
  // Only used when WORKER_MECH_FILTER_MODE='staking'
  // Known contracts:
  //   - Jinn: 0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139 (5,000 OLAS min)
  //   - AgentsFun1: 0x2585e63df7BD9De8e058884D496658a030b5c6ce (50 OLAS min)
  WORKER_STAKING_CONTRACT: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),

  // WORKER_STAKING_REFRESH_MS: Cache TTL for staking filter queries
  // Default: 300000 (5 minutes)
  WORKER_STAKING_REFRESH_MS: z.coerce.number().int().positive().default(300000),

  // WORKER_MECH_FILTER_LIST: Comma-separated list of mech addresses (legacy)
  // Deprecated: Use WORKER_MECH_FILTER_MODE='staking' instead
  WORKER_MECH_FILTER_LIST: z.string().optional(),

  // Playwright configuration
  PLAYWRIGHT_CHANNEL: z.string().optional(),
  PLAYWRIGHT_FAST: z.coerce.boolean().optional(),
  PLAYWRIGHT_HEADLESS: z.coerce.boolean().optional(),
  PLAYWRIGHT_KEEP_OPEN: z.coerce.boolean().optional(),
  PLAYWRIGHT_PROFILE_DIR: z.string().optional(),

  // Frontend configuration
  NEXT_PUBLIC_SUBGRAPH_URL: z.string().url().optional(),

  // Additional testing flags
  ENABLE_AUTO_REPOST: z.coerce.boolean().optional(),
  BUZZ_ONLY: z.coerce.boolean().optional(),
  PRIORITY_MECH: z.string().optional(),
  MECH_TARGET_REQUEST_ID: z.string().optional(),
  ALLOWLIST_CONFIG_PATH: z.string().optional(),
  FUNDING_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  SERVICE_CONFIG_ID: z.string().optional(),
  MECHX_WSS_ENDPOINT: z.string().optional(),
  MECH_CHAIN_CONFIG: z.string().optional(),
  MECH_PRIVATE_KEY_PATH: z.string().optional(),

  // GEMINI_SANDBOX: Sandbox mode for Gemini CLI agent execution
  // Values: 'sandbox-exec' (macOS Seatbelt), 'docker', 'podman', 'false'
  // Default: 'sandbox-exec' for process-level isolation on macOS
  GEMINI_SANDBOX: z.enum(['sandbox-exec', 'docker', 'podman', 'false']).default('sandbox-exec'),
});

/**
 * Blueprint builder configuration schema
 * Controls how the centralized prompt building system operates
 */
/**
 * Robust boolean coercion that handles "false", "0", and actual booleans
 */
const booleanSchema = z.union([z.boolean(), z.string(), z.number()])
  .transform((val) => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    const s = String(val).toLowerCase().trim();
    return s !== 'false' && s !== '0' && s !== '';
  });

/**
 * Blueprint builder configuration schema
 * Controls how the centralized prompt building system operates
 */
const blueprintBuilderSchema = z.object({
  // BLUEPRINT_BUILDER_DEBUG: Enable debug logging for blueprint building
  BLUEPRINT_BUILDER_DEBUG: booleanSchema.optional(),

  // BLUEPRINT_LOG_PROVIDERS: Log which providers contribute to each blueprint
  BLUEPRINT_LOG_PROVIDERS: booleanSchema.optional(),

  // BLUEPRINT_ENABLE_SYSTEM: Enable static system assertions from system-blueprint.json
  BLUEPRINT_ENABLE_SYSTEM: booleanSchema.optional(),

  // BLUEPRINT_ENABLE_CONTEXT_ASSERTIONS: Enable dynamic context-aware assertions
  BLUEPRINT_ENABLE_CONTEXT_ASSERTIONS: booleanSchema.optional(),

  // BLUEPRINT_ENABLE_RECOGNITION: Enable prescriptive learnings from similar jobs
  BLUEPRINT_ENABLE_RECOGNITION: booleanSchema.optional(),

  // BLUEPRINT_ENABLE_JOB_CONTEXT: Enable job hierarchy context
  BLUEPRINT_ENABLE_JOB_CONTEXT: booleanSchema.optional(),

  // BLUEPRINT_ENABLE_PROGRESS: Enable progress checkpoint context
  BLUEPRINT_ENABLE_PROGRESS: booleanSchema.optional(),

  // BLUEPRINT_ENABLE_BEADS: Enable beads issue tracking assertions for coding jobs
  BLUEPRINT_ENABLE_BEADS: booleanSchema.optional(),

  // BLUEPRINT_ENABLE_CONTEXT_PHASES: Master switch to disable Recognition, Reflection, and Progress phases
  BLUEPRINT_ENABLE_CONTEXT_PHASES: booleanSchema.optional(),
});

/**
 * Blog analytics configuration schema
 * Publishing uses CODE_METADATA_REPO_ROOT (same as other git operations)
 * Analytics uses Umami with JWT auth (username/password)
 */
const blogSchema = z.object({
  // UMAMI_HOST: Umami analytics server URL
  UMAMI_HOST: z.string().url().optional(),

  // UMAMI_WEBSITE_ID: Umami website identifier
  UMAMI_WEBSITE_ID: z.string().optional(),

  // UMAMI_USERNAME: Umami login username (self-hosted uses JWT auth)
  UMAMI_USERNAME: z.string().optional(),

  // UMAMI_PASSWORD: Umami login password
  UMAMI_PASSWORD: z.string().optional(),
});/**
 * Complete configuration schema
 * Combines all domain schemas
 */
const configSchema = z.object({
  ...coreBlockchainSchema.shape,
  ...mechServiceSchema.shape,
  ...ponderSchema.shape,
  ...controlApiSchema.shape,
  ...supabaseSchema.shape,
  ...olasOperateSchema.shape,
  ...ipfsSchema.shape,
  ...llmApiSchema.shape,
  ...externalApisSchema.shape,
  ...jobContextSchema.shape,
  ...gitWorkflowSchema.shape,
  ...devTestingSchema.shape,
  ...blueprintBuilderSchema.shape,
  ...blogSchema.shape,
});

type ConfigType = z.infer<typeof configSchema>;

// ============================================================================
// Internal Configuration Loading
// ============================================================================

/**
 * Cached configuration (lazy loaded on first getter call)
 */
let _config: ConfigType | null = null;

/**
 * Load and validate environment variables
 * Handles legacy alias mapping internally
 */
function loadConfig(): ConfigType {
  // Build environment with legacy alias resolution
  const env = {
    ...process.env,

    // RPC_URL: Check canonical name, then legacy aliases
    RPC_URL: process.env.RPC_URL ||
      process.env.MECHX_CHAIN_RPC ||
      process.env.MECH_RPC_HTTP_URL ||
      process.env.BASE_RPC_URL,

    // MECH_ADDRESS: From .operate service profile only (no env var fallbacks)
    MECH_ADDRESS: getOperateMechAddress() || undefined,

    // MECH_SAFE_ADDRESS: From .operate service profile only (no env var fallbacks)
    MECH_SAFE_ADDRESS: getServiceSafeAddress() || undefined,

    // WORKER_PRIVATE_KEY: From .operate service profile only (no env var fallbacks)
    WORKER_PRIVATE_KEY: getOperatePrivateKey() || undefined,
  };

  // Allow test/review overrides for select keys without clobbering runtime values
  const runtimeMode = (process.env.RUNTIME_ENVIRONMENT as 'default' | 'test' | 'review' | undefined) ?? 'default';
  if (runtimeMode === 'test' || runtimeMode === 'review') {
    const preserveKeys = new Set([
      'RPC_URL',
      'MECHX_CHAIN_RPC',
      'MECH_RPC_HTTP_URL',
      'BASE_RPC_URL',
      'PONDER_GRAPHQL_URL',
      'PONDER_START_BLOCK',
      'PONDER_END_BLOCK',
    ]);
    for (const key of preserveKeys) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
  }

  // Validate against schema
  try {
    return configSchema.parse(env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(issue => {
        const field = issue.path.join('.');
        return `  - ${field}: ${issue.message}`;
      }).join('\n');

      throw new Error(
        `Configuration validation failed:\n${issues}\n\n` +
        `See .env.template for required environment variables.`
      );
    }
    throw error;
  }
}

/**
 * Get validated configuration (loads and caches on first call)
 * In test mode (VITEST=true), always re-read to pick up dynamic env var changes
 */
function getConfig(): ConfigType {
  const isTestMode = process.env.VITEST === 'true';
  if (!_config || isTestMode) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Reset configuration cache (for testing only)
 *
 * Tests that override environment variables after initial load must call this
 * to ensure config getters re-read from process.env.
 *
 * @internal
 */
export function resetConfigForTests(): void {
  _config = null;
}

// ============================================================================
// Public API: Core Blockchain Configuration
// ============================================================================

export function getRequiredRpcUrl(): string {
  const value = getConfig().RPC_URL;
  if (!value) {
    throw new Error('RPC_URL is required but not configured');
  }
  return value;
}

export function getRequiredChainId(): number {
  const value = getConfig().CHAIN_ID;
  if (!value) {
    throw new Error('CHAIN_ID is required but not configured');
  }
  return value;
}

export function getOptionalWorkerPrivateKey(): string | undefined {
  return getConfig().WORKER_PRIVATE_KEY;
}

export function getRequiredWorkerPrivateKey(): string {
  const value = getOptionalWorkerPrivateKey();
  if (!value) {
    throw new Error('WORKER_PRIVATE_KEY is required but not configured');
  }
  return value;
}

// ============================================================================
// Public API: Mech Service Configuration
// ============================================================================

export function getOptionalMechAddress(): string | undefined {
  return getConfig().MECH_ADDRESS;
}

export function getRequiredMechAddress(): string {
  const value = getOptionalMechAddress();
  if (!value) {
    throw new Error('MECH_ADDRESS is required but not configured (check .operate service profile)');
  }
  return value;
}

export function getOptionalMechSafeAddress(): string | undefined {
  return getConfig().MECH_SAFE_ADDRESS;
}

export function getRequiredMechSafeAddress(): string {
  const value = getOptionalMechSafeAddress();
  if (!value) {
    throw new Error('MECH_SAFE_ADDRESS is required but not configured (check .operate service profile)');
  }
  return value;
}

export function getOptionalMechMarketplaceAddress(): string | undefined {
  return getConfig().MECH_MARKETPLACE_ADDRESS_BASE;
}

export function getOptionalMechReclaimAfterMinutes(): number | undefined {
  return getConfig().MECH_RECLAIM_AFTER_MINUTES;
}

// ============================================================================
// Public API: Ponder Configuration
// ============================================================================

export function getPonderPort(): number {
  return getConfig().PONDER_PORT;
}

export function getPonderGraphqlUrl(): string {
  const explicit = getConfig().PONDER_GRAPHQL_URL;
  if (explicit) return explicit;

  // Default to Railway production endpoint (Railway Ponder is the primary dependency)
  // Only use localhost if explicitly testing Ponder changes
  return 'https://ponder-production-6d16.up.railway.app/graphql';
}

export function getOptionalPonderStartBlock(): number | undefined {
  return getConfig().PONDER_START_BLOCK;
}

export function getOptionalPonderEndBlock(): number | undefined {
  return getConfig().PONDER_END_BLOCK;
}

// ============================================================================
// Public API: Control API Configuration
// ============================================================================

export function getOptionalControlApiUrl(): string | undefined {
  return getConfig().CONTROL_API_URL || 'https://control-api-production-c1f5.up.railway.app/graphql';
}

export function getOptionalControlApiPort(): number | undefined {
  return getConfig().CONTROL_API_PORT;
}

export function getOptionalControlApiServiceKey(): string | undefined {
  return getConfig().CONTROL_API_SERVICE_KEY;
}

export function getUseControlApi(): boolean {
  return getConfig().USE_CONTROL_API ?? true;
}

// ============================================================================
// Public API: Supabase Configuration
// ============================================================================

export function getOptionalSupabaseUrl(): string | undefined {
  return getConfig().SUPABASE_URL;
}

export function getRequiredSupabaseUrl(): string {
  const value = getOptionalSupabaseUrl();
  if (!value) {
    throw new Error('SUPABASE_URL is required but not configured');
  }
  return value;
}

export function getOptionalSupabaseServiceRoleKey(): string | undefined {
  return getConfig().SUPABASE_SERVICE_ROLE_KEY;
}

export function getRequiredSupabaseServiceRoleKey(): string {
  const value = getOptionalSupabaseServiceRoleKey();
  if (!value) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required but not configured');
  }
  return value;
}

export function getOptionalSupabaseServiceAnonKey(): string | undefined {
  return getConfig().SUPABASE_SERVICE_ANON_KEY;
}

// ============================================================================
// Public API: OLAS Operate Configuration
// ============================================================================

export function getOptionalOperatePassword(): string | undefined {
  return getConfig().OPERATE_PASSWORD;
}

export function getAttended(): boolean {
  return getConfig().ATTENDED ?? true;
}

export function getOptionalStakingProgram(): string | undefined {
  return getConfig().STAKING_PROGRAM;
}

export function getOptionalStakingIntervalMs(): number | undefined {
  return getConfig().STAKING_INTERVAL_MS_OVERRIDE;
}

export function getOptionalOlasServiceConfigPath(): string | undefined {
  return getConfig().OLAS_SERVICE_CONFIG_PATH;
}

export function getOptionalOlasMiddlewarePath(): string | undefined {
  return getConfig().OLAS_MIDDLEWARE_PATH || getConfig().MIDDLEWARE_PATH;
}

// ============================================================================
// Public API: IPFS Configuration
// ============================================================================

export function getOptionalIpfsGatewayUrl(): string | undefined {
  return getConfig().IPFS_GATEWAY_URL;
}

export function getIpfsGatewayUrl(): string {
  return getOptionalIpfsGatewayUrl() ?? 'https://gateway.autonolas.tech/ipfs/';
}

export function getOptionalIpfsFetchTimeoutMs(): number | undefined {
  return getConfig().IPFS_FETCH_TIMEOUT_MS;
}

export function getIpfsFetchTimeoutMs(): number {
  return getOptionalIpfsFetchTimeoutMs() ?? 30000;
}

// ============================================================================
// Public API: LLM API Configuration
// ============================================================================

export function getOptionalGeminiApiKey(): string | undefined {
  return getConfig().GEMINI_API_KEY;
}

export function getOptionalGeminiQuotaCheckModel(): string | undefined {
  return getConfig().GEMINI_QUOTA_CHECK_MODEL;
}

export function getOptionalGeminiQuotaCheckTimeoutMs(): number | undefined {
  return getConfig().GEMINI_QUOTA_CHECK_TIMEOUT_MS;
}

export function getOptionalGeminiQuotaBackoffMs(): number | undefined {
  return getConfig().GEMINI_QUOTA_BACKOFF_MS;
}

export function getOptionalGeminiQuotaMaxBackoffMs(): number | undefined {
  return getConfig().GEMINI_QUOTA_MAX_BACKOFF_MS;
}

export function getRequiredGeminiApiKey(): string {
  const value = getOptionalGeminiApiKey();
  if (!value) {
    throw new Error('GEMINI_API_KEY is required but not configured');
  }
  return value;
}

export function getOptionalOpenAiApiKey(): string | undefined {
  return getConfig().OPENAI_API_KEY;
}

export function getRequiredOpenAiApiKey(): string {
  const value = getOptionalOpenAiApiKey();
  if (!value) {
    throw new Error('OPENAI_API_KEY is required but not configured');
  }
  return value;
}

// ============================================================================
// Public API: External Service APIs
// ============================================================================

export function getOptionalGithubToken(): string | undefined {
  return getConfig().GITHUB_TOKEN;
}

export function getOptionalCivitaiApiKey(): string | undefined {
  return getConfig().CIVITAI_API_KEY || getConfig().CIVITAI_API_TOKEN;
}

export function getOptionalCivitaiAirWait(): number | undefined {
  return getConfig().CIVITAI_AIR_WAIT;
}

export function getOptionalZoraApiKey(): string | undefined {
  return getConfig().ZORA_API_KEY;
}

export function getOptionalTenderlyAccessKey(): string | undefined {
  return getConfig().TENDERLY_ACCESS_KEY;
}

export function getOptionalTenderlyAccountSlug(): string | undefined {
  return getConfig().TENDERLY_ACCOUNT_SLUG;
}

export function getOptionalTenderlyProjectSlug(): string | undefined {
  return getConfig().TENDERLY_PROJECT_SLUG;
}

export function getOptionalSnykToken(): string | undefined {
  return getConfig().SNYK_TOKEN;
}

// ============================================================================
// Public API: Job Context Configuration
// ============================================================================

export function getOptionalJobId(): string | undefined {
  return getConfig().JINN_JOB_ID;
}

export function getOptionalJobName(): string | undefined {
  return getConfig().JINN_JOB_NAME;
}

export function getOptionalJobDefinitionId(): string | undefined {
  return getConfig().JINN_JOB_DEFINITION_ID;
}

export function getOptionalProjectRunId(): string | undefined {
  return getConfig().JINN_PROJECT_RUN_ID;
}

export function getOptionalProjectDefinitionId(): string | undefined {
  return getConfig().JINN_PROJECT_DEFINITION_ID;
}

export function getOptionalRequestId(): string | undefined {
  return getConfig().JINN_REQUEST_ID;
}

export function getOptionalSourceEventId(): string | undefined {
  return getConfig().JINN_SOURCE_EVENT_ID;
}

export function getOptionalThreadId(): string | undefined {
  return getConfig().JINN_THREAD_ID;
}

export function getOptionalJobMechAddress(): string | undefined {
  return getConfig().JINN_MECH_ADDRESS;
}

export function getOptionalWalletStoragePath(): string | undefined {
  return getConfig().JINN_WALLET_STORAGE_PATH;
}

export function getOptionalEnvPath(): string | undefined {
  return getConfig().JINN_ENV_PATH;
}

// ============================================================================
// Public API: Development & Testing Configuration
// ============================================================================

export function getNodeEnv(): string {
  return getConfig().NODE_ENV ?? 'development';
}

export function isTestEnv(): boolean {
  return getConfig().VITEST ?? false;
}

export function isDryRun(): boolean {
  return getConfig().DRY_RUN ?? false;
}

export function getDisableStsChecks(): boolean {
  return getConfig().DISABLE_STS_CHECKS ?? false;
}

export function getOptionalTestRpcUrl(): string | undefined {
  return getConfig().TEST_RPC_URL;
}

export function getOptionalMcpLogLevel(): string | undefined {
  return getConfig().MCP_LOG_LEVEL;
}

export function getMcpDebugMechClient(): boolean {
  return getConfig().MCP_DEBUG_MECH_CLIENT ?? false;
}

export function getUseTsxMcp(): boolean {
  return getConfig().USE_TSX_MCP ?? false;
}

export function getOptionalLocalQueueDbPath(): string | undefined {
  return getConfig().LOCAL_QUEUE_DB_PATH;
}

export function getEnableTransactionExecutor(): boolean {
  return getConfig().ENABLE_TRANSACTION_EXECUTOR ?? false;
}

export function getOptionalWorkerId(): string | undefined {
  return getConfig().WORKER_ID;
}

export function getWorkerTxConfirmations(): number {
  return getConfig().WORKER_TX_CONFIRMATIONS;
}

export function getOptionalWorkerJobDelayMs(): number | undefined {
  const val = getConfig().WORKER_JOB_DELAY_MS;
  return val !== undefined && val >= 0 ? val : undefined;
}

// ============================================================================
// Public API: Mech Filtering Configuration
// ============================================================================

export type WorkerMechFilterMode = 'any' | 'list' | 'single' | 'staking';

export function getOptionalWorkerMechFilterMode(): WorkerMechFilterMode | undefined {
  return getConfig().WORKER_MECH_FILTER_MODE;
}

export function getOptionalWorkerStakingContract(): string | undefined {
  return getConfig().WORKER_STAKING_CONTRACT;
}

export function getWorkerStakingRefreshMs(): number {
  return getConfig().WORKER_STAKING_REFRESH_MS;
}

export function getOptionalWorkerMechFilterList(): string | undefined {
  return getConfig().WORKER_MECH_FILTER_LIST;
}

export function getOptionalPlaywrightChannel(): string | undefined {
  return getConfig().PLAYWRIGHT_CHANNEL;
}

export function getPlaywrightFast(): boolean {
  return getConfig().PLAYWRIGHT_FAST ?? false;
}

export function getPlaywrightHeadless(): boolean {
  return getConfig().PLAYWRIGHT_HEADLESS ?? true;
}

export function getRuntimeEnvironment(): 'default' | 'test' | 'review' {
  return getConfig().RUNTIME_ENVIRONMENT;
}

export function getPlaywrightKeepOpen(): boolean {
  return getConfig().PLAYWRIGHT_KEEP_OPEN ?? false;
}

export function getOptionalPlaywrightProfileDir(): string | undefined {
  return getConfig().PLAYWRIGHT_PROFILE_DIR;
}

export function getOptionalNextPublicSubgraphUrl(): string | undefined {
  return getConfig().NEXT_PUBLIC_SUBGRAPH_URL;
}

// Additional testing flags
export function getEnableAutoRepost(): boolean {
  return getConfig().ENABLE_AUTO_REPOST ?? false;
}

export function getBuzzOnly(): boolean {
  return getConfig().BUZZ_ONLY ?? false;
}

export function getOptionalPriorityMech(): string | undefined {
  return getConfig().PRIORITY_MECH;
}

export function getOptionalMechTargetRequestId(): string | undefined {
  return getConfig().MECH_TARGET_REQUEST_ID;
}

export function getOptionalAllowlistConfigPath(): string | undefined {
  return getConfig().ALLOWLIST_CONFIG_PATH;
}

export function getOptionalFundingPrivateKey(): string | undefined {
  return getConfig().FUNDING_PRIVATE_KEY;
}

export function getOptionalServiceConfigId(): string | undefined {
  return getConfig().SERVICE_CONFIG_ID;
}

export function getOptionalMechxWssEndpoint(): string | undefined {
  return getConfig().MECHX_WSS_ENDPOINT;
}

export function getOptionalMechChainConfig(): string | undefined {
  return getConfig().MECH_CHAIN_CONFIG;
}

export function getOptionalMechPrivateKeyPath(): string | undefined {
  return getConfig().MECH_PRIVATE_KEY_PATH;
}

// ============================================================================
// Public API: Git Workflow Configuration
// ============================================================================

export function getJinnWorkspaceDir(): string | undefined {
  return getConfig().JINN_WORKSPACE_DIR;
}

export function getCodeMetadataRepoRoot(): string {
  const root = getConfig().CODE_METADATA_REPO_ROOT;
  if (!root) {
    throw new Error('CODE_METADATA_REPO_ROOT environment variable must be set');
  }
  return root;
}

export function getOptionalCodeMetadataRepoRoot(): string | undefined {
  return getConfig().CODE_METADATA_REPO_ROOT;
}

export function getCodeMetadataDefaultBaseBranch(): string {
  return getConfig().CODE_METADATA_DEFAULT_BASE_BRANCH;
}

export function isCodeMetadataDebugEnabled(): boolean {
  return getConfig().CODE_METADATA_DEBUG ?? false;
}

export function getCodeMetadataRemoteName(): string {
  return getConfig().CODE_METADATA_REMOTE_NAME;
}

export function getGithubApiUrl(): string {
  return getConfig().GITHUB_API_URL;
}

export function getOptionalGithubRepository(): string | undefined {
  return getConfig().GITHUB_REPOSITORY;
}

export function getOptionalBaseBranch(): string | undefined {
  return getConfig().JINN_BASE_BRANCH;
}

export function getOptionalRepoRoot(): string | undefined {
  return getConfig().JINN_REPO_ROOT;
}

export function getOptionalGitAuthorName(): string | undefined {
  return getConfig().GIT_AUTHOR_NAME;
}

export function getRequiredGitAuthorName(): string {
  const value = getOptionalGitAuthorName();
  if (!value) {
    throw new Error('GIT_AUTHOR_NAME is required for agent git operations but not configured');
  }
  return value;
}

export function getOptionalGitAuthorEmail(): string | undefined {
  return getConfig().GIT_AUTHOR_EMAIL;
}

export function getRequiredGitAuthorEmail(): string {
  const value = getOptionalGitAuthorEmail();
  if (!value) {
    throw new Error('GIT_AUTHOR_EMAIL is required for agent git operations but not configured');
  }
  return value;
}

// ============================================================================
// Public API: Blueprint Builder Configuration
// ============================================================================

export function getBlueprintBuilderDebug(): boolean {
  return getConfig().BLUEPRINT_BUILDER_DEBUG ?? false;
}

export function getBlueprintLogProviders(): boolean {
  return getConfig().BLUEPRINT_LOG_PROVIDERS ?? false;
}

export function getBlueprintEnableSystem(): boolean {
  return getConfig().BLUEPRINT_ENABLE_SYSTEM ?? true;
}

export function getBlueprintEnableContextAssertions(): boolean {
  return getConfig().BLUEPRINT_ENABLE_CONTEXT_ASSERTIONS ?? true;
}

export function getBlueprintEnableRecognition(): boolean {
  return getConfig().BLUEPRINT_ENABLE_RECOGNITION ?? true;
}

export function getBlueprintEnableJobContext(): boolean {
  return getConfig().BLUEPRINT_ENABLE_JOB_CONTEXT ?? true;
}

export function getBlueprintEnableProgress(): boolean {
  return getConfig().BLUEPRINT_ENABLE_PROGRESS ?? true;
}

export function getBlueprintEnableBeads(): boolean {
  return getConfig().BLUEPRINT_ENABLE_BEADS ?? true;
}

export function getBlueprintEnableContextPhases(): boolean {
  return getConfig().BLUEPRINT_ENABLE_CONTEXT_PHASES ?? false;
}

// ============================================================================
// Public API: Sandbox Configuration
// ============================================================================

/**
 * Get the sandbox mode for Gemini CLI execution.
 * Default: 'sandbox-exec' (macOS Seatbelt) for process-level isolation.
 * Options: 'sandbox-exec', 'docker', 'podman', 'false'
 */
export function getSandboxMode(): 'sandbox-exec' | 'docker' | 'podman' | 'false' {
  return getConfig().GEMINI_SANDBOX;
}

// ============================================================================
// Public API: Blog Management Configuration
// ============================================================================

// ============================================================================
// Public API: Blog Analytics Configuration
// ============================================================================

export function getOptionalUmamiHost(): string | undefined {
  return getConfig().UMAMI_HOST;
}

export function getRequiredUmamiHost(): string {
  const value = getOptionalUmamiHost();
  if (!value) {
    throw new Error('UMAMI_HOST is required for blog analytics but not configured');
  }
  return value;
}

export function getOptionalUmamiWebsiteId(): string | undefined {
  return getConfig().UMAMI_WEBSITE_ID;
}

export function getRequiredUmamiWebsiteId(): string {
  const value = getOptionalUmamiWebsiteId();
  if (!value) {
    throw new Error('UMAMI_WEBSITE_ID is required for blog analytics but not configured');
  }
  return value;
}

export function getOptionalUmamiUsername(): string | undefined {
  return getConfig().UMAMI_USERNAME;
}

export function getRequiredUmamiUsername(): string {
  const value = getOptionalUmamiUsername();
  if (!value) {
    throw new Error('UMAMI_USERNAME is required for blog analytics but not configured');
  }
  return value;
}

export function getOptionalUmamiPassword(): string | undefined {
  return getConfig().UMAMI_PASSWORD;
}

export function getRequiredUmamiPassword(): string {
  const value = getOptionalUmamiPassword();
  if (!value) {
    throw new Error('UMAMI_PASSWORD is required for blog analytics but not configured');
  }
  return value;
}
