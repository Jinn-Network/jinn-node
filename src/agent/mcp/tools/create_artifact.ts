import { z } from 'zod';
import { pushJsonToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';

export const createArtifactParams = z.object({
  name: z.string().min(1),
  topic: z.string().min(1),
  content: z.string().min(1),
  mimeType: z.string().optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const createArtifactSchema = {
  description: `Uploads content to IPFS and returns { cid, name, topic, contentPreview }.

MANDATORY USE CASES:
- Research findings and analysis results
- Generated code, configurations, schemas
- Multi-step process outputs and summaries
- Data extractions or transformations
- Any substantial deliverable for parent job review

MEMORY CREATION:
When type='MEMORY', this tool creates a reusable knowledge artifact that will be indexed and made available to all future jobs. Use liberally after discovering solutions, workarounds, or strategies that could benefit other executions.

Parameters:
- name: Descriptive name for the artifact
- topic: Category or subject matter
- content: The actual content to store
- mimeType: (optional) MIME type, defaults to 'text/plain'
- type: (optional) Artifact type (e.g., 'MEMORY', 'RESEARCH_REPORT')
- tags: (optional) Array of descriptive tags for discovery (e.g., ['staking', 'bug-fix', 'optimization'])

Execution summaries document process; artifacts persist deliverables. Use create_artifact liberally for all substantial work outputs to ensure discoverability via search_artifacts.`,
  inputSchema: createArtifactParams.shape,
};

export async function createArtifact(args: unknown) {
  try {
    const parsed = createArtifactParams.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message } }) }] };
    }
    const { name, topic, content, mimeType, type, tags } = parsed.data;

    const contentPreview = content.slice(0, 100);
    const payload = { name, topic, content, mimeType: mimeType || 'text/plain', type, tags } as const;

    // Upload to IPFS and return artifact metadata
    // Worker will extract this from telemetry and include in delivery payload
    const [, cidHex] = await pushJsonToIpfs(payload);
    const cid = cidHex;

    const result = { cid, name, topic, contentPreview, type, tags };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ data: result, meta: { ok: true } }) }] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ data: null, meta: { ok: false, code: 'EXECUTION_ERROR', message } }) }] };
  }
}
