import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { createVenture, type CreateVentureArgs } from '../../../data/ventures.js';

/**
 * Input schema for minting a venture.
 */
export const ventureMintParams = z.object({
  name: z.string().min(1).describe('Venture name'),
  slug: z.string().optional().describe('URL-friendly slug (auto-generated if not provided)'),
  description: z.string().optional().describe('Venture description'),
  ownerAddress: z.string().min(1).describe('Ethereum address of the venture owner'),
  blueprint: z.string().describe('Blueprint JSON string with invariants array'),
  rootWorkstreamId: z.string().optional().describe('Workstream ID for the venture'),
  rootJobInstanceId: z.string().optional().describe('Optional root job instance ID'),
  status: z.enum(['active', 'paused', 'archived']).optional().default('active').describe('Venture status'),
});

export type VentureMintParams = z.infer<typeof ventureMintParams>;

export const ventureMintSchema = {
  description: `Create a new venture with a blueprint defining its invariants.

A venture is a persistent project entity that owns workstreams and services. Each venture has:
- A blueprint containing invariants (success criteria)
- An owner address (Ethereum address)
- Optional workstream and job instance associations

PREREQUISITES:
- Have a valid blueprint with invariants array
- Know the owner's Ethereum address

Parameters:
- name: Venture name (required)
- ownerAddress: Ethereum address of the owner (required)
- blueprint: JSON string with invariants array (required)
- slug: URL-friendly identifier (auto-generated from name if not provided)
- description: Venture description
- rootWorkstreamId: Associated workstream ID
- rootJobInstanceId: Associated root job instance
- status: 'active', 'paused', or 'archived'

Returns: { venture: { id, name, slug, ... } }`,
  inputSchema: ventureMintParams.shape,
};

/**
 * Mint (create) a new venture.
 * Delegates to the script function which handles all Supabase operations.
 */
export async function ventureMint(args: unknown) {
  try {
    const parsed = ventureMintParams.safeParse(args);
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

    const {
      name,
      slug,
      description,
      ownerAddress,
      blueprint,
      rootWorkstreamId,
      rootJobInstanceId,
      status,
    } = parsed.data;

    // Use the script function which handles all Supabase logic
    const scriptArgs: CreateVentureArgs = {
      name,
      slug,
      description,
      ownerAddress,
      blueprint,  // Script handles JSON parsing
      rootWorkstreamId,
      rootJobInstanceId,
      status,
    };

    const venture = await createVenture(scriptArgs);

    mcpLogger.info({ ventureId: venture.id, name }, 'Created new venture');

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
    mcpLogger.error({ error: message }, 'venture_mint failed');
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
