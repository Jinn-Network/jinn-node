import '../env/index.js';
import { existsSync, unlinkSync } from 'fs';
import { Web3 } from 'web3';
import { graphQLRequest } from '../http/client.js';
import {
  getPonderGraphqlUrl,
  getUseControlApi,
  getEnableAutoRepost,
  getRequiredRpcUrl,
  getOptionalMechTargetRequestId,
  getOptionalControlApiUrl,
} from '../agent/mcp/tools/shared/env.js';
// Import ABI from mech-client-ts package
import marketplaceAbi from '@jinn-network/mech-client-ts/dist/abis/MechMarketplace.json' with { type: 'json' };
import { workerLogger } from '../logging/index.js';
import { claimRequest as apiClaimRequest } from './control_api_client.js';
import { deliverViaSafe } from '@jinn-network/mech-client-ts/dist/post_deliver.js';
import { getMechAddress, getServicePrivateKey, getMechChainConfig, getServiceSafeAddress } from '../env/operate-profile.js';
import { dispatchExistingJob } from '../agent/mcp/tools/dispatch_existing_job.js';
import { getInheritedEnv } from './status/autoDispatch.js';
import { serializeError } from './logging/errors.js';
import { safeParseToolResponse } from './tool_utils.js';
import { processOnce as processJobOnce } from './orchestration/jobRunner.js';
import { fetchIpfsMetadata } from './metadata/fetchIpfsMetadata.js';
import { marketplaceInteract } from '@jinn-network/mech-client-ts/dist/marketplace_interact.js';
import { shouldStop } from './cycleControl.js';
import { waitForGeminiQuota } from './llm/geminiQuota.js';
import { signControlApiHeaders } from '../http/erc8128.js';
import {
  getOptionalWorkerJobDelayMs,
  getOptionalWorkerMechFilterMode,
  getOptionalWorkerStakingContract,
  getOptionalWorkerMechFilterList,
  type WorkerMechFilterMode,
} from '../config/index.js';
import { recordIdleCycle, recordExecutionTime } from './healthcheck.js';
import { getMechAddressesForStakingContract } from './filters/stakingFilter.js';

export { formatSummaryForPr, autoCommitIfNeeded } from './git/autoCommit.js';

type UnclaimedRequest = {
  id: string;           // on-chain requestId (decimal string or 0x)
  mech: string;         // mech address (0x...)
  requester: string;    // requester address (0x...)
  workstreamId?: string; // workstream context for dependency resolution
  blockTimestamp?: number;
  dependencies?: string[];  // job definition IDs or names that must be delivered first
  ipfsHash?: string;
  delivered?: boolean;
};

type JobDefinitionStatus = {
  exists: boolean;
  lastStatus?: string;
  lastInteraction?: number;
  name?: string;
};


const PONDER_GRAPHQL_URL = getPonderGraphqlUrl();
const CONTROL_API_URL = getOptionalControlApiUrl();
const SINGLE_SHOT = process.argv.includes('--single') || process.argv.includes('--single-job');
const USE_CONTROL_API = getUseControlApi();

// Track jobs executed in this session to prevent re-execution on delivery failure
// This prevents infinite loops when delivery fails but Control API allows re-claiming
// Uses Map<id, timestamp> instead of Set for TTL-based eviction
const executedJobsThisSession = new Map<string, number>();
let consecutiveStuckCycles = 0;
let lastStuckRequestIds: string[] = [];

// Parse --runs=<N> flag for controlled execution cycles
const MAX_RUNS = (() => {
  if (SINGLE_SHOT) return 1; // --single is equivalent to --runs=1
  const arg = process.argv.find(arg => arg.startsWith('--runs='));
  if (!arg) return undefined; // Infinite loop (default behavior)
  const value = parseInt(arg.split('=')[1], 10);
  return isNaN(value) || value < 1 ? undefined : value;
})();

// Parse --max-cycles=<N> flag for cyclic workstreams
const MAX_CYCLES = (() => {
  const arg = process.argv.find(arg => arg.startsWith('--max-cycles='));
  if (!arg) return undefined;
  const value = parseInt(arg.split('=')[1], 10);
  return isNaN(value) || value < 1 ? undefined : value;
})();

if (MAX_CYCLES !== undefined) {
  process.env.WORKER_MAX_CYCLES = String(MAX_CYCLES);
}

// Parse --stuck-exit-cycles=<N> flag or WORKER_STUCK_EXIT_CYCLES for watchdog exit
const MAX_STUCK_CYCLES = (() => {
  const arg = process.argv.find(arg => arg.startsWith('--stuck-exit-cycles='));
  const envValue = process.env.WORKER_STUCK_EXIT_CYCLES;
  const raw = arg ? arg.split('=')[1] : envValue;
  if (!raw) return undefined;
  const value = parseInt(raw, 10);
  return isNaN(value) || value < 1 ? undefined : value;
})();

// Adaptive polling configuration for CPU optimization
// When idle, polling interval increases exponentially up to max to reduce CPU usage
const WORKER_POLL_BASE_MS = parseInt(process.env.WORKER_POLL_BASE_MS || '30000');
const WORKER_POLL_MAX_MS = parseInt(process.env.WORKER_POLL_MAX_MS || '300000');
const WORKER_POLL_BACKOFF_FACTOR = parseFloat(process.env.WORKER_POLL_BACKOFF_FACTOR || '1.5');

// Workstream filtering: parse --workstream=<id> flag or WORKSTREAM_FILTER env var
// Supports multiple workstreams via:
//   - Comma-separated: "0x123,0x456,0x789"
//   - JSON array: '["0x123","0x456"]'
//   - Single value: "0x123"
const WORKSTREAM_FILTERS: string[] = (() => {
  const arg = process.argv.find(arg => arg.startsWith('--workstream='));
  const raw = arg ? arg.split('=')[1] : process.env.WORKSTREAM_FILTER;
  if (!raw) return [];

  // Try parsing as JSON array first
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(s => String(s).trim()).filter(Boolean);
      }
    } catch {
      // Not valid JSON, fall through to comma-separated parsing
    }
  }

  // Parse as comma-separated or single value
  return raw.split(',').map(s => s.trim()).filter(Boolean);
})();

// Legacy single-value alias for backward compatibility in logging
const WORKSTREAM_FILTER = WORKSTREAM_FILTERS.length === 1 ? WORKSTREAM_FILTERS[0] : undefined;

// Template-based job pickup: parse VENTURE_TEMPLATE_IDS for template-dispatched jobs from x402 gateway
// Format: comma-separated template IDs or JSON array
const VENTURE_TEMPLATE_IDS: string[] = (() => {
  const raw = process.env.VENTURE_TEMPLATE_IDS;
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(s => String(s).trim()).filter(Boolean);
      }
    } catch {
      // Not valid JSON, fall through
    }
  }

  return raw.split(',').map(s => s.trim()).filter(Boolean);
})();

// Always set WORKER_STOP_FILE so external stop signals can terminate the worker
if (!process.env.WORKER_STOP_FILE) {
  const stopFileSuffix = WORKSTREAM_FILTERS.length > 0
    ? (WORKSTREAM_FILTERS.length === 1
      ? WORKSTREAM_FILTERS[0]
      : `multi-${WORKSTREAM_FILTERS.length}`)
    : `pid-${process.pid}`;
  process.env.WORKER_STOP_FILE = `/tmp/jinn-stop-cycle-${stopFileSuffix}`;
}

// Clear any stale stop file from previous runs so fresh starts aren't blocked
// The stop file can be created by requestStop() or external operators
if (process.env.WORKER_STOP_FILE && existsSync(process.env.WORKER_STOP_FILE)) {
  try {
    unlinkSync(process.env.WORKER_STOP_FILE);
    workerLogger.info({ stopFile: process.env.WORKER_STOP_FILE }, 'Cleared stale stop file from previous run');
  } catch {
    // Ignore errors - file might have been deleted between check and unlink
  }
}

// Auto-reposting configuration
const ENABLE_AUTO_REPOST = getEnableAutoRepost();
const MIN_TIME_BETWEEN_REPOSTS = 5 * 60 * 1000; // 5 minutes

// Track recent reposts to prevent loops
const recentReposts = new Map<string, number>();

const DEFAULT_BASE_BRANCH = process.env.CODE_METADATA_DEFAULT_BASE_BRANCH || 'main';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPENDENCY_STALE_MS = Number(process.env.WORKER_DEPENDENCY_STALE_MS || String(2 * 60 * 60 * 1000));
const DEPENDENCY_REDISPATCH_COOLDOWN_MS = Number(process.env.WORKER_DEPENDENCY_REDISPATCH_COOLDOWN_MS || String(60 * 60 * 1000));
const DEPENDENCY_MISSING_FAIL_MS = Number(process.env.WORKER_DEPENDENCY_MISSING_FAIL_MS || String(2 * 60 * 60 * 1000));
const DEPENDENCY_CANCEL_COOLDOWN_MS = Number(process.env.WORKER_DEPENDENCY_CANCEL_COOLDOWN_MS || String(60 * 60 * 1000));
const ENABLE_DEPENDENCY_REDISPATCH = process.env.WORKER_DEPENDENCY_REDISPATCH === '1';
const ENABLE_DEPENDENCY_AUTOFAIL = process.env.WORKER_DEPENDENCY_AUTOFAIL !== '0';

const dependencyRedispatchAttempts = new Map<string, number>();
const dependencyCancelAttempts = new Map<string, number>();

// Periodic cleanup of global maps to prevent unbounded growth over weeks of uptime
const MAP_CLEANUP_INTERVAL_CYCLES = 50;
const EXECUTED_JOBS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const REPOST_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const DEPENDENCY_MAP_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

function cleanupGlobalMaps(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, ts] of executedJobsThisSession) {
    if (now - ts > EXECUTED_JOBS_MAX_AGE_MS) { executedJobsThisSession.delete(id); cleaned++; }
  }
  for (const [id, ts] of recentReposts) {
    if (now - ts > REPOST_MAX_AGE_MS) { recentReposts.delete(id); cleaned++; }
  }
  for (const [key, ts] of dependencyRedispatchAttempts) {
    if (now - ts > DEPENDENCY_MAP_MAX_AGE_MS) { dependencyRedispatchAttempts.delete(key); cleaned++; }
  }
  for (const [key, ts] of dependencyCancelAttempts) {
    if (now - ts > DEPENDENCY_MAP_MAX_AGE_MS) { dependencyCancelAttempts.delete(key); cleaned++; }
  }

  if (cleaned > 0) {
    workerLogger.debug({ cleaned, sizes: {
      executedJobs: executedJobsThisSession.size,
      reposts: recentReposts.size,
      redispatch: dependencyRedispatchAttempts.size,
      cancel: dependencyCancelAttempts.size,
    }}, 'Cleaned up stale global map entries');
  }
}

// Job processing logic has been moved to worker/orchestration/jobRunner.ts
// This file now serves as a CLI wrapper that handles request discovery, claiming, and orchestration delegation

// Mech filter configuration
type MechFilterMode = WorkerMechFilterMode;
interface MechFilterConfig {
  mode: MechFilterMode;
  addresses: string[]; // lowercase, only used for 'list', 'single', and 'staking' modes
  stakingContract?: string; // only set for 'staking' mode
}

// Cache for staking filter addresses (async initialization)
let cachedStakingAddresses: string[] | null = null;
let stakingAddressesFetchedAt: number = 0;

/**
 * Get mech filter configuration.
 * Priority order:
 * 1. WORKER_MECH_FILTER_MODE='staking' with WORKER_STAKING_CONTRACT
 * 2. WORKER_MECH_FILTER_MODE='list' or legacy WORKER_MECH_FILTER_LIST
 * 3. WORKER_MECH_FILTER_MODE='any'
 * 4. WORKER_MECH_FILTER_MODE='single' or fallback to getMechAddress()
 */
async function getMechFilterConfig(): Promise<MechFilterConfig> {
  const explicitMode = getOptionalWorkerMechFilterMode();
  const stakingContract = getOptionalWorkerStakingContract();
  const filterList = getOptionalWorkerMechFilterList();

  // Deprecation warning for legacy WORKER_MECH_FILTER_LIST
  if (filterList && !explicitMode) {
    workerLogger.warn({
      envVar: 'WORKER_MECH_FILTER_LIST',
      recommendation: "Use WORKER_MECH_FILTER_MODE='staking' with WORKER_STAKING_CONTRACT instead"
    }, 'WORKER_MECH_FILTER_LIST is deprecated - consider migrating to staking-based filtering');
  }

  // Mode 1: Staking-based filtering (new recommended approach)
  if (explicitMode === 'staking' || (stakingContract && !explicitMode)) {
    if (!stakingContract) {
      workerLogger.error('WORKER_MECH_FILTER_MODE=staking requires WORKER_STAKING_CONTRACT');
      return { mode: 'single', addresses: [] };
    }

    // Fetch mech addresses from staking contract
    const addresses = await getMechAddressesForStakingContract(stakingContract);

    if (addresses.length === 0) {
      workerLogger.warn({
        stakingContract,
        note: 'No mechs found staked in this contract - will not match any requests'
      }, 'Staking filter returned no addresses');
    }

    return {
      mode: 'staking',
      addresses,
      stakingContract: stakingContract.toLowerCase(),
    };
  }

  // Mode 2: Explicit "any" mode
  if (explicitMode === 'any' || filterList?.toLowerCase() === 'any') {
    return { mode: 'any', addresses: [] };
  }

  // Mode 3: List mode (from WORKER_MECH_FILTER_LIST or explicit mode)
  if (explicitMode === 'list' || (filterList && filterList.toLowerCase() !== 'any')) {
    const addresses = (filterList || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
    if (addresses.length > 0) {
      return { mode: 'list', addresses };
    }
  }

  // Mode 4: Fallback to single mech from getMechAddress()
  const single = getMechAddress();
  if (single) {
    return { mode: 'single', addresses: [single.toLowerCase()] };
  }

  return { mode: 'single', addresses: [] };
}

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function isTerminalStatus(status?: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

async function getJobDefinitionStatus(jobDefinitionId: string): Promise<JobDefinitionStatus> {
  try {
    const query = `query CheckJobDefStatus($jobDefId: String!) {
      jobDefinitions(where: { id: $jobDefId }) {
        items {
          id
          name
          lastStatus
          lastInteraction
        }
      }
    }`;

    const data = await graphQLRequest<{
      jobDefinitions: { items: Array<{ id: string; name?: string; lastStatus?: string; lastInteraction?: string }> };
    }>({
      url: PONDER_GRAPHQL_URL,
      query,
      variables: { jobDefId: jobDefinitionId },
      context: { operation: 'getJobDefinitionStatus', jobDefinitionId },
    });

    const jobDef = data?.jobDefinitions?.items?.[0];
    if (!jobDef) {
      return { exists: false };
    }

    return {
      exists: true,
      name: jobDef.name,
      lastStatus: jobDef.lastStatus,
      lastInteraction: jobDef.lastInteraction ? Number(jobDef.lastInteraction) : undefined,
    };
  } catch (e: any) {
    workerLogger.warn({
      jobDefinitionId,
      error: e instanceof Error ? e.message : String(e),
    }, 'Failed to fetch job definition status');
    return { exists: false };
  }
}

function shouldThrottle(map: Map<string, number>, key: string, cooldownMs: number): boolean {
  const last = map.get(key);
  if (!last) return false;
  return Date.now() - last < cooldownMs;
}

async function maybeRedispatchDependency(params: {
  request: UnclaimedRequest;
  dependencyId: string;
  status: JobDefinitionStatus;
}): Promise<void> {
  if (!ENABLE_DEPENDENCY_REDISPATCH) return;
  if (!params.request.workstreamId) return;
  if (!params.status.lastStatus) return;

  const lastInteractionMs = params.status.lastInteraction ? params.status.lastInteraction * 1000 : undefined;
  if (!lastInteractionMs) return;
  if (Date.now() - lastInteractionMs < DEPENDENCY_STALE_MS) return;

  const redispatchable = new Set(['DELEGATING', 'WAITING', 'PENDING']);
  if (!redispatchable.has(params.status.lastStatus)) return;

  const key = `${params.request.workstreamId}:${params.dependencyId}`;
  if (shouldThrottle(dependencyRedispatchAttempts, key, DEPENDENCY_REDISPATCH_COOLDOWN_MS)) return;

  try {
    dependencyRedispatchAttempts.set(key, Date.now());
    workerLogger.warn({
      requestId: params.request.id,
      dependencyId: params.dependencyId,
      lastStatus: params.status.lastStatus,
      lastInteraction: params.status.lastInteraction,
    }, 'Dependency appears stale; re-dispatching dependency job definition');

    await dispatchExistingJob({
      jobId: params.dependencyId,
      workstreamId: params.request.workstreamId,
      message: `Auto-redispatch: dependency stale (${params.status.lastStatus}) with no activity for ${Math.round((Date.now() - lastInteractionMs) / 60000)}m`,
      // Include inherited env vars for workstream-level config propagation
      additionalContext: { env: getInheritedEnv() }
    });
  } catch (e: any) {
    workerLogger.warn({
      requestId: params.request.id,
      dependencyId: params.dependencyId,
      error: e?.message || String(e),
    }, 'Failed to re-dispatch stale dependency');
  }
}

async function maybeCancelMissingDependency(params: {
  request: UnclaimedRequest;
  dependencyId: string;
}): Promise<void> {
  if (!ENABLE_DEPENDENCY_AUTOFAIL) return;
  if (!params.request.blockTimestamp) return;

  const requestAgeMs = Date.now() - params.request.blockTimestamp * 1000;
  if (requestAgeMs < DEPENDENCY_MISSING_FAIL_MS) return;

  const key = `${params.request.id}:${params.dependencyId}`;
  if (shouldThrottle(dependencyCancelAttempts, key, DEPENDENCY_CANCEL_COOLDOWN_MS)) return;
  dependencyCancelAttempts.set(key, Date.now());

  const mechAddress = getMechAddress();
  const safeAddress = getServiceSafeAddress();
  const privateKey = getServicePrivateKey();
  const rpcHttpUrl = getRequiredRpcUrl();
  const chainConfig = getMechChainConfig();

  if (!mechAddress || !safeAddress || !privateKey) {
    workerLogger.warn({
      requestId: params.request.id,
      dependencyId: params.dependencyId,
    }, 'Cannot auto-cancel missing dependency: missing service credentials');
    return;
  }

  try {
    const resultContent = {
      requestId: params.request.id,
      output: `Job cancelled: missing dependency job definition ${params.dependencyId}`,
      telemetry: {},
      artifacts: [],
      cancelled: true,
    };

    const delivery = await (deliverViaSafe as any)({
      chainConfig,
      requestId: params.request.id,
      resultContent,
      targetMechAddress: mechAddress,
      safeAddress,
      privateKey,
      rpcHttpUrl,
      wait: true,
    });

    workerLogger.warn({
      requestId: params.request.id,
      dependencyId: params.dependencyId,
      txHash: delivery?.tx_hash,
    }, 'Auto-cancelled request due to missing dependency');
  } catch (e: any) {
    workerLogger.warn({
      requestId: params.request.id,
      dependencyId: params.dependencyId,
      error: e?.message || String(e),
    }, 'Failed to auto-cancel request for missing dependency');
  }
}

async function fetchRecentRequests(limit: number = 10): Promise<UnclaimedRequest[]> {
  try {
    const mechFilter = await getMechFilterConfig();

    if (mechFilter.mode !== 'any' && mechFilter.addresses.length === 0) {
      workerLogger.warn({
        mode: mechFilter.mode,
        stakingContract: mechFilter.stakingContract
      }, 'Cannot fetch requests without mech address, WORKER_MECH_FILTER_LIST, or staked mechs');
      return [];
    }

    workerLogger.info({
      ponderUrl: PONDER_GRAPHQL_URL,
      mechFilterMode: mechFilter.mode,
      mechFilterAddresses: mechFilter.mode === 'any' ? 'any' : mechFilter.addresses,
      stakingContract: mechFilter.stakingContract,
      workstreamFilter: WORKSTREAM_FILTERS.length > 0 ? WORKSTREAM_FILTERS : 'none'
    }, 'Fetching requests from Ponder');

    // Build where conditions based on filter mode
    // 'staking' mode uses the same query structure as 'list' mode
    const whereConditions: string[] = ['delivered: false'];
    if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
      whereConditions.push('mech_in: $mechs');
    } else if (mechFilter.mode === 'single') {
      whereConditions.push('mech: $mech');
    }
    // 'any' mode: no mech filter

    // Workstream filtering: single vs multiple
    if (WORKSTREAM_FILTERS.length === 1) {
      whereConditions.push('workstreamId: $workstreamId');
    } else if (WORKSTREAM_FILTERS.length > 1) {
      whereConditions.push('workstreamId_in: $workstreamIds');
    }
    const whereClause = `{ ${whereConditions.join(', ')} }`;

    // Build query variables definition
    const varDefs: string[] = ['$limit: Int!'];
    if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
      varDefs.push('$mechs: [String!]!');
    } else if (mechFilter.mode === 'single') {
      varDefs.push('$mech: String!');
    }
    if (WORKSTREAM_FILTERS.length === 1) {
      varDefs.push('$workstreamId: String!');
    } else if (WORKSTREAM_FILTERS.length > 1) {
      varDefs.push('$workstreamIds: [String!]!');
    }

    // Query our local Ponder GraphQL (custom schema) - FILTER BY MECH AND UNDELIVERED (and optionally WORKSTREAM)
    const query = `query RecentRequests(${varDefs.join(', ')}) {
  requests(
    where: ${whereClause}
    orderBy: "blockTimestamp"
    orderDirection: "asc"
    limit: $limit
  ) {
    items {
      id
      mech
      sender
      workstreamId
      ipfsHash
      blockTimestamp
      delivered
      dependencies
    }
  }
}`;

    const variables: any = { limit };
    if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
      variables.mechs = mechFilter.addresses;
    } else if (mechFilter.mode === 'single') {
      variables.mech = mechFilter.addresses[0];
    }
    if (WORKSTREAM_FILTERS.length === 1) {
      variables.workstreamId = WORKSTREAM_FILTERS[0];
    } else if (WORKSTREAM_FILTERS.length > 1) {
      variables.workstreamIds = WORKSTREAM_FILTERS;
    }

    const data = await graphQLRequest<{ requests: { items: any[] } }>({
      url: PONDER_GRAPHQL_URL,
      query,
      variables,
      context: { operation: 'fetchRecentRequests', mechFilterMode: mechFilter.mode }
    });
    const items: any[] = data?.requests?.items || [];
    workerLogger.info({ totalItems: items.length, items: items.map(r => ({ id: r.id, delivered: r.delivered, dependencies: r.dependencies })) }, 'Ponder GraphQL response (workstream query)');

    // Query 2: Template-based jobs from x402 gateway
    // Runs when Supabase is configured (dynamic validation) OR VENTURE_TEMPLATE_IDS is set (legacy).
    // These jobs have jobName containing "(via x402)" and may not match any workstream filter.
    // Template ownership is validated later in jobRunner via Supabase query.
    let templateItems: any[] = [];
    const ENABLE_TEMPLATE_PICKUP = !!(process.env.SUPABASE_URL || VENTURE_TEMPLATE_IDS.length > 0);
    if (ENABLE_TEMPLATE_PICKUP) {
      try {
        const templateWhereConditions: string[] = ['delivered: false', 'jobName_contains: "(via x402)"'];
        if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
          templateWhereConditions.push('mech_in: $mechs');
        } else if (mechFilter.mode === 'single') {
          templateWhereConditions.push('mech: $mech');
        }
        const templateWhereClause = `{ ${templateWhereConditions.join(', ')} }`;

        const templateVarDefs: string[] = ['$tLimit: Int!'];
        if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
          templateVarDefs.push('$mechs: [String!]!');
        } else if (mechFilter.mode === 'single') {
          templateVarDefs.push('$mech: String!');
        }

        const templateQuery = `query TemplateRequests(${templateVarDefs.join(', ')}) {
  requests(
    where: ${templateWhereClause}
    orderBy: "blockTimestamp"
    orderDirection: "asc"
    limit: $tLimit
  ) {
    items {
      id
      mech
      sender
      workstreamId
      ipfsHash
      blockTimestamp
      delivered
      dependencies
    }
  }
}`;

        const templateVars: any = { tLimit: limit };
        if (mechFilter.mode === 'list' || mechFilter.mode === 'staking') {
          templateVars.mechs = mechFilter.addresses;
        } else if (mechFilter.mode === 'single') {
          templateVars.mech = mechFilter.addresses[0];
        }

        const templateData = await graphQLRequest<{ requests: { items: any[] } }>({
          url: PONDER_GRAPHQL_URL,
          query: templateQuery,
          variables: templateVars,
          context: { operation: 'fetchTemplateRequests', mechFilterMode: mechFilter.mode }
        });
        templateItems = templateData?.requests?.items || [];
        if (templateItems.length > 0) {
          workerLogger.info({ count: templateItems.length }, 'Template-based requests found (via x402)');
        }
      } catch (e) {
        workerLogger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Template request query failed; continuing with workstream results only');
      }
    }

    // Merge and deduplicate results from both queries
    const seenIds = new Set<string>();
    const allItems: any[] = [];

    for (const r of items) {
      const id = String(r.id);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        allItems.push(r);
      }
    }
    for (const r of templateItems) {
      const id = String(r.id);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        allItems.push(r);
      }
    }

    workerLogger.info({
      workstreamResults: items.length,
      templateResults: templateItems.length,
      mergedTotal: allItems.length,
    }, 'Merged request results');

    return allItems.map((r: any) => ({
      id: String(r.id),
      mech: String(r.mech),
      requester: String(r.sender || ''),
      workstreamId: r?.workstreamId ? String(r.workstreamId) : undefined,
      ipfsHash: r?.ipfsHash ? String(r.ipfsHash) : undefined,
      blockTimestamp: Number(r.blockTimestamp),
      delivered: Boolean(r?.delivered === true),
      dependencies: Array.isArray(r?.dependencies) ? r.dependencies.map((dep: any) => String(dep)) : undefined
    })) as UnclaimedRequest[];
  } catch (e) {
    workerLogger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Ponder GraphQL not reachable; returning empty set');
    return [];
  }
}

// Cached Web3/contract instances — avoids re-creation on every poll cycle
let cachedWeb3: InstanceType<typeof Web3> | null = null;
let cachedWeb3RpcUrl: string | null = null;
let cachedMarketplaceContract: any = null;
const MARKETPLACE_ADDRESS = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';

function getWeb3Singleton(rpcUrl: string): InstanceType<typeof Web3> {
  if (cachedWeb3 && cachedWeb3RpcUrl === rpcUrl) return cachedWeb3;
  cachedWeb3 = new Web3(rpcUrl);
  cachedWeb3RpcUrl = rpcUrl;
  cachedMarketplaceContract = null; // Invalidate contract on new provider
  return cachedWeb3;
}

function getMarketplaceContract(web3: InstanceType<typeof Web3>): any {
  if (cachedMarketplaceContract) return cachedMarketplaceContract;
  cachedMarketplaceContract = new (web3 as any).eth.Contract(marketplaceAbi, MARKETPLACE_ADDRESS);
  return cachedMarketplaceContract;
}

async function filterUnclaimed(requests: UnclaimedRequest[]): Promise<UnclaimedRequest[]> {
  if (requests.length === 0) return [];
  // Filter out already delivered requests first (from indexer)
  const notDelivered = requests.filter(r => !r.delivered);
  if (notDelivered.length === 0) return [];
  // Validate against marketplace delivery status to avoid stale indexer data
  try {
    const rpcHttpUrl = getRequiredRpcUrl();
    if (!rpcHttpUrl) {
      workerLogger.debug('RPC URL missing; falling back to Ponder status');
      return notDelivered;
    }

    const web3 = getWeb3Singleton(rpcHttpUrl);
    const marketplace = getMarketplaceContract(web3);

    const filtered: UnclaimedRequest[] = [];

    for (const request of notDelivered) {
      const requestId = String(request.id);
      try {
        const requestInfo = await marketplace.methods.mapRequestIdInfos(requestId).call();
        const isDelivered = requestInfo.deliveryMech !== '0x0000000000000000000000000000000000000000';

        if (!isDelivered) {
          filtered.push(request);
        } else {
          workerLogger.debug({
            requestId,
            deliveredByMech: requestInfo.deliveryMech
          }, 'Request already delivered in marketplace by another mech - filtering out');
        }
      } catch (err) {
        workerLogger.warn({ requestId, error: err instanceof Error ? err.message : String(err) }, 'Failed to check marketplace status for request; keeping request');
        filtered.push(request);
      }
    }

    return filtered;
  } catch (e) {
    workerLogger.warn({ error: e instanceof Error ? e.message : String(e) }, 'Error checking marketplace status, falling back to Ponder status');
    return notDelivered;
  }
}

/**
 * Resolve a dependency identifier to a job definition ID.
 * If the identifier is already a UUID, return it as-is.
 * If the identifier is a job name, try to resolve it within the workstream context.
 */
async function resolveJobDefinitionId(
  workstreamId: string | undefined,
  identifier: string
): Promise<string> {
  // Check if identifier is already a UUID
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (UUID_REGEX.test(identifier)) {
    return identifier;
  }

  // If no workstream context, can't resolve - return original
  if (!workstreamId) {
    workerLogger.debug({ identifier }, 'Cannot resolve dependency without workstream context');
    return identifier;
  }

  try {
    // Try to resolve by querying for requests with this job name in the workstream
    const query = `query ResolveJobDef($workstreamId: String!, $jobName: String!) {
      requests(
        where: { workstreamId: $workstreamId, jobName: $jobName }
        orderBy: "blockTimestamp"
        orderDirection: "desc"
        limit: 1
      ) {
        items {
          jobDefinitionId
        }
      }
    }`;

    const data = await graphQLRequest<{
      requests: { items: Array<{ jobDefinitionId?: string }> };
    }>({
      url: PONDER_GRAPHQL_URL,
      query,
      variables: { workstreamId, jobName: identifier },
      context: { operation: 'resolveJobDefinitionId', identifier, workstreamId }
    });

    const requests = data?.requests?.items || [];
    if (requests.length > 0 && requests[0].jobDefinitionId) {
      const resolvedId = requests[0].jobDefinitionId;
      workerLogger.debug({
        identifier,
        resolvedId,
        workstreamId
      }, 'Resolved job name to definition ID');
      return resolvedId;
    }

    // Not found - return original identifier
    workerLogger.debug({
      identifier,
      workstreamId
    }, 'Could not resolve job name - no matching requests found');
    return identifier;
  } catch (e: any) {
    workerLogger.warn({
      identifier,
      workstreamId,
      error: e instanceof Error ? e.message : String(e)
    }, 'Failed to resolve dependency identifier');
    return identifier;
  }
}

/**
 * Check if a job definition has at least one successfully delivered request.
 * This does NOT check child jobs - dependencies are shallow by design.
 * 
 * Rationale: Jobs only deliver when their agent decides they're complete.
 * If children are critical, the parent waits for them before delivering.
 * Dependencies just need to know "did this job finish?" (delivered = yes).
 */
export async function isJobDefinitionComplete(jobDefinitionId: string): Promise<boolean> {
  try {
    const status = await getJobDefinitionStatus(jobDefinitionId);
    if (!status.exists) {
      workerLogger.debug({ jobDefinitionId }, 'Job definition not found');
      return false;
    }

    // Job definition is complete only if lastStatus is terminal (COMPLETED/FAILED)
    // DELEGATING and WAITING mean work is still in progress
    const isComplete = isTerminalStatus(status.lastStatus);

    workerLogger.debug({
      jobDefinitionId,
      lastStatus: status.lastStatus,
      isComplete
    }, 'Job definition completion check (status-based)');

    return isComplete;
  } catch (e: any) {
    workerLogger.warn({
      jobDefinitionId,
      error: e instanceof Error ? e.message : String(e)
    }, 'Failed to check job definition completion - assuming not complete');
    return false;
  }
}

/**
 * Check if all job definition dependencies for a request are complete
 */
async function checkDependenciesMet(request: UnclaimedRequest): Promise<boolean> {
  // If no dependencies, job can proceed
  if (!request.dependencies || request.dependencies.length === 0) {
    return true;
  }

  try {
    // Resolve each dependency (name to ID if needed) and check completion
    const results = await Promise.all(
      request.dependencies.map(async (identifier) => {
        const resolvedId = await resolveJobDefinitionId(request.workstreamId, identifier);

        if (!isUuid(resolvedId)) {
          workerLogger.warn({
            requestId: request.id,
            identifier,
            resolvedId,
          }, 'Dependency identifier is not a UUID; cannot validate');
          return { identifier, resolvedId, isComplete: false, status: { exists: false } as JobDefinitionStatus };
        }

        const status = await getJobDefinitionStatus(resolvedId);
        const isComplete = status.exists && isTerminalStatus(status.lastStatus);

        if (!isComplete) {
          if (!status.exists) {
            await maybeCancelMissingDependency({ request, dependencyId: resolvedId });
          } else {
            await maybeRedispatchDependency({ request, dependencyId: resolvedId, status });
          }
        }

        return { identifier, resolvedId, isComplete, status };
      })
    );

    const allComplete = results.every(r => r.isComplete);

    if (!allComplete) {
      const incomplete = results.filter(r => !r.isComplete);
      workerLogger.info({
        requestId: request.id,
        totalDeps: request.dependencies.length,
        incompleteDeps: incomplete.map(r => ({
          identifier: r.identifier,
          resolvedId: r.resolvedId,
          wasResolved: r.identifier !== r.resolvedId,  // Shows if name→UUID resolution happened
          lastStatus: r.status?.lastStatus || (isUuid(r.resolvedId) ? 'UNKNOWN' : 'UNRESOLVED'),
          lastInteraction: r.status?.lastInteraction
        })),
      }, 'Dependencies not met - waiting for job definitions to complete');
    }

    return allComplete;
  } catch (e: any) {
    workerLogger.warn({
      requestId: request.id,
      error: e instanceof Error ? e.message : String(e)
    }, 'Failed to check dependencies - assuming not met');
    return false;
  }
}

/**
 * Filter requests to only include those with met dependencies
 */
async function filterByDependencies(requests: UnclaimedRequest[]): Promise<UnclaimedRequest[]> {
  const results = await Promise.all(
    requests.map(async (request) => ({
      request,
      canProceed: await checkDependenciesMet(request)
    }))
  );

  return results.filter(r => r.canProceed).map(r => r.request);
}

async function tryClaim(request: UnclaimedRequest, workerAddress: string): Promise<boolean> {
  const resolvedWorkstreamId = request.workstreamId || request.id;

  // Skip jobs already executed this session (prevents re-execution loop on delivery failure)
  if (executedJobsThisSession.has(request.id)) {
    workerLogger.info({
      requestId: request.id,
      workstreamId: resolvedWorkstreamId
    }, 'Already executed this session - skipping to prevent re-execution loop');
    return false;
  }

  try {
    // Control API is the only path for claiming
    try {
      const res = await apiClaimRequest(request.id);
      // Skip if already claimed by another worker or stuck IN_PROGRESS
      if (res?.alreadyClaimed) {
        workerLogger.info({
          requestId: request.id,
          status: res.status,
          workstreamId: resolvedWorkstreamId
        }, 'Already claimed - skipping');
        return false;
      }
      if (res && (res.status === 'IN_PROGRESS' || res.status === 'COMPLETED')) {
        const ok = res.status === 'IN_PROGRESS';
        workerLogger.info({
          requestId: request.id,
          status: res.status,
          workstreamId: resolvedWorkstreamId
        }, ok ? 'Claimed via Control API' : 'Already handled via Control API');
        return ok;
      }
      workerLogger.info({
        requestId: request.id,
        status: res?.status,
        workstreamId: resolvedWorkstreamId
      }, 'Unexpected claim response');
      return false;
    } catch (e: any) {
      workerLogger.info({
        requestId: request.id,
        reason: e?.message || String(e),
        workstreamId: resolvedWorkstreamId
      }, 'Control API claim failed');
      return false;
    }
  } catch (e: any) {
    workerLogger.warn({
      requestId: request.id,
      error: serializeError(e),
      workstreamId: resolvedWorkstreamId
    }, 'Claim error');
    return false;
  }
}


/**
 * Get branch information for a job definition by querying its codeMetadata
 * 
 * This queries the jobDefinition table directly for codeMetadata.branch.name, which is the same
 * data source used when passing child branch info to parents (via completedChildRuns).
 * This unifies how branch info is retrieved across the system.
 * 
 * @param jobDefinitionId - The job definition ID to get branch info for
 * @returns Branch name and base branch if found, null otherwise
 */
export async function getDependencyBranchInfo(jobDefinitionId: string): Promise<{
  branchName?: string;
  baseBranch?: string;
} | null> {
  try {
    // Query the job definition directly for codeMetadata
    // This is the same data source used for child → parent branch info
    const query = `query GetDependencyBranch($jobDefId: String!) {
      jobDefinition(id: $jobDefId) {
        id
        codeMetadata
      }
    }`;

    const data = await graphQLRequest<{
      jobDefinition: { id: string; codeMetadata?: any } | null;
    }>({
      url: PONDER_GRAPHQL_URL,
      query,
      variables: { jobDefId: jobDefinitionId },
      context: { operation: 'getDependencyBranchInfo', jobDefinitionId }
    });

    const jobDef = data?.jobDefinition;
    if (!jobDef) {
      workerLogger.debug({ jobDefinitionId }, 'No job definition found for dependency');
      return null;
    }

    // Extract branch info from codeMetadata
    const codeMetadata = jobDef.codeMetadata;
    if (!codeMetadata) {
      workerLogger.debug({ jobDefinitionId }, 'No codeMetadata on dependency job definition');
      return null;
    }

    // codeMetadata.branch.name contains the branch name
    // codeMetadata.baseBranch contains the base branch
    const branchName = codeMetadata.branch?.name;
    const baseBranch = codeMetadata.baseBranch || DEFAULT_BASE_BRANCH;

    if (branchName) {
      workerLogger.debug({
        jobDefinitionId,
        branchName,
        baseBranch
      }, 'Found branch info from dependency job definition codeMetadata');

      return { branchName, baseBranch };
    }

    workerLogger.debug({ jobDefinitionId }, 'No branch name in dependency codeMetadata');
    return null;
  } catch (e: any) {
    workerLogger.warn({
      jobDefinitionId,
      error: e instanceof Error ? e.message : String(e)
    }, 'Failed to get dependency branch info');
    return null;
  }
}



/**
 * Check if a job chain is complete by verifying all requests are delivered
 */
async function isChainComplete(rootJobDefinitionId: string): Promise<boolean> {
  try {
    const data = await graphQLRequest<{ requests: { items: Array<{ id: string; delivered: boolean }> } }>({
      url: PONDER_GRAPHQL_URL,
      query: `query($rootId: String!) {
        requests(where: { sourceJobDefinitionId: $rootId }) {
          items {
            id
            delivered
          }
        }
      }`,
      variables: { rootId: rootJobDefinitionId },
      context: { operation: 'isChainComplete', rootJobDefinitionId }
    });
    const requests = data?.requests?.items || [];

    if (requests.length === 0) {
      return false; // No requests in chain
    }

    // Check if all requests are delivered
    return requests.every((req: any) => req.delivered);
  } catch (e) {
    workerLogger.error({ error: e, rootJobDefinitionId }, `Error checking chain completion for ${rootJobDefinitionId}`);
    return false;
  }
}

/**
 * Check if a job should be reposted based on recent repost history
 */
function shouldRepost(rootJobDefinitionId: string): boolean {
  const now = Date.now();
  const lastRepost = recentReposts.get(rootJobDefinitionId);

  if (lastRepost && (now - lastRepost) < MIN_TIME_BETWEEN_REPOSTS) {
    return false;
  }

  return true;
}

/**
 * Repost an existing job definition using the dispatch_existing_job pattern
 */
async function repostExistingJob(jobDefinitionId: string): Promise<void> {
  try {
    // Query for the most recent request of this job to establish lineage
    const queryData = await graphQLRequest<{ requests: { items: Array<{ id: string }> } }>({
      url: PONDER_GRAPHQL_URL,
      query: `query {
        requests(
          where: { jobDefinitionId: "${jobDefinitionId}" },
          orderBy: "blockTimestamp",
          orderDirection: "desc",
          limit: 1
        ) {
          items { id }
        }
      }`,
      context: { operation: 'repostExistingJob', jobDefinitionId }
    });
    const mostRecentRequest = queryData?.requests?.items?.[0];

    // Build message indicating this is a repost after completion
    const message = mostRecentRequest ? JSON.stringify({
      content: "Reposting job after workstream completion",
      from: mostRecentRequest.id,
      to: jobDefinitionId
    }) : undefined;

    const result = await dispatchExistingJob({
      jobId: jobDefinitionId,
      message,
      // Include inherited env vars for workstream-level config propagation
      additionalContext: { env: getInheritedEnv() }
    });

    // Parse the result to check if it was successful
    const { ok, data, message: errMsg } = safeParseToolResponse(result);
    if (!ok) {
      workerLogger.error(`Cannot repost job ${jobDefinitionId}: ${errMsg || 'Unknown error'}`);
      return;
    }

    // Track the repost to prevent loops
    recentReposts.set(jobDefinitionId, Date.now());

    workerLogger.info(`Successfully reposted job (${jobDefinitionId}) after chain completion`);
    workerLogger.info({ data }, 'Repost result');

  } catch (e) {
    workerLogger.error({ error: e, jobDefinitionId }, `Error reposting job ${jobDefinitionId}`);
  }
}

/**
 * Check for completed decomposition chains and repost root jobs if needed
 */
async function checkAndRepostCompletedChains(): Promise<void> {
  if (!ENABLE_AUTO_REPOST) {
    return;
  }

  try {
    // Find all root job definitions (no sourceJobDefinitionId)
    const data = await graphQLRequest<{ jobDefinitions: { items: Array<{ id: string; name: string }> } }>({
      url: PONDER_GRAPHQL_URL,
      query: `query {
        jobDefinitions(where: { sourceJobDefinitionId: { equals: null } }, limit: 100) {
          items {
            id
            name
          }
        }
      }`,
      context: { operation: 'checkAndRepostCompletedChains' }
    });
    const rootJobDefs = data?.jobDefinitions?.items || [];

    for (const rootJobDef of rootJobDefs) {
      // Skip if recently reposted
      if (!shouldRepost(rootJobDef.id)) {
        continue;
      }

      // Check if chain is complete and repost if needed
      if (await isChainComplete(rootJobDef.id)) {
        workerLogger.info(`Found completed chain for root job ${rootJobDef.name}, reposting...`);
        await repostExistingJob(rootJobDef.id);
      }
    }
  } catch (e) {
    workerLogger.error({ error: e }, 'Error checking for completed chains');
  }
}


async function fetchSpecificRequest(requestId: string): Promise<UnclaimedRequest | null> {
  try {
    const query = `query GetRequest($id: String!) {
  requests(where: { id: $id }) {
    items {
      id
      mech
      sender
      ipfsHash
      blockTimestamp
      delivered
      dependencies
    }
  }
}`;
    const data = await graphQLRequest<{ requests: { items: any[] } }>({
      url: PONDER_GRAPHQL_URL,
      query,
      variables: { id: requestId },
      context: { operation: 'fetchSpecificRequest', requestId }
    });
    const items = data?.requests?.items || [];
    if (items.length === 0) return null;
    const r = items[0];
    return {
      id: String(r.id),
      mech: String(r.mech),
      requester: String(r.sender || ''),
      ipfsHash: r?.ipfsHash ? String(r.ipfsHash) : undefined,
      blockTimestamp: Number(r.blockTimestamp),
      delivered: Boolean(r?.delivered === true),
      dependencies: Array.isArray(r?.dependencies) ? r.dependencies.map((dep: any) => String(dep)) : undefined
    };
  } catch (e: any) {
    workerLogger.warn({ error: serializeError(e) }, 'Error fetching specific request');
    return null;
  }
}


/**
 * Process one iteration of the worker loop.
 * @returns true if a job was processed, false if idle (no work found or claimed)
 */
async function processOnce(): Promise<boolean> {
  const workerAddress = getMechAddress();
  if (!workerAddress) {
    workerLogger.error('Missing service mech address in .operate config or environment');
    return false;
  }

  // Optional: target a specific request id if provided (for deterministic tests)
  const targetIdEnv = (getOptionalMechTargetRequestId() || '').trim();
  let candidates: UnclaimedRequest[];

  if (targetIdEnv) {
    const targetHex = targetIdEnv.startsWith('0x') ? targetIdEnv.toLowerCase() : ('0x' + BigInt(targetIdEnv).toString(16)).toLowerCase();
    const specificRequest = await fetchSpecificRequest(targetHex);
    if (!specificRequest) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info({ target: targetHex }, 'Target request not found in Ponder');
      return false;
    }
    if (specificRequest.delivered) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info({ target: targetHex }, 'Target request already delivered');
      return false;
    }

    // Check dependencies even for targeted requests
    const depsMet = await checkDependenciesMet(specificRequest);
    if (!depsMet) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info({ target: targetHex }, 'Target request dependencies not met - skipping');
      return false;
    }

    candidates = [specificRequest];
    workerLogger.info({ target: targetHex }, 'Targeting specific request');
  } else {
    const recent = await fetchRecentRequests(50);
    candidates = await filterUnclaimed(recent);
    if (candidates.length === 0) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info('No unclaimed on-chain requests found');
      return false;
    }

    // Filter by dependencies - only process jobs whose dependencies are met
    candidates = await filterByDependencies(candidates);
    if (candidates.length === 0) {
      consecutiveStuckCycles = 0;
      lastStuckRequestIds = [];
      workerLogger.info('No requests with met dependencies found');
      return false;
    }
  }

  const eligibleCandidates = candidates.filter(c => !executedJobsThisSession.has(c.id));
  if (eligibleCandidates.length === 0) {
    consecutiveStuckCycles += 1;
    lastStuckRequestIds = candidates.map(c => c.id);
    workerLogger.warn({
      consecutiveStuckCycles,
      maxStuckCycles: MAX_STUCK_CYCLES,
      requestIds: lastStuckRequestIds
    }, 'All candidates already executed this session - stuck cycle');

    if (MAX_STUCK_CYCLES !== undefined && consecutiveStuckCycles >= MAX_STUCK_CYCLES) {
      workerLogger.error({
        consecutiveStuckCycles,
        requestIds: lastStuckRequestIds
      }, 'Stuck cycle limit reached; exiting to allow restart');
      process.exit(2);
    }
    return false;
  }

  consecutiveStuckCycles = 0;
  lastStuckRequestIds = [];

  // Try to claim a request
  let target: UnclaimedRequest | null = null;
  for (const c of candidates) {
    const ok = await tryClaim(c, workerAddress);
    if (ok) {
      target = c;
      break;
    }
  }

  if (!target) return false;

  // Wait for quota only after successful claim (lazy quota check)
  // This eliminates quota API calls during idle periods
  await waitForGeminiQuota({ reason: 'pre_execution' });

  // Delegate job execution to orchestrator
  try {
    await processJobOnce(target, workerAddress);
  } finally {
    // Mark as executed even if delivery fails to prevent re-execution loop
    executedJobsThisSession.set(target.id, Date.now());
    workerLogger.debug({ requestId: target.id }, 'Marked job as executed this session');
  }

  // Post-job delay to spread API usage over time (helps with quota limits)
  const jobDelayMs = getOptionalWorkerJobDelayMs();
  if (jobDelayMs && jobDelayMs > 0) {
    workerLogger.info({ delayMs: jobDelayMs }, 'Post-job delay before next cycle');
    await new Promise(r => setTimeout(r, jobDelayMs));
  }

  return true; // Job was processed
}

/**
 * Health check for Control API at startup
 */
async function checkControlApiHealth(): Promise<void> {
  if (!USE_CONTROL_API) {
    return; // Control API disabled, skip check
  }

  try {
    // Control API requires ERC-8128 signatures for all GraphQL operations.
    const body = {
      query: `query { __typename }`,
      variables: {},
    };
    const baseHeaders = {
      'Content-Type': 'application/json',
      'Idempotency-Key': `healthcheck:${Date.now()}`,
    };
    const headers = await signControlApiHeaders(CONTROL_API_URL, body, baseHeaders);

    const result = await graphQLRequest<{ __typename: string }>({
      url: CONTROL_API_URL,
      query: body.query,
      variables: body.variables,
      headers,
      maxRetries: 0,
      context: { operation: 'healthCheck' }
    });
    if (!result?.__typename) {
      throw new Error('Control API health check returned empty payload');
    }
    workerLogger.info({ controlApiUrl: CONTROL_API_URL }, 'Control API health check passed');
  } catch (e: any) {
    workerLogger.error({
      error: serializeError(e),
      controlApiUrl: CONTROL_API_URL
    }, 'Control API is not running - worker cannot start');
    throw new Error('Control API health check failed: ' + (e?.message || String(e)) + '\n\nPlease start Control API with: yarn control:dev');
  }
}

// Repost check frequency limiting configuration
const WORKER_REPOST_CHECK_CYCLES = parseInt(process.env.WORKER_REPOST_CHECK_CYCLES || '10');

async function main() {
  const templatePickupEnabled = !!(process.env.SUPABASE_URL || VENTURE_TEMPLATE_IDS.length > 0);
  workerLogger.info({
    workstreamFilters: WORKSTREAM_FILTERS.length > 0 ? WORKSTREAM_FILTERS : 'none',
    ventureTemplateIds: VENTURE_TEMPLATE_IDS.length > 0 ? VENTURE_TEMPLATE_IDS : 'none (dynamic via Supabase)',
    templatePickupEnabled,
    templateValidationMode: process.env.SUPABASE_URL ? 'supabase' : (VENTURE_TEMPLATE_IDS.length > 0 ? 'env-allowlist' : 'disabled'),
  }, 'Mech worker starting');

  // Verify Control API is running before processing any jobs
  await checkControlApiHealth();

  if (SINGLE_SHOT) {
    await processOnce();
    return;
  }

  let runCount = 0;

  // Adaptive polling state
  let consecutiveIdleCycles = 0;
  let currentPollIntervalMs = WORKER_POLL_BASE_MS;

  // Repost check frequency limiting
  let cyclesSinceLastRepostCheck = 0;
  let cyclesSinceLastCleanup = 0;

  for (; ;) {
    const cycleStart = Date.now();
    try {
      if (shouldStop()) {
        workerLogger.info('Stop signal detected before poll - exiting worker loop');
        return;
      }

      // Check for completed chains only every Nth cycle (reduces DB queries when idle)
      cyclesSinceLastRepostCheck++;
      if (cyclesSinceLastRepostCheck >= WORKER_REPOST_CHECK_CYCLES) {
        await checkAndRepostCompletedChains();
        cyclesSinceLastRepostCheck = 0;
      }

      // Evict stale entries from global maps to prevent unbounded growth
      cyclesSinceLastCleanup++;
      if (cyclesSinceLastCleanup >= MAP_CLEANUP_INTERVAL_CYCLES) {
        cleanupGlobalMaps();
        cyclesSinceLastCleanup = 0;
      }

      const jobProcessed = await processOnce();
      const cycleEnd = Date.now();
      const cycleDurationMs = cycleEnd - cycleStart;

      // Record efficiency metrics for healthcheck
      if (jobProcessed) {
        recordExecutionTime(cycleDurationMs);
        consecutiveIdleCycles = 0;
        currentPollIntervalMs = WORKER_POLL_BASE_MS;
      } else {
        recordIdleCycle(cycleDurationMs);
        consecutiveIdleCycles++;
        currentPollIntervalMs = Math.min(
          WORKER_POLL_MAX_MS,
          Math.floor(WORKER_POLL_BASE_MS * Math.pow(WORKER_POLL_BACKOFF_FACTOR, consecutiveIdleCycles))
        );
      }
      workerLogger.debug({ consecutiveIdleCycles, nextPollMs: currentPollIntervalMs, jobProcessed, cycleDurationMs }, 'Adaptive polling');

      if (shouldStop()) {
        workerLogger.info('Stop signal detected after job processing - exiting worker loop');
        return;
      }

      // Check if we've reached the max runs limit
      if (MAX_RUNS !== undefined) {
        runCount++;
        if (runCount >= MAX_RUNS) {
          workerLogger.info({ totalRuns: runCount, maxRuns: MAX_RUNS }, 'Reached maximum runs - stopping worker');
          return;
        }
      }
    } catch (e: any) {
      workerLogger.error({ error: serializeError(e) }, 'Error in mech loop');
    }
    await new Promise(r => setTimeout(r, currentPollIntervalMs));
  }
}

main().catch((err) => {
  workerLogger.error({ error: serializeError(err) }, 'Fatal: unhandled error escaped main loop');
  process.exit(1);
});
