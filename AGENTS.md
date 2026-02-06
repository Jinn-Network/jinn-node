# JINN Node Setup (Agent Runbook)

This doc is written for an **agent** running setup on behalf of a human. It focuses on what you should do, where to pause for human input, and how to avoid common traps.

You are being put to work in the **Amplify 360 2^2 Growth Agency** venture:
```
https://explorer.jinn.network/ventures/0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac
```

## Requirements

- **Node.js** 20+
- **Python** 3.10-3.11
- **Poetry** (for `pyproject.toml` dependencies)
- **Tendermint** (for olas-operate-middleware consensus)
  - macOS: `brew install tendermint`
  - Linux: See https://docs.tendermint.com/v0.34/introduction/install.html
- **RPC URL** for the target chain
- **OPERATE_PASSWORD** (min 8 characters)

## Human Inputs You Must Collect

- `RPC_URL` for the target chain.
- `OPERATE_PASSWORD` (min 8 chars, used for wallet encryption).
- Funding confirmations when setup prints addresses.
- LLM auth (required for worker execution). One of: Gemini CLI login (`npx @google/gemini-cli auth login`), `GEMINI_OAUTH_CREDENTIALS` JSON (array), or `GEMINI_API_KEY`.
- Optional but highly recommended: `GITHUB_TOKEN` (repo access/push), plus `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`.

## Agent Setup Flow

### 1) Prepare `.env` first (required)

```bash
cp .env.example .env
```

Ensure `.env` contains:
```
OPERATE_PASSWORD=your_secure_password_min_8_chars
RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

Ask the human for these optional values (they can skip any, but GitHub creds are strongly recommended):
```
GEMINI_API_KEY=...
GITHUB_TOKEN=...
GIT_AUTHOR_NAME=...
GIT_AUTHOR_EMAIL=...
```
Tell the human that `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` become the commit identity used by the agent.

If Gemini CLI auth is used, no env var is needed—just ensure the operator is logged in.
Setup will auto-detect `~/.gemini/oauth_creds.json` and `~/.jinn/auth/profiles.json` if present.
If setup reports missing auth, ask the human to log in or provide env creds, then re-run `yarn setup`.

### 2) Install dependencies

```bash
yarn install
```

Setup will auto-install Python dependencies if missing. If it fails, run:
```bash
poetry install
```

### 3) Run setup (foreground)

Setup is non-interactive by default. It will **exit immediately** if required env vars are missing.
Run in the foreground so you can capture funding prompts.

```bash
yarn setup
```

When you see a funding prompt:
1. Tell the human the exact address + amount.
2. Wait for confirmation of funding.
3. Re-run `yarn setup` to continue.

If you need a blocking wait (human present), set `ATTENDED=true` and run `yarn setup` to wait for funding detection.

### 4) Capture outputs

Setup writes results to `/tmp/jinn-service-setup-*.json`. Extract and report:
- **Service Config ID**
- **Service Safe Address**

## Run the Worker

From `jinn-node/`:
```bash
yarn worker
```

## CLI Options

```
--chain=NETWORK     base, gnosis, mode, optimism (default: base)
--no-mech           Disable mech deployment
--no-staking        Disable staking
--unattended        Non-interactive mode (default)
```

## Mech Filtering (Multi-Operator)

By default the worker uses **single mech mode** — it reads `JINN_SERVICE_MECH_ADDRESS` (or falls back to the operate profile) and only processes requests for that one mech.

For multi-operator deployments where multiple services are staked in the same staking contract, use **staking-based filtering**:

```
WORKER_MECH_FILTER_MODE=staking
WORKER_STAKING_CONTRACT=0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139
```

This queries Ponder for all mechs whose services are staked in the given contract and filters requests accordingly.

**Gotcha:** Setting `JINN_SERVICE_MECH_ADDRESS` alone does NOT enable staking-based filtering. Without `WORKER_MECH_FILTER_MODE=staking` and `WORKER_STAKING_CONTRACT`, the worker falls back to single mech mode using `JINN_SERVICE_MECH_ADDRESS` directly. If you deploy a new worker to Railway and only set `JINN_SERVICE_MECH_ADDRESS`, it will only process requests for that one mech — not all mechs staked in the same pool. You must explicitly set both `WORKER_MECH_FILTER_MODE` and `WORKER_STAKING_CONTRACT` for multi-operator filtering.

## Common Issues (Agent-Resolvable)

- `poetry not found`: install Poetry or ask the human to install it.
- `OPERATE_PASSWORD not set`: prompt for it and write to `.env`.
- `RPC_URL not set`: prompt for it and write to `.env`.
- Setup appears stuck: it is waiting for funding. Re-run `yarn setup` to re-print funding requirements.
- Setup asks for Gemini auth even though you are logged in: verify `~/.gemini/oauth_creds.json`
  exists and that `HOME` points at the correct user.
