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
- LLM auth (required for worker execution):
  - Either Gemini CLI login (`npx @google/gemini-cli auth login`)
  - Or `GEMINI_OAUTH_CREDENTIALS` JSON (array)
  - Or `GEMINI_API_KEY` (API-key auth; supported)
- Optional (only if the human provides them):
  - `GEMINI_API_KEY` or `OPENAI_API_KEY`
  - `GITHUB_TOKEN`
  - `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`

## Agent Setup Flow

### 1) Install dependencies

```bash
yarn install
```

Setup will auto-install Python dependencies if missing. If it fails, run:
```bash
poetry install
```

### 2) Prepare `.env`

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
OPENAI_API_KEY=...
GITHUB_TOKEN=...
GIT_AUTHOR_NAME=...
GIT_AUTHOR_EMAIL=...
```

If Gemini CLI auth is used, no env var is needed—just ensure the operator is logged in.

### 3) Run setup in background (important)

**Do not run setup in the foreground.** It waits for funding and can run indefinitely.
Also **do not tail indefinitely**. Only check logs when needed.

```bash
yarn setup > setup.log 2>&1 &
echo $! > setup.pid
```

### 4) Check for funding prompts (poll, don’t tail)

Use on-demand checks:
```bash
tail -n 200 setup.log
```

Or target funding prompts:
```bash
rg -n "Please transfer|Funding Required|Master EOA|Master Safe" setup.log
```

When you see a funding prompt:
1. Tell the human the exact address + amount.
2. Wait for confirmation of funding.
3. Re-check `setup.log` to confirm it continued.

### 5) Capture outputs

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
--testnet           Use .env.test for testnet/Tenderly VNet deployment
--chain=NETWORK     base, gnosis, mode, optimism (default: base)
--no-mech           Disable mech deployment
--no-staking        Disable staking
--unattended        Non-interactive mode (requires pre-funded wallets)
--isolated          Fresh .operate in temp directory
```

## Common Issues (Agent-Resolvable)

- `poetry not found`: install Poetry or ask the human to install it.
- `OPERATE_PASSWORD not set`: prompt for it and write to `.env`.
- `RPC_URL not set`: prompt for it and write to `.env`.
- Setup appears stuck: it is waiting for funding. Check `setup.log` for addresses.
