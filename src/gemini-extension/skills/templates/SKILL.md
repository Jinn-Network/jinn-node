---
name: templates
description: Use when creating, registering, or deploying new job templates for the Jinn platform. Templates define reusable workstream blueprints with input schemas, output specs, invariants, and tool requirements. They are stored in Supabase and managed via CRUD tools.
allowed-tools: template_create, template_query, template_update, template_delete
---

# Job Templates

You have access to template management for the Jinn platform. Templates are reusable, static blueprint definitions stored in Supabase that define:
- **Blueprint**: Invariants (success criteria and constraints)
- **Input schema**: What parameters the template accepts
- **Output spec**: What the template returns on completion
- **Enabled tools**: Tool policy array
- **Pricing**: priceWei / priceUsd
- **Status**: draft → published → archived

## CRUD Tools

### template_create
Create a new template definition. Templates start in `draft` status by default.

```json
{
  "name": "SEO Audit",
  "description": "Comprehensive SEO audit for any domain",
  "blueprint": "{\"invariants\":[{\"id\":\"GOAL-001\",\"form\":\"constraint\",\"description\":\"Audit must cite ≥3 data sources\"}]}",
  "tags": ["seo", "growth", "audit"],
  "priceWei": "50000000000000000",
  "priceUsd": "$0.05"
}
```

### template_query
Query templates with multiple modes:

```json
// Get by ID
{ "mode": "get", "id": "<uuid>" }

// List published templates
{ "mode": "list", "status": "published" }

// Find by slug
{ "mode": "by_slug", "slug": "seo-audit" }

// List templates for a venture
{ "mode": "by_venture", "ventureId": "<uuid>" }

// Search with tags
{ "mode": "list", "search": "growth", "tags": ["seo"] }
```

### template_update
Update any template field. Requires the template `id`.

```json
{
  "id": "<uuid>",
  "status": "published",
  "priceWei": "60000000000000000"
}
```

### template_delete
Archive (soft) or permanently delete (hard) a template.

```json
// Soft delete (archive)
{ "id": "<uuid>", "mode": "soft" }

// Hard delete (permanent, requires confirmation)
{ "id": "<uuid>", "mode": "hard", "confirm": true }
```

## Template Lifecycle

1. **Draft**: Created via `template_create`. Not visible in marketplace.
2. **Published**: Set via `template_update` after testing. Visible to buyers.
3. **Archived**: Soft-deleted via `template_delete`. Can be restored.

## Template Fields

| Field | Type | Description |
|-------|------|-------------|
| name | string | Template name (required) |
| slug | string | URL-friendly identifier (auto-generated) |
| description | string | What the template does |
| version | string | Version string (default: 0.1.0) |
| blueprint | JSONB | Blueprint with invariants array (required) |
| input_schema | JSONB | JSON Schema for inputs |
| output_spec | JSONB | Output contract for result extraction |
| enabled_tools | JSONB | Tool policy array |
| tags | text[] | Discovery tags |
| price_wei | string | Price in wei (bigint as string) |
| price_usd | string | Human-readable price |
| safety_tier | string | public, private, or restricted |
| default_cyclic | boolean | Whether template runs cyclically |
| venture_id | UUID | Associated venture (optional FK) |
| status | string | draft, published, or archived |

## Writing Template Invariants

Template invariants define WHAT the template must achieve. The network works out HOW.

**Think like a product owner, not a developer:**

| Approach | Bad (implementation) | Good (outcome) |
|----------|---------------------|----------------|
| Data quality | "Use official protocol APIs" | "Accurate snapshot of current APY for all positions" |
| Coverage | "Support Aave V3, Compound V3, Morpho" | "Cover top 5 EVM chains by DeFi TVL" |
| Freshness | "Data no more than 1 hour old" | "4.5+ average feedback on 8004 marketplace" |

**Key principles:**
1. **Outcomes over implementation** — describe what success looks like from the outside
2. **Business viability** — revenue and feedback are real measures of success
3. **System-native language** — reference Jinn templates, 8004 marketplace, feedback scores
4. **Durable scope** — "top 5 by TVL" beats a hardcoded list that goes stale
5. **Sensible constraints** — structural choices like "exactly 1 template" are valid invariants

See [docs/guides/writing-invariants.md](../../docs/guides/writing-invariants.md) for invariant type reference (BOOLEAN, FLOOR, CEILING, RANGE).

## Workflow: Creating a Template from a Tested Venture

1. Design blueprint with invariants, inputSchema, outputSpec
2. Test by dispatching as a child job via `dispatch_new_job`
3. On re-invocation, validate test results passed quality gate
4. Register with `template_create` (status='draft')
5. After review, publish with `template_update` (status='published')

## CLI Usage

```bash
# Create a template
yarn tsx scripts/templates/crud.ts create \
  --name "My Template" \
  --blueprint '{"invariants":[...]}'

# List templates
yarn tsx scripts/templates/crud.ts list --status published

# Update a template
yarn tsx scripts/templates/crud.ts update --id <uuid> --status published

# Archive
yarn tsx scripts/templates/crud.ts archive --id <uuid>

# Permanently delete
yarn tsx scripts/templates/crud.ts delete --id <uuid> --confirm
```

## Relationship to Other Tables

- **templates** (this): Static, reusable template definitions in Supabase
- **job_templates** (Ponder): On-chain execution metrics (run_count, success_count, etc.)
- **job_templates** (x402-gateway): Legacy pricing table, migrated in follow-up

Templates in this table are the source of truth for template metadata. Ponder's job_template tracks runtime metrics separately.
