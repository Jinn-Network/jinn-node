import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { getVenture, getVentureBySlug, listVentures } from '../../../../../scripts/ventures/mint.js';

/**
 * Input schema for querying ventures.
 */
export const ventureQueryParams = z.object({
  mode: z.enum(['get', 'list', 'by_slug', 'by_workstream']).default('list').describe('Query mode'),
  id: z.string().uuid().optional().describe('Venture ID (for get mode)'),
  slug: z.string().optional().describe('Venture slug (for by_slug mode)'),
  workstreamId: z.string().optional().describe('Workstream ID (for by_workstream mode)'),
  status: z.enum(['active', 'paused', 'archived']).optional().describe('Filter by status'),
  limit: z.number().optional().default(20).describe('Maximum results (for list mode)'),
  offset: z.number().optional().default(0).describe('Offset for pagination'),
});

export type VentureQueryParams = z.infer<typeof ventureQueryParams>;

export const ventureQuerySchema = {
  description: `Query ventures from the registry.

MODES:
- get: Retrieve a single venture by ID
- list: List all ventures with optional filters
- by_slug: Find a venture by its slug
- by_workstream: Find a venture by its root workstream ID

EXAMPLES:
1. Get by ID: { mode: "get", id: "<uuid>" }
2. List active: { mode: "list", status: "active" }
3. Find by slug: { mode: "by_slug", slug: "my-venture" }
4. Find by workstream: { mode: "by_workstream", workstreamId: "<workstream-id>" }

Returns: { venture } for single queries, { ventures, total } for list`,
  inputSchema: ventureQueryParams.shape,
};

/**
 * Query ventures from the database.
 * Delegates to the script functions which handle all Supabase operations.
 */
export async function ventureQuery(args: unknown) {
  try {
    const parsed = ventureQueryParams.safeParse(args);
    if (!parsed.success) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message }
          })
        }]
      };
    }

    const { mode, id, slug, workstreamId, status, limit, offset } = parsed.data;

    switch (mode) {
      case 'get': {
        if (!id) {
          return errorResponse('VALIDATION_ERROR', 'get mode requires id');
        }

        const venture = await getVenture(id);

        if (!venture) {
          return errorResponse('NOT_FOUND', `Venture not found: ${id}`);
        }

        mcpLogger.info({ ventureId: id }, 'Retrieved venture by ID');
        return successResponse({ venture });
      }

      case 'by_slug': {
        if (!slug) {
          return errorResponse('VALIDATION_ERROR', 'by_slug mode requires slug');
        }

        const venture = await getVentureBySlug(slug);

        if (!venture) {
          return errorResponse('NOT_FOUND', `Venture not found with slug: ${slug}`);
        }

        mcpLogger.info({ slug }, 'Retrieved venture by slug');
        return successResponse({ venture });
      }

      case 'by_workstream': {
        if (!workstreamId) {
          return errorResponse('VALIDATION_ERROR', 'by_workstream mode requires workstreamId');
        }

        // For by_workstream, we use listVentures with a filter
        // Note: The script doesn't have a direct by_workstream function yet
        // We'll use list and filter, but this could be optimized
        const ventures = await listVentures({ limit: 1 });
        const venture = ventures.find(v => v.root_workstream_id === workstreamId);

        if (!venture) {
          return errorResponse('NOT_FOUND', `Venture not found for workstream: ${workstreamId}`);
        }

        mcpLogger.info({ workstreamId }, 'Retrieved venture by workstream');
        return successResponse({ venture });
      }

      case 'list':
      default: {
        const ventures = await listVentures({
          status,
          limit: limit || 20,
          offset: offset || 0,
        });

        mcpLogger.info({ count: ventures.length }, 'Listed ventures');
        return successResponse({
          ventures,
          total: ventures.length,
        });
      }
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    mcpLogger.error({ error: message }, 'venture_query failed');
    return errorResponse('EXECUTION_ERROR', message);
  }
}

function successResponse(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ data, meta: { ok: true } })
    }]
  };
}

function errorResponse(code: string, message: string) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ data: null, meta: { ok: false, code, message } })
    }]
  };
}
