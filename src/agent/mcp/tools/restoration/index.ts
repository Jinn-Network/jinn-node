/**
 * MCP Tools for the EIP-8183 Restoration Marketplace + 8004 Documents
 *
 * Tools are organized by session type:
 * - CREATE: create_restoration_job
 * - DELIVER: list_available_jobs, claim_job, submit_deliverable
 * - EVALUATE: list_submitted_jobs, get_deliverable, complete_job, reject_job
 * - ALL: create_8004_document, search_8004_documents
 *
 * Part of JINN-457: Invariant Restoration Marketplace on EIP-8183
 */

import { z } from 'zod';

// ============ Tool Schemas ============

export const createRestorationJobParams = z.object({
  description: z.string().min(10).describe('IPFS CID or full text description of the invariant to restore'),
  evaluator: z.string().optional().describe('Evaluator address (defaults to network evaluator)'),
  expiryHours: z.number().min(1).max(720).default(168).describe('Hours until job expires (default: 168 = 1 week)'),
});

export const createRestorationJobSchema = {
  description: `Create a new restoration job on the EIP-8183 marketplace.
Posts an invariant definition for other agents to solve. The job is created through
the MarketplaceProxy so any agent on the network can claim it.

Parameters:
- description: The invariant to restore. Be specific about what "restored" means.
- evaluator: (optional) Address of the evaluator. Defaults to network evaluator.
- expiryHours: (optional) How long before the job expires. Default 1 week.

Returns: { jobId, transactionHash }`,
  inputSchema: createRestorationJobParams.shape,
};

export const listAvailableJobsParams = z.object({
  limit: z.number().min(1).max(50).default(10).describe('Maximum jobs to return'),
});

export const listAvailableJobsSchema = {
  description: `List funded restoration jobs available for claiming on the EIP-8183 marketplace.
Returns jobs with status=Funded that have no provider assigned yet.

Parameters:
- limit: (optional) Maximum number of jobs to return. Default 10.

Returns: Array of { jobId, description, budget, expiredAt, evaluator }`,
  inputSchema: listAvailableJobsParams.shape,
};

export const claimJobParams = z.object({
  jobId: z.number().int().positive().describe('The 8183 job ID to claim'),
});

export const claimJobSchema = {
  description: `Claim a funded restoration job as provider.
After claiming, you are responsible for restoring the invariant and submitting proof.

Parameters:
- jobId: The marketplace job ID to claim.

Returns: { success, transactionHash }`,
  inputSchema: claimJobParams.shape,
};

export const submitDeliverableParams = z.object({
  jobId: z.number().int().positive().describe('The 8183 job ID'),
  deliverableCID: z.string().min(1).describe('IPFS CID of the deliverable (restoration proof + artifacts)'),
});

export const submitDeliverableSchema = {
  description: `Submit a deliverable for a claimed restoration job.
The deliverable should contain evidence that the invariant was restored,
plus references to any knowledge documents produced.

Parameters:
- jobId: The marketplace job ID.
- deliverableCID: IPFS CID containing the restoration proof.

Returns: { success, transactionHash }`,
  inputSchema: submitDeliverableParams.shape,
};

export const listSubmittedJobsParams = z.object({
  limit: z.number().min(1).max(50).default(10).describe('Maximum jobs to return'),
});

export const listSubmittedJobsSchema = {
  description: `List submitted restoration jobs awaiting evaluation.
Returns jobs with status=Submitted that need an evaluator decision.

Parameters:
- limit: (optional) Maximum number of jobs to return. Default 10.

Returns: Array of { jobId, provider, deliverable, budget }`,
  inputSchema: listSubmittedJobsParams.shape,
};

export const getDeliverableParams = z.object({
  jobId: z.number().int().positive().describe('The 8183 job ID'),
});

export const getDeliverableSchema = {
  description: `Fetch the deliverable content for a submitted job.
Retrieves the IPFS content referenced in the JobSubmitted event.

Parameters:
- jobId: The marketplace job ID.

Returns: { jobId, deliverableCID, content }`,
  inputSchema: getDeliverableParams.shape,
};

export const completeJobParams = z.object({
  jobId: z.number().int().positive().describe('The 8183 job ID to approve'),
  reasonCID: z.string().min(1).describe('IPFS CID of the evaluation report'),
});

export const completeJobSchema = {
  description: `Approve a submitted restoration job, releasing escrowed payment to the provider.
Call this when the deliverable meets the evaluation criteria.

Parameters:
- jobId: The marketplace job ID.
- reasonCID: IPFS CID of your evaluation report.

Returns: { success, transactionHash }`,
  inputSchema: completeJobParams.shape,
};

export const rejectJobParams = z.object({
  jobId: z.number().int().positive().describe('The 8183 job ID to reject'),
  reasonCID: z.string().min(1).describe('IPFS CID of the rejection reason'),
});

export const rejectJobSchema = {
  description: `Reject a submitted restoration job, refunding the client.
Call this when the deliverable fails the evaluation criteria.

Parameters:
- jobId: The marketplace job ID.
- reasonCID: IPFS CID of your rejection reason.

Returns: { success, transactionHash }`,
  inputSchema: rejectJobParams.shape,
};

export const create8004DocumentParams = z.object({
  name: z.string().min(1).describe('Document name'),
  content: z.string().min(1).describe('Document content (knowledge, findings, strategies)'),
  tags: z.array(z.string()).optional().describe('Tags for discovery'),
});

export const create8004DocumentSchema = {
  description: `Create a knowledge document and register it on ERC-8004.
Documents are the lasting asset of the network — they help future agents
perform better restorations. Produce documents liberally.

Parameters:
- name: Descriptive name for the document.
- content: The knowledge content to store.
- tags: (optional) Tags for discoverability.

Returns: { cid, contentCid, documentId, name }`,
  inputSchema: create8004DocumentParams.shape,
};

export const search8004DocumentsParams = z.object({
  query: z.string().min(1).describe('Search query (semantic or keyword)'),
  limit: z.number().min(1).max(20).default(5).describe('Maximum results'),
});

export const search8004DocumentsSchema = {
  description: `Search for knowledge documents on the ERC-8004 network.
Use this to find relevant learnings, strategies, and past restoration attempts
before starting your own work.

Parameters:
- query: Search terms describing what you're looking for.
- limit: (optional) Maximum results. Default 5.

Returns: Array of { documentId, name, contentPreview, tags, creator }`,
  inputSchema: search8004DocumentsParams.shape,
};
