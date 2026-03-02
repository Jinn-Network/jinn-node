/**
 * Config loader pipeline: YAML → env override → Zod validate → freeze.
 *
 * Startup flow:
 * 1. Find/auto-generate jinn.yaml
 * 2. Parse YAML
 * 3. Deep-merge env var overrides (via aliases.ts)
 * 4. Validate with Zod schema
 * 5. Transform snake_case → camelCase
 * 6. Freeze and return
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import YAML from 'yaml';
import { configSchema, type RawNodeConfig } from './schema.js';
import { resolveEnvOverrides } from './aliases.js';
import { writeDefaultConfigIfMissing } from './defaults.js';

// ============================================================================
// camelCase transform
// ============================================================================

/**
 * Convert a snake_case string to camelCase.
 */
function snakeToCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Recursively transform all keys in an object from snake_case to camelCase.
 */
function camelCaseKeys(obj: any): any {
    if (Array.isArray(obj)) return obj.map(camelCaseKeys);
    if (obj !== null && typeof obj === 'object') {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[snakeToCamel(key)] = camelCaseKeys(value);
        }
        return result;
    }
    return obj;
}

/**
 * Deep-freeze an object (make it and all nested objects read-only).
 */
function deepFreeze<T extends Record<string, any>>(obj: T): Readonly<T> {
    Object.freeze(obj);
    for (const value of Object.values(obj)) {
        if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
            deepFreeze(value);
        }
    }
    return obj;
}

// ============================================================================
// camelCase config type
// ============================================================================

/**
 * The public API config type with camelCase keys.
 * Generated from the snake_case RawNodeConfig via transform.
 */
export interface NodeConfig {
    chain: {
        rpcUrl: string;
        chainId: number;
    };
    worker: {
        pollBaseMs: number;
        pollMaxMs: number;
        pollBackoffFactor: number;
        checkpointCycles: number;
        heartbeatCycles: number;
        ventureWatcherCycles: number;
        fundCheckCycles: number;
        repostCheckCycles: number;
        multiService: boolean;
        activityPollMs: number;
        activityCacheTtlMs: number;
        stakingRefreshMs: number;
        mechFilterMode: 'any' | 'list' | 'single' | 'staking';
        autoRestake: boolean;
        txConfirmations: number;
        jobDelayMs: number;
        maxCycles: number;
        stuckExitCycles: number;
        enableVentureWatcher: boolean;
        enableAutoRepost: boolean;
        buzzOnly: boolean;
    };
    staking: {
        contract: string;
        intervalMsOverride?: number;
        program: string;
    };
    filtering: {
        workstreams: string[];
        ventures: string[];
        ventureTemplateIds: string[];
        earningSchedule: string;
        earningMaxJobs: number;
        mechFilterList: string;
        priorityMech: string;
        targetRequestId: string;
        allowlistConfigPath: string;
    };
    agent: {
        sandbox: 'sandbox-exec' | 'docker' | 'podman' | 'false';
        maxStdoutSize: number;
        maxChunkSize: number;
        repetitionWindow: number;
        repetitionThreshold: number;
        maxIdenticalChunks: number;
        maxPromptArgBytes: number;
        additionalIncludeDirs: string;
        telemetryDir: string;
    };
    dependencies: {
        staleMs: number;
        redispatchCooldownMs: number;
        missingFailMs: number;
        cancelCooldownMs: number;
        redispatch: boolean;
        autofail: boolean;
    };
    heartbeat: {
        minIntervalSec: number;
    };
    services: {
        ponderUrl: string;
        ponderPort: number;
        ponderStartBlock?: number;
        ponderEndBlock?: number;
        controlApiUrl: string;
        controlApiPort?: number;
        controlApiServiceKey: string;
        useControlApi: boolean;
        ipfsGatewayUrl: string;
        ipfsFetchTimeoutMs: number;
    };
    git: {
        defaultBaseBranch: string;
        remoteName: string;
        githubApiUrl: string;
        githubRepository: string;
        sshHostAlias: string;
        workspaceDir: string;
        repoRoot: string;
        authorName: string;
        authorEmail: string;
    };
    logging: {
        level: string;
        format: string;
        mcpLevel: string;
        destination: string;
    };
    blueprint: {
        enableSystem: boolean;
        enableContextAssertions: boolean;
        enableRecognition: boolean;
        enableJobContext: boolean;
        enableProgress: boolean;
        enableBeads: boolean;
        enableContextPhases: boolean;
        debug: boolean;
        logProviders: boolean;
    };
    llm: {
        quotaCheckModel: string;
        quotaCheckTimeoutMs?: number;
        quotaBackoffMs?: number;
        quotaMaxBackoffMs?: number;
    };
    blog: {
        umamiHost: string;
        umamiWebsiteId: string;
    };
    dev: {
        nodeEnv: string;
        runtimeEnvironment: string;
        dryRun: boolean;
        disableStsChecks: boolean;
        testRpcUrl: string;
        mcpDebugMechClient: boolean;
        useTsxMcp: boolean;
        enableTransactionExecutor: boolean;
        workerId: string;
    };
    playwright: {
        channel: string;
        fast: boolean;
        headless: boolean;
        keepOpen: boolean;
        profileDir: string;
    };
}

export type FrozenNodeConfig = Readonly<NodeConfig>;

// ============================================================================
// Config value source tracking
// ============================================================================

export interface ConfigSource {
    key: string;
    value: string;
    source: 'yaml' | 'env' | 'default';
    envVar?: string;
}

// ============================================================================
// Loader
// ============================================================================

/**
 * Find the jinn.yaml config file by walking up from baseDir.
 */
function findConfigFile(baseDir: string): string | null {
    if (process.env.JINN_CONFIG && existsSync(process.env.JINN_CONFIG)) {
        return process.env.JINN_CONFIG;
    }
    let dir = baseDir;
    for (let i = 0; i < 5; i++) {
        const candidate = join(dir, 'jinn.yaml');
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Deep merge two objects. Source values overwrite target values.
 * Arrays are replaced, not concatenated.
 */
function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)
            && result[key] !== null && typeof result[key] === 'object' && !Array.isArray(result[key])) {
            result[key] = deepMerge(result[key], value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Load, validate, and freeze the node configuration.
 *
 * @param baseDir Directory to search for jinn.yaml (default: CWD)
 * @param env Environment variables to read (default: process.env)
 * @returns Frozen, validated config object with camelCase keys
 */
export function loadNodeConfig(
    baseDir?: string,
    env?: Record<string, string | undefined>,
): FrozenNodeConfig {
    const effectiveBaseDir = baseDir ?? process.cwd();
    const effectiveEnv = env ?? (process.env as Record<string, string | undefined>);

    // 1. Find or auto-generate jinn.yaml
    let configPath = findConfigFile(effectiveBaseDir);
    let yamlContent: Record<string, any> = {};

    if (configPath) {
        const raw = readFileSync(configPath, 'utf-8');
        yamlContent = YAML.parse(raw) || {};
    } else {
        // Auto-generate
        configPath = writeDefaultConfigIfMissing(effectiveBaseDir);
    }

    // 2. Build env var overrides
    const envOverrides = resolveEnvOverrides(effectiveEnv);

    // 3. Deep-merge: YAML base, then env overrides on top
    const merged = deepMerge(yamlContent, envOverrides);

    // 4. Validate with Zod (fills in defaults for missing keys)
    const validated = configSchema.parse(merged);

    // 5. Transform to camelCase
    const camelCased = camelCaseKeys(validated) as NodeConfig;

    // 6. Freeze and return
    return deepFreeze(camelCased);
}
