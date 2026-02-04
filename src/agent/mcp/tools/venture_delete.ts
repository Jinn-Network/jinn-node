import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { archiveVenture, deleteVenture } from '../../../../../scripts/ventures/update.js';

/**
 * Input schema for deleting a venture.
 */
export const ventureDeleteParams = z.object({
  id: z.string().uuid().describe('Venture ID to delete'),
  mode: z.enum(['soft', 'hard']).default('soft').describe('Delete mode: soft (archive) or hard (permanent)'),
  confirm: z.boolean().optional().describe('Required for hard delete'),
});

export type VentureDeleteParams = z.infer<typeof ventureDeleteParams>;

export const ventureDeleteSchema = {
  description: `Delete or archive a venture.

MODES:
- soft (default): Sets status to 'archived' - venture can be restored later
- hard: Permanently deletes the venture - CANNOT BE UNDONE

PREREQUISITES:
- Know the venture ID
- For hard delete: set confirm: true

Parameters:
- id: Venture UUID (required)
- mode: 'soft' (archive) or 'hard' (permanent) - default: soft
- confirm: Must be true for hard delete

EXAMPLE:
1. Archive: { id: "<uuid>", mode: "soft" }
2. Delete: { id: "<uuid>", mode: "hard", confirm: true }

Returns: { venture } for soft delete, { deleted: true } for hard delete`,
  inputSchema: ventureDeleteParams.shape,
};

/**
 * Delete or archive a venture.
 * Delegates to the script functions which handle all Supabase operations.
 */
export async function ventureDelete(args: unknown) {
  try {
    const parsed = ventureDeleteParams.safeParse(args);
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

    const { id, mode, confirm } = parsed.data;

    if (mode === 'hard') {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              data: null,
              meta: { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'Hard delete requires confirm: true' }
            })
          }]
        };
      }

      // Use the script function for permanent delete
      await deleteVenture(id);

      mcpLogger.info({ ventureId: id }, 'Hard deleted venture');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: { deleted: true, id },
            meta: { ok: true }
          })
        }]
      };
    }

    // Soft delete (archive)
    const venture = await archiveVenture(id);

    mcpLogger.info({ ventureId: id }, 'Archived venture');

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: { venture },
          meta: { ok: true }
        })
      }]
    };

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    mcpLogger.error({ error: message }, 'venture_delete failed');
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          data: null,
          meta: { ok: false, code: 'EXECUTION_ERROR', message }
        })
      }]
    };
  }
}
