# Jinn Node

Worker + agent runtime for Jinn. Standalone and open-source ready.

If you are an agent, read `AGENTS.md`.
If you are a human, read `HUMANS.md`.

## What This Is

- Worker orchestration, agent execution, shared utilities, and MCP tools.
- Designed to run standalone or as part of the Jinn monorepo.

## Requirements

- Node.js 20+
- Python 3.10-3.11
- Poetry
- RPC URL for target chain
- OPERATE_PASSWORD (min 8 chars)

## Install

```bash
yarn install
```

## Setup (interactive)

```bash
yarn setup
```

Setup auto-installs Python deps if missing.
If it fails, run:
```bash
poetry install
```

## Run Worker

```bash
yarn run
```

## Environment

Required in `.env`:
```
RPC_URL=...
OPERATE_PASSWORD=...
```

## Scripts

- `yarn setup` - interactive service setup wizard
- `yarn run` - run the worker
- `yarn build` - compile to `dist/`
- `yarn typecheck` - typecheck only

## Logs

- Pretty logs by default.
- Force JSON: `LOG_FORMAT=json yarn run`

## Outputs

Setup results are written to:
- `/tmp/jinn-service-setup-*.json`
