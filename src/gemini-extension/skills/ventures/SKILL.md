---
name: ventures
description: Use when minting a new venture, viewing information about existing ventures, updating venture details or status, or shutting down (archiving/deleting) a venture. Use when working with venture blueprints, invariants, or owner addresses in the Jinn platform registry.
allowed-tools: venture_mint venture_query venture_update venture_delete
---

# Ventures Registry

You have access to ventures management tools for the Jinn platform. Ventures are project entities that own workstreams and services.

## Architecture

```
Agent -> MCP Tools / Scripts -> Supabase Database
```

## Available Operations

### CREATE - Mint a New Venture

Create a new venture with a blueprint defining success criteria.

**Required parameters:**
- `name`: Venture display name
- `ownerAddress`: Ethereum address (0x...)
- `blueprint`: JSON string with invariants array

**Optional parameters:**
- `slug`: URL-friendly identifier (auto-generated from name)
- `description`: Venture description
- `rootWorkstreamId`: Associated workstream UUID
- `rootJobInstanceId`: Associated root job instance UUID
- `status`: 'active', 'paused', or 'archived' (default: active)

**Token parameters (all optional):**
- `tokenAddress`: Token contract address on Base
- `tokenSymbol`: Token symbol (e.g., GROWTH, AMP2)
- `tokenName`: Token display name
- `stakingContractAddress`: Staking contract address
- `tokenLaunchPlatform`: Launch platform (e.g., "doppler")
- `tokenMetadata`: Platform-specific metadata JSON string (poolId, curves, safeAddress, etc.)
- `governanceAddress`: Governance contract address (e.g., Doppler governance)
- `poolAddress`: Liquidity pool address (e.g., GROWTH/OLAS Uniswap pool)

**Example (basic):**
```json
{
  "name": "My Venture",
  "ownerAddress": "0x1234567890abcdef1234567890abcdef12345678",
  "blueprint": "{\"invariants\":[{\"id\":\"INV-001\",\"description\":\"Test invariant\"}]}",
  "status": "active"
}
```

**Example (with token):**
```json
{
  "name": "Growth Agency",
  "ownerAddress": "0x...",
  "blueprint": "{\"invariants\":[{\"id\":\"INV-001\",\"description\":\"Generate growth services\"}]}",
  "tokenAddress": "0x...",
  "tokenSymbol": "GROWTH",
  "tokenName": "Growth Agency Token",
  "tokenLaunchPlatform": "doppler",
  "poolAddress": "0x..."
}
```

### READ - View Venture Information

**Get by ID:**
```json
{ "id": "550e8400-e29b-41d4-a716-446655440000" }
```

**Get by slug:**
```json
{ "slug": "my-venture" }
```

**List with filters:**
```json
{ "status": "active", "limit": 20, "offset": 0 }
```

### UPDATE - Modify Venture Details

Update any combination of venture fields. Only provided fields are modified. Supports all token fields (tokenAddress, tokenSymbol, tokenName, stakingContractAddress, tokenLaunchPlatform, tokenMetadata, governanceAddress, poolAddress).

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Updated Name",
  "status": "paused"
}
```

### DELETE - Shut Down a Venture

**Soft delete (archive)** - can be restored:
```json
{ "id": "<uuid>", "mode": "soft" }
```

**Hard delete (permanent)** - cannot be undone:
```json
{ "id": "<uuid>", "mode": "hard", "confirm": true }
```

## Blueprint Format

Blueprints define success criteria (invariants) for a venture:

```json
{
  "invariants": [
    {
      "id": "inv-availability",
      "name": "Service Availability",
      "description": "All production services maintain 99.9% uptime",
      "type": "availability",
      "threshold": 0.999
    }
  ]
}
```

## CLI Scripts

```bash
# Mint a venture
yarn tsx scripts/ventures/mint.ts \
  --name "My Venture" \
  --ownerAddress "0x..." \
  --blueprint '{"invariants":[]}'

# Update a venture
yarn tsx scripts/ventures/update.ts \
  --id "<uuid>" \
  --status "paused"
```

## Best Practices

1. **Use soft delete by default** - Archive ventures rather than permanently deleting
2. **Validate blueprints** - Ensure blueprint JSON has an `invariants` array
3. **Use slugs for lookups** - Slugs are human-readable and unique
4. **Link to workstreams** - Associate ventures with workstreams for automation
