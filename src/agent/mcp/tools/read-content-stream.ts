import { z } from 'zod';
import fetch from 'cross-fetch';
import { getPonderGraphqlUrl } from './shared/env.js';

export const readContentStreamParams = z.object({
  stream: z.string().min(1).refine(s => s.startsWith('FEED:'), {
    message: 'Stream name must start with "FEED:"',
  }).describe('The stream topic to read (e.g., "FEED:commit-highlights").'),
  since: z.string().optional().describe('ISO timestamp — only return items created after this time. Defaults to last 24 hours.'),
  limit: z.number().int().positive().max(100).optional().default(20).describe('Max items to return.'),
});

export type ReadContentStreamParams = z.infer<typeof readContentStreamParams>;

export const readContentStreamSchema = {
  description: 'Read items from a specific content stream. Returns artifacts ordered by most recent first. Use search_content_streams first to discover available streams.',
  inputSchema: readContentStreamParams.shape,
};

export async function readContentStream(params: unknown) {
  try {
    const parsed = readContentStreamParams.safeParse(params);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: [],
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
          }),
        }],
      };
    }

    const { stream, since, limit } = parsed.data;

    // Default since to 24h ago if not provided
    const sinceTs = since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const PONDER_GRAPHQL_URL = getPonderGraphqlUrl();
    const gql = `query ReadContentStream($topic: String!, $limit: Int!) {
      artifacts(where: { topic: $topic }, limit: $limit, orderBy: "id", orderDirection: "desc") {
        items {
          id name contentPreview cid requestId
        }
      }
    }`;

    const variables = { topic: stream, limit };
    const res = await fetch(PONDER_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables }),
    });

    const json = await res.json();
    const artifacts = json?.data?.artifacts?.items || [];

    // Map results to the expected shape
    const data = artifacts.map((a: any) => ({
      name: a.name,
      contentPreview: a.contentPreview,
      cid: a.cid,
      requestId: a.requestId,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data,
          meta: { ok: true, source: 'ponder', type: 'content_stream', stream, since: sinceTs },
        }),
      }],
    };
  } catch (e: any) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: [],
          meta: { ok: false, code: 'EXECUTION_ERROR', message: e?.message || String(e) },
        }),
      }],
    };
  }
}
