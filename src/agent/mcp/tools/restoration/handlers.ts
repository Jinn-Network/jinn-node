/**
 * MCP Tool Handlers for the EIP-8183 Restoration Marketplace
 *
 * Each handler receives parsed params and returns a result object.
 * The handlers use RestorationMarketplace and EventPoller instances
 * that are injected at setup time.
 *
 * Part of JINN-457: Invariant Restoration Marketplace on EIP-8183
 */

import { Wallet } from 'ethers';
import { pushJsonToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';
import { buildRegistrationFile, formatCreatorId } from '../../../../shared/registry/registration.js';
import { signRegistrationFile } from '../../../../shared/registry/signing.js';
import { getServicePrivateKey, getServiceSafeAddress } from '../../../../env/operate-profile.js';
import { resolveIpfsContent } from '../shared/ipfs.js';
import {
  RestorationMarketplace,
  JobStatus,
} from '../../../../worker/contracts/RestorationMarketplace.js';
import { EventPoller } from '../../../../worker/polling/EventPoller.js';

export interface HandlerContext {
  marketplace: RestorationMarketplace;
  poller: EventPoller;
  /** Default evaluator address for CREATE sessions */
  defaultEvaluator?: string;
}

let ctx: HandlerContext | null = null;

/** Initialize handler context (called once at worker startup) */
export function initHandlers(context: HandlerContext): void {
  ctx = context;
}

/** Lazily initialize from env vars if not explicitly initialized */
function getCtx(): HandlerContext {
  if (!ctx) {
    // Auto-initialize from env vars for standalone MCP server usage
    const proxyAddress = process.env.MARKETPLACE_PROXY_ADDRESS;
    const activityCheckerAddress = process.env.ACTIVITY_CHECKER_ADDRESS;
    if (!proxyAddress || !activityCheckerAddress) {
      throw new Error(
        'Restoration handlers not initialized. Either call initHandlers() or set ' +
        'MARKETPLACE_PROXY_ADDRESS and ACTIVITY_CHECKER_ADDRESS env vars.',
      );
    }

    const marketplace = new RestorationMarketplace({
      acpCoreAddress: process.env.ACP_CORE_ADDRESS ?? '0x16213AB6a660A24f36d4F8DdACA7a3d0856A8AF5',
      proxyAddress,
      activityCheckerAddress,
    });

    const poller = new EventPoller({
      checkpointPath: process.env.POLLER_CHECKPOINT_PATH,
    });

    ctx = {
      marketplace,
      poller,
      defaultEvaluator: process.env.DEFAULT_EVALUATOR_ADDRESS,
    };
  }
  return ctx;
}

function getWallet(): Wallet {
  const pk = getServicePrivateKey();
  if (!pk) throw new Error('No service private key available');
  return new Wallet(pk);
}

function getSafe(): string {
  const safe = getServiceSafeAddress();
  if (!safe) throw new Error('No service Safe address available');
  return safe;
}

// ============ CREATE ============

export async function handleCreateRestorationJob(params: {
  description: string;
  evaluator?: string;
  expiryHours: number;
}): Promise<{ jobId: number; transactionHash: string }> {
  const { marketplace } = getCtx();
  const wallet = getWallet();
  const safe = getSafe();

  const evaluator = params.evaluator ?? getCtx().defaultEvaluator;
  if (!evaluator) throw new Error('No evaluator address specified and no default configured');

  const expiredAt = Math.floor(Date.now() / 1000) + params.expiryHours * 3600;

  const { jobId, receipt } = await marketplace.createRestorationJob(
    safe, wallet, evaluator, expiredAt, params.description,
  );

  return { jobId, transactionHash: receipt.hash };
}

// ============ DELIVER ============

export async function handleListAvailableJobs(params: {
  limit: number;
}): Promise<Array<{ jobId: number; description: string; budget: string; expiredAt: string; evaluator: string }>> {
  const { marketplace, poller } = getCtx();

  // Use EventPoller cache — avoids N+1 sequential RPC calls
  await poller.poll();
  const fundedEvents = poller.getFundedJobs();
  const createdEvents = poller.getCreatedJobs();

  // Build a set of funded job IDs, then enrich with on-chain data (only for matches)
  const fundedJobIds = new Set(fundedEvents.map(e => e.jobId));
  // Also include created jobs that might be open with a budget
  const candidateIds = [...fundedJobIds, ...createdEvents.map(e => e.jobId)];
  const uniqueIds = [...new Set(candidateIds)].sort((a, b) => b - a).slice(0, params.limit * 2);

  const jobs: Array<{ jobId: number; description: string; budget: string; expiredAt: string; evaluator: string }> = [];
  // Fetch details only for candidates (parallel, bounded)
  const details = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const [job, description] = await Promise.all([
          marketplace.getJob(id),
          marketplace.getDescription(id),
        ]);
        return { id, job, description };
      } catch { return null; }
    }),
  );

  for (const d of details) {
    if (!d) continue;
    if (d.job.status === JobStatus.Funded || (d.job.status === JobStatus.Open && d.job.budget > 0n)) {
      jobs.push({
        jobId: d.id,
        description: d.description,
        budget: d.job.budget.toString(),
        expiredAt: new Date(Number(d.job.expiredAt) * 1000).toISOString(),
        evaluator: d.job.evaluator,
      });
      if (jobs.length >= params.limit) break;
    }
  }

  return jobs;
}

export async function handleClaimJob(params: {
  jobId: number;
}): Promise<{ success: boolean; transactionHash: string }> {
  const { marketplace } = getCtx();
  const wallet = getWallet();
  const safe = getSafe();

  const receipt = await marketplace.claimRestorationJob(safe, wallet, params.jobId);
  return { success: true, transactionHash: receipt.hash };
}

export async function handleSubmitDeliverable(params: {
  jobId: number;
  deliverableCID: string;
}): Promise<{ success: boolean; transactionHash: string }> {
  const { marketplace } = getCtx();
  const wallet = getWallet();

  const receipt = await marketplace.submitDeliverable(wallet, params.jobId, params.deliverableCID);
  return { success: true, transactionHash: receipt.hash };
}

// ============ EVALUATE ============

export async function handleListSubmittedJobs(params: {
  limit: number;
}): Promise<Array<{ jobId: number; provider: string; budget: string }>> {
  const { marketplace, poller } = getCtx();

  // Use EventPoller cache — avoids N+1 sequential RPC calls
  await poller.poll();
  const submittedEvents = poller.getSubmittedJobs();
  const candidateIds = [...new Set(submittedEvents.map(e => e.jobId))].sort((a, b) => b - a).slice(0, params.limit * 2);

  const jobs: Array<{ jobId: number; provider: string; budget: string }> = [];
  const details = await Promise.all(
    candidateIds.map(async (id) => {
      try { return { id, job: await marketplace.getJob(id) }; }
      catch { return null; }
    }),
  );

  for (const d of details) {
    if (!d || d.job.status !== JobStatus.Submitted) continue;
    jobs.push({
      jobId: d.id,
      provider: d.job.provider,
      budget: d.job.budget.toString(),
    });
    if (jobs.length >= params.limit) break;
  }

  return jobs;
}

export async function handleGetDeliverable(params: {
  jobId: number;
}): Promise<{ jobId: number; deliverableCID: string; content: any }> {
  const { poller } = getCtx();

  // Find the JobSubmitted event for this job
  const events = poller.getSubmittedJobs();
  const submitted = events.find(e => e.jobId === params.jobId);

  if (!submitted) {
    throw new Error(`No submission found for job ${params.jobId}. Try polling first.`);
  }

  // Fetch IPFS content
  const content = await resolveIpfsContent(submitted.deliverable, '');

  return {
    jobId: params.jobId,
    deliverableCID: submitted.deliverable,
    content,
  };
}

export async function handleCompleteJob(params: {
  jobId: number;
  reasonCID: string;
}): Promise<{ success: boolean; transactionHash: string }> {
  const { marketplace } = getCtx();
  const wallet = getWallet();

  const receipt = await marketplace.completeJob(wallet, params.jobId, params.reasonCID);
  return { success: true, transactionHash: receipt.hash };
}

export async function handleRejectJob(params: {
  jobId: number;
  reasonCID: string;
}): Promise<{ success: boolean; transactionHash: string }> {
  const { marketplace } = getCtx();
  const wallet = getWallet();

  const receipt = await marketplace.rejectJob(wallet, params.jobId, params.reasonCID);
  return { success: true, transactionHash: receipt.hash };
}

// ============ 8004 Documents ============

export async function handleCreate8004Document(params: {
  name: string;
  content: string;
  tags?: string[];
}): Promise<{ cid: string; contentCid: string; name: string }> {
  const workerAddress = getServiceSafeAddress() ?? 'unknown';
  const privateKey = getServicePrivateKey();

  // Upload content to IPFS
  const payload = {
    name: params.name,
    content: params.content,
    tags: params.tags ?? [],
    createdAt: new Date().toISOString(),
  };
  const [, contentCid] = await pushJsonToIpfs(payload);

  // Build registration file
  const registration = buildRegistrationFile({
    contentHash: contentCid,
    name: params.name,
    description: params.content.slice(0, 200),
    documentType: 'adw:Knowledge',
    creator: formatCreatorId(workerAddress),
    storage: [{ provider: 'ipfs' as const, uri: `ipfs://${contentCid}` }],
    tags: params.tags,
  });

  // Sign if possible
  if (privateKey) {
    try {
      const trust = await signRegistrationFile(registration, privateKey as `0x${string}`);
      (registration as any).trust = trust;
    } catch { /* signing is best-effort */ }
  }

  // Upload registration file
  const [, registrationCid] = await pushJsonToIpfs(registration);

  return {
    cid: registrationCid,
    contentCid,
    name: params.name,
  };
}

export async function handleSearch8004Documents(params: {
  query: string;
  limit: number;
}): Promise<Array<{ documentId: string; name: string; contentPreview: string; tags: string[] }>> {
  const { poller } = getCtx();

  // For now, search the local event cache for registered documents
  // In the future, this will query x402 endpoints on other nodes
  const documents = poller.getDocuments();

  // Simple keyword matching on documentURI and documentType
  const queryLower = params.query.toLowerCase();
  const matches = documents
    .filter(d => d.documentURI.toLowerCase().includes(queryLower) ||
                 d.documentType.toLowerCase().includes(queryLower))
    .slice(0, params.limit)
    .map(d => ({
      documentId: d.documentId.toString(),
      name: d.documentURI,
      contentPreview: `Type: ${d.documentType}, Hash: ${d.contentHash.slice(0, 16)}...`,
      tags: [],
    }));

  return matches;
}
