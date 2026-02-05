# JINN Node Setup (Agent Runbook)

This doc is written for an **agent** running setup on behalf of a human. It focuses on what you should do, where to pause for human input, and how to avoid common traps.

## Requirements

- **Node.js** 20+
- **Python** 3.10-3.11
- **Poetry** (for `pyproject.toml` dependencies)
- **RPC URL** for the target chain
- **OPERATE_PASSWORD** (min 8 characters)

## Human Inputs You Must Collect

- `RPC_URL` for the target chain.
- `OPERATE_PASSWORD` (min 8 chars, used for wallet encryption).
- Funding confirmations when setup prints addresses.
- LLM auth (required for worker execution). One of: Gemini CLI login (`npx @google/gemini-cli auth login`), `GEMINI_OAUTH_CREDENTIALS` JSON (array), or `GEMINI_API_KEY`.
- Optional if the human provides them: `GITHUB_TOKEN`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`.

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

Optional (only if provided by the human):
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
yarn run
```

## CLI Options

```
--chain=NETWORK     base, gnosis, mode, optimism (default: base)
--no-mech           Disable mech deployment
--no-staking        Disable staking
--unattended        Non-interactive mode (default)
```

## Common Issues (Agent-Resolvable)

- `poetry not found`: install Poetry or ask the human to install it.
- `OPERATE_PASSWORD not set`: prompt for it and write to `.env`.
- `RPC_URL not set`: prompt for it and write to `.env`.
- Setup appears stuck: it is waiting for funding. Re-run `yarn setup` to re-print funding requirements.
- Setup asks for Gemini auth even though you are logged in: verify `~/.gemini/oauth_creds.json`
  exists and that `HOME` points at the correct user.
