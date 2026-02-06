import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { getTemplate, getTemplateBySlug, listTemplates } from '../../../scripts/templates/crud.js';

/**
 * Input schema for querying templates.
 */
export const templateQueryParams = z.object({
  mode: z.enum(['get', 'list', 'by_slug', 'by_venture']).default('list').describe('Query mode'),
  id: z.string().uuid().optional().describe('Template ID (for get mode)'),
  slug: z.string().optional().describe('Template slug (for by_slug mode)'),
  ventureId: z.string().uuid().optional().describe('Venture ID (for by_venture mode)'),
  status: z.enum(['draft', 'published', 'archived']).optional().describe('Filter by status'),
  search: z.string().optional().describe('Search name/description'),
  tags: z.array(z.string()).optional().describe('Filter by tags (overlaps)'),
  limit: z.number().optional().default(20).describe('Maximum results (for list mode)'),
  offset: z.number().optional().default(0).describe('Offset for pagination'),
});

export type TemplateQueryParams = z.infer<typeof templateQueryParams>;

export const templateQuerySchema = {
  description: `Query templates from the Jinn registry.

MODES:
- get: Retrieve a single template by ID
- list: List templates with optional filters
- by_slug: Find a template by its slug
- by_venture: List templates for a specific venture

EXAMPLES:
1. Get by ID: { mode: "get", id: "<uuid>" }
2. List published: { mode: "list", status: "published" }
3. Find by slug: { mode: "by_slug", slug: "seo-audit" }
4. By venture: { mode: "by_venture", ventureId: "<uuid>" }
5. Search with tags: { mode: "list", search: "growth", tags: ["seo"] }

Returns: { template } for single queries, { templates, total } for list`,
  inputSchema: templateQueryParams.shape,
};

/**
 * Query templates from the database.
 */
export async function templateQuery(args: unknown) {
  try {
    const parsed = templateQueryParams.safeParse(args);
    if (!parsed.success) {
      return errorResponse('VALIDATION_ERROR', parsed.error.message);
    }

    const { mode, id, slug, ventureId, status, search, tags, limit, offset } = parsed.data;

    switch (mode) {
      case 'get': {
        if (!id) {
          return errorResponse('VALIDATION_ERROR', 'get mode requires id');
        }
        const template = await getTemplate(id);
        if (!template) {
          return errorResponse('NOT_FOUND', `Template not found: ${id}`);
        }
        mcpLogger.info({ templateId: id }, 'Retrieved template by ID');
        return successResponse({ template });
      }

      case 'by_slug': {
        if (!slug) {
          return errorResponse('VALIDATION_ERROR', 'by_slug mode requires slug');
        }
        const template = await getTemplateBySlug(slug);
        if (!template) {
          return errorResponse('NOT_FOUND', `Template not found with slug: ${slug}`);
        }
        mcpLogger.info({ slug }, 'Retrieved template by slug');
        return successResponse({ template });
      }

      case 'by_venture': {
        if (!ventureId) {
          return errorResponse('VALIDATION_ERROR', 'by_venture mode requires ventureId');
        }
        const templates = await listTemplates({
          ventureId,
          status,
          limit: limit || 20,
          offset: offset || 0,
        });
        mcpLogger.info({ ventureId, count: templates.length }, 'Listed templates by venture');
        return successResponse({ templates, total: templates.length });
      }

      case 'list':
      default: {
        const templates = await listTemplates({
          status,
          search,
          tags,
          limit: limit || 20,
          offset: offset || 0,
        });
        mcpLogger.info({ count: templates.length }, 'Listed templates');
        return successResponse({ templates, total: templates.length });
      }
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    mcpLogger.error({ error: message }, 'template_query failed');
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
