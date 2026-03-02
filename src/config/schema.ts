/**
 * Zod schemas for jinn.yaml configuration sections.
 *
 * All keys use snake_case (matching YAML convention).
 * The loader transforms to camelCase for the TypeScript API.
 */
import { z } from 'zod';

export type WorkerMechFilterMode = 'any' | 'list' | 'single' | 'staking';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Boolean coercion that correctly handles string values from YAML and env vars.
 * z.coerce.boolean() treats any non-empty string (including 'false') as true,
 * so we need custom logic.
 */
const boolCoerce = z.union([z.boolean(), z.string(), z.number()])
    .transform((val) => {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'number') return val !== 0;
        const s = String(val).toLowerCase().trim();
        return s !== 'false' && s !== '0' && s !== '';
    });

// ============================================================================
// Section schemas
// ============================================================================

export const chainSchema = z.object({
    rpc_url: z.string().default(''),
    chain_id: z.coerce.number().int().default(8453),
});

export const workerSchema = z.object({
    poll_base_ms: z.coerce.number().int().positive().default(30000),
    poll_max_ms: z.coerce.number().int().positive().default(300000),
    poll_backoff_factor: z.coerce.number().positive().default(1.5),
    checkpoint_cycles: z.coerce.number().int().positive().default(60),
    heartbeat_cycles: z.coerce.number().int().positive().default(16),
    venture_watcher_cycles: z.coerce.number().int().positive().default(3),
    fund_check_cycles: z.coerce.number().int().positive().default(120),
    repost_check_cycles: z.coerce.number().int().positive().default(10),
    multi_service: boolCoerce.default(false),
    activity_poll_ms: z.coerce.number().int().positive().default(60000),
    activity_cache_ttl_ms: z.coerce.number().int().positive().default(60000),
    staking_refresh_ms: z.coerce.number().int().positive().default(300000),
    mech_filter_mode: z.enum(['any', 'list', 'single', 'staking']).default('single'),
    auto_restake: boolCoerce.default(true),
    tx_confirmations: z.coerce.number().int().positive().default(3),
    job_delay_ms: z.coerce.number().int().nonnegative().default(0),
    max_cycles: z.coerce.number().int().nonnegative().default(0),
    stuck_exit_cycles: z.coerce.number().int().nonnegative().default(0),
    enable_venture_watcher: boolCoerce.default(false),
    enable_auto_repost: boolCoerce.default(false),
    buzz_only: boolCoerce.default(false),
});

export const stakingSchema = z.object({
    contract: z.string().default(''),
    interval_ms_override: z.coerce.number().int().positive().optional(),
    program: z.string().default(''),
});

export const filteringSchema = z.object({
    workstreams: z.array(z.string()).default([]),
    ventures: z.array(z.string()).default([]),
    venture_template_ids: z.array(z.string()).default([]),
    earning_schedule: z.string().default(''),
    earning_max_jobs: z.coerce.number().int().nonnegative().default(0),
    mech_filter_list: z.string().default(''),
    priority_mech: z.string().default(''),
    target_request_id: z.string().default(''),
    allowlist_config_path: z.string().default(''),
});

export const agentSchema = z.object({
    sandbox: z.enum(['sandbox-exec', 'docker', 'podman', 'false']).default('sandbox-exec'),
    max_stdout_size: z.coerce.number().int().positive().default(5242880),
    max_chunk_size: z.coerce.number().int().positive().default(102400),
    repetition_window: z.coerce.number().int().positive().default(20),
    repetition_threshold: z.coerce.number().int().positive().default(10),
    max_identical_chunks: z.coerce.number().int().positive().default(10),
    max_prompt_arg_bytes: z.coerce.number().int().positive().default(100000),
    additional_include_dirs: z.string().default(''),
    telemetry_dir: z.string().default(''),
});

export const dependenciesSchema = z.object({
    stale_ms: z.coerce.number().int().positive().default(7200000),
    redispatch_cooldown_ms: z.coerce.number().int().positive().default(3600000),
    missing_fail_ms: z.coerce.number().int().positive().default(7200000),
    cancel_cooldown_ms: z.coerce.number().int().positive().default(3600000),
    redispatch: boolCoerce.default(false),
    autofail: boolCoerce.default(true),
});

export const heartbeatSchema = z.object({
    min_interval_sec: z.coerce.number().int().positive().default(60),
});

export const servicesSchema = z.object({
    ponder_url: z.string().default('https://indexer.jinn.network/graphql'),
    ponder_port: z.coerce.number().int().positive().default(42069),
    ponder_start_block: z.coerce.number().int().nonnegative().optional(),
    ponder_end_block: z.coerce.number().int().nonnegative().optional(),
    control_api_url: z.string().default('https://control-api-production-c1f5.up.railway.app/graphql'),
    control_api_port: z.coerce.number().int().positive().optional(),
    control_api_service_key: z.string().default(''),
    use_control_api: boolCoerce.default(true),
    ipfs_gateway_url: z.string().default('https://gateway.autonolas.tech/ipfs/'),
    ipfs_fetch_timeout_ms: z.coerce.number().int().positive().default(30000),
});

export const gitSchema = z.object({
    default_base_branch: z.string().default('main'),
    remote_name: z.string().default('origin'),
    github_api_url: z.string().default('https://api.github.com'),
    github_repository: z.string().default(''),
    ssh_host_alias: z.string().default(''),
    workspace_dir: z.string().default(''),
    repo_root: z.string().default(''),
    author_name: z.string().default(''),
    author_email: z.string().default(''),
});

export const loggingSchema = z.object({
    level: z.enum(['error', 'warn', 'info', 'debug', 'trace', 'fatal']).default('info'),
    format: z.enum(['json', 'pretty']).default('pretty'),
    mcp_level: z.enum(['error', 'warn', 'info', 'debug']).default('error'),
    destination: z.string().default('stdout'),
});

export const blueprintSchema = z.object({
    enable_system: boolCoerce.default(true),
    enable_context_assertions: boolCoerce.default(true),
    enable_recognition: boolCoerce.default(false),
    enable_job_context: boolCoerce.default(true),
    enable_progress: boolCoerce.default(false),
    enable_beads: boolCoerce.default(false),
    enable_context_phases: boolCoerce.default(false),
    debug: boolCoerce.default(false),
    log_providers: boolCoerce.default(false),
});

export const llmSchema = z.object({
    quota_check_model: z.string().default(''),
    quota_check_timeout_ms: z.coerce.number().int().positive().optional(),
    quota_backoff_ms: z.coerce.number().int().positive().optional(),
    quota_max_backoff_ms: z.coerce.number().int().positive().optional(),
});

export const blogSchema = z.object({
    umami_host: z.string().default(''),
    umami_website_id: z.string().default(''),
});

export const devSchema = z.object({
    node_env: z.enum(['development', 'production', 'test']).default('development'),
    runtime_environment: z.enum(['default', 'test', 'review']).default('default'),
    dry_run: boolCoerce.default(false),
    disable_sts_checks: boolCoerce.default(false),
    test_rpc_url: z.string().default(''),
    mcp_debug_mech_client: boolCoerce.default(false),
    use_tsx_mcp: boolCoerce.default(false),
    enable_transaction_executor: boolCoerce.default(false),
    worker_id: z.string().default(''),
});

export const playwrightSchema = z.object({
    channel: z.string().default(''),
    fast: boolCoerce.default(false),
    headless: boolCoerce.default(true),
    keep_open: boolCoerce.default(false),
    profile_dir: z.string().default(''),
});

// ============================================================================
// Combined config schema
// ============================================================================

export const configSchema = z.object({
    chain: chainSchema.default({}),
    worker: workerSchema.default({}),
    staking: stakingSchema.default({}),
    filtering: filteringSchema.default({}),
    agent: agentSchema.default({}),
    dependencies: dependenciesSchema.default({}),
    heartbeat: heartbeatSchema.default({}),
    services: servicesSchema.default({}),
    git: gitSchema.default({}),
    logging: loggingSchema.default({}),
    blueprint: blueprintSchema.default({}),
    llm: llmSchema.default({}),
    blog: blogSchema.default({}),
    dev: devSchema.default({}),
    playwright: playwrightSchema.default({}),
});

/**
 * Raw config type — uses snake_case keys matching YAML.
 * The loader transforms these to camelCase for the public TypeScript API.
 */
export type RawNodeConfig = z.infer<typeof configSchema>;
