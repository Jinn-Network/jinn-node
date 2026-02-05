import { z } from 'zod';
import { mcpLogger } from '../../../logging/index.js';
import { updateVenture, type UpdateVentureArgs } from '../../../data/ventures.js';

/**
 * Input schema for updating a venture.
 */
export const ventureUpdateParams = z.object({
  id: z.string().uuid().describe('Venture ID to update'),
  name: z.string().min(1).optional().describe('New venture name'),
  slug: z.string().optional().describe('New URL-friendly slug'),
  description: z.string().optional().describe('New venture description'),
  blueprint: z.string().optional().describe('New blueprint JSON string with invariants array'),
  rootWorkstreamId: z.string().optional().describe('New workstream ID for the venture'),
  rootJobInstanceId: z.string().optional().describe('New root job instance ID'),
  status: z.enum(['active', 'paused', 'archived']).optional().describe('Venture status'),
  tokenAddress: z.string().optional().describe('Token contract address on Base'),
  tokenSymbol: z.string().optional().describe('Token symbol (e.g., GROWTH)'),
  tokenName: z.string().optional().describe('Token display name'),
  stakingContractAddress: z.string().optional().describe('Staking contract address'),
  tokenLaunchPlatform: z.string().optional().describe('Token launch platform (e.g., doppler)'),
  tokenMetadata: z.string().optional().describe('Platform-specific metadata JSON string'),
  governanceAddress: z.string().optional().describe('Governance contract address'),
  poolAddress: z.string().optional().describe('Liquidity pool address'),
});

export type VentureUpdateParams = z.infer<typeof ventureUpdateParams>;

export const ventureUpdateSchema = {
  description: `Update an existing venture's properties.

Updates any combination of venture fields. The blueprint field, if provided, must be a valid JSON string containing an invariants array.

PREREQUISITES:
- Know the venture ID to update
- Have valid values for fields being updated

Parameters:
- id: Venture UUID (required)
- name: New venture name
- slug: New URL-friendly identifier
- description: New venture description
- blueprint: New JSON string with invariants array
- rootWorkstreamId: Associated workstream ID
- rootJobInstanceId: Associated root job instance ID
- status: 'active', 'paused', or 'archived'
- tokenAddress: Token contract address on Base
- tokenSymbol: Token symbol (e.g., GROWTH)
- tokenName: Token display name
- stakingContractAddress: Staking contract address
- tokenLaunchPlatform: Launch platform (e.g., doppler)
- tokenMetadata: Platform-specific metadata JSON string
- governanceAddress: Governance contract address
- poolAddress: Liquidity pool address

Returns: { venture: { id, name, slug, ... } }`,
  inputSchema: ventureUpdateParams.shape,
};

/**
 * Update an existing venture.
 * Delegates to the script function which handles all Supabase operations.
 */
export async function ventureUpdate(args: unknown) {
  try {
    const parsed = ventureUpdateParams.safeParse(args);
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
      id,
      name,
      slug,
      description,
      blueprint,
      rootWorkstreamId,
      rootJobInstanceId,
      status,
      tokenAddress,
      tokenSymbol,
      tokenName,
      stakingContractAddress,
      tokenLaunchPlatform,
      tokenMetadata,
      governanceAddress,
      poolAddress,
    } = parsed.data;

    // Build update args - only include defined fields
    const scriptArgs: UpdateVentureArgs = { id };
    if (name !== undefined) scriptArgs.name = name;
    if (slug !== undefined) scriptArgs.slug = slug;
    if (description !== undefined) scriptArgs.description = description;
    if (blueprint !== undefined) scriptArgs.blueprint = blueprint;
    if (rootWorkstreamId !== undefined) scriptArgs.rootWorkstreamId = rootWorkstreamId;
    if (rootJobInstanceId !== undefined) scriptArgs.rootJobInstanceId = rootJobInstanceId;
    if (status !== undefined) scriptArgs.status = status;
    if (tokenAddress !== undefined) scriptArgs.tokenAddress = tokenAddress;
    if (tokenSymbol !== undefined) scriptArgs.tokenSymbol = tokenSymbol;
    if (tokenName !== undefined) scriptArgs.tokenName = tokenName;
    if (stakingContractAddress !== undefined) scriptArgs.stakingContractAddress = stakingContractAddress;
    if (tokenLaunchPlatform !== undefined) scriptArgs.tokenLaunchPlatform = tokenLaunchPlatform;
    if (tokenMetadata !== undefined) scriptArgs.tokenMetadata = JSON.parse(tokenMetadata);
    if (governanceAddress !== undefined) scriptArgs.governanceAddress = governanceAddress;
    if (poolAddress !== undefined) scriptArgs.poolAddress = poolAddress;

    // Use the script function which handles all Supabase logic
    const venture = await updateVenture(scriptArgs);

    mcpLogger.info({ ventureId: venture.id, name: venture.name }, 'Updated venture');

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
    mcpLogger.error({ error: message }, 'venture_update failed');
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
