# JINN Node Setup (Agent Runbook)

This doc is written for a **coding agent** (Claude Code, Cursor, Windsurf, etc.) setting up a JINN node on behalf of a human operator. The human may not be a developer — guide them clearly, handle what you can autonomously, and only ask them for things that require their input.

You are onboarding the operator into the **Amplify 360 2^2 Growth Agency** venture:
```
https://explorer.jinn.network/ventures/0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac
```

---

## Security Disclosure — Tell the Human BEFORE Starting

Before collecting any credentials or running setup, inform the human:

> **Important: LLM provider visibility.** Because you're using a coding agent to set up your node, your LLM provider (Google for Gemini CLI, Anthropic for Claude Code, etc.) will process your wallet password and seed phrase as part of this session. This is inherent to how coding agents work — everything in your terminal session passes through the LLM's API.
>
> **Mitigants:**
> - Major LLM providers (Google, Anthropic, OpenAI) **do not train on API inputs**. Your data is processed for the session and not retained for model training.
> - The agent needs your password to write it to `.env` — there is no way around this. And the seed phrase is printed to the terminal by the setup script, which the agent captures.
> - This wallet is purpose-built for node operations (gas fees + staking). **Do not use it as a personal wallet or store significant funds in it.** Keep only the operational amounts needed.
> - You can export your keys at any time using `yarn wallet:export-keys`. See [Wallet Management](#wallet-management).
>
> **If you're not comfortable with this**, you can run `yarn setup` manually without a coding agent — the setup script works standalone. You'll need to fill in `.env` yourself (see the `.env.example` template) and watch the terminal output for your seed phrase when it appears.

Wait for the human to acknowledge before proceeding.

---

## Guiding Principles

1. **You are the UX layer.** The setup script is non-interactive. Your job is to check prerequisites, prepare the environment, run the script, capture critical output, and explain what's happening.
2. **Only ask the human for things they must provide.** Credentials, passwords, and funding confirmations require human input. Everything else you should handle.
3. **The mnemonic is sacred.** When a wallet is created, the seed phrase is printed ONCE to stdout. You MUST capture it and present it clearly. It cannot be recovered if lost.
4. **Rerunning is normal.** Setup exits when funding is needed. This is not a failure — it's the expected flow. The human funds the address, you rerun `yarn setup`, and it resumes.

---

## Phase 0: Prerequisites

Before running anything, check every prerequisite. Install what you can; ask the human to install what you can't.

### Checklist

Run these checks and handle failures:

| Tool | Check Command | Install (macOS) | Install (Ubuntu/Debian) |
|------|--------------|-----------------|------------------------|
| Node.js 20+ | `node --version` | `brew install node@22` | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo bash - && sudo apt-get install -y nodejs` |
| Yarn | `yarn --version` | `corepack enable` | `corepack enable` |
| Python 3.10-3.11 | `python3 --version` | `brew install python@3.11` | `sudo apt-get install python3.11 python3.11-venv python3.11-dev` |
| Poetry | `poetry --version` | `curl -sSL https://install.python-poetry.org \| python3 -` | Same |
| Tendermint | `tendermint version` | `brew install tendermint` | See below |
| Git | `git --version` | `brew install git` | `sudo apt-get install git` |

#### Tendermint on Linux

Tendermint is not in standard apt repos. Install the binary directly:

```bash
# Check architecture
ARCH=$(uname -m)
case $ARCH in
  x86_64) ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
esac

# Download and install Tendermint v0.34.x
curl -L "https://github.com/tendermint/tendermint/releases/download/v0.34.24/tendermint_0.34.24_linux_${ARCH}.tar.gz" | tar xz -C /usr/local/bin tendermint
tendermint version
```

If the human's system uses a different package manager (Fedora, Arch, etc.), adapt accordingly.

#### Python Version Matters

The `pyproject.toml` requires Python 3.10 or 3.11 specifically. If the human has 3.9 or 3.12+, Poetry will fail with a resolver error. Check this BEFORE running `yarn setup`:

```bash
python3 --version
# If wrong version, install 3.11 alongside (don't remove their existing Python)
```

On Ubuntu, if `python3` points to 3.12, use `python3.11` explicitly and configure Poetry:
```bash
poetry env use python3.11
```

---

## Phase 1: Environment Configuration

### What to tell the human

Only **3 things** require human input. Everything else in `.env` is pre-filled correctly.

#### 1. RPC URL (required)

Ask the human for a Base network RPC URL. If they don't have one, explain:

> "You need an RPC endpoint for Base (the L2 blockchain). You can get a free one from Alchemy, Infura, or QuickNode. The simplest option is Alchemy — create a free account at alchemy.com, create a Base Mainnet app, and copy the HTTPS URL."

If they want to get started fast, Base has a public RPC they can use temporarily:
```
https://mainnet.base.org
```
Note: the public RPC has rate limits and is not recommended for production.

#### 2. OPERATE_PASSWORD (required)

This password encrypts the wallet that will be created for the node. Explain:

> "Choose a strong password (minimum 8 characters). This encrypts your node's wallet — you'll need it to access your private keys later. Store it somewhere safe alongside your seed phrase."

Generate a suggestion if they want one, or let them choose their own. Write it to `.env`.

#### 3. LLM Authentication (required)

The worker uses Gemini to execute jobs. The human needs ONE of these:

- **Option A: `GEMINI_API_KEY`** (simplest) — Get an API key from [Google AI Studio](https://aistudio.google.com/apikey). Set it in `.env`.
- **Option B: Gemini CLI login** — Run `npx @google/gemini-cli auth login` (requires a browser on the machine). No env var needed after login.
- **Option C: `GEMINI_OAUTH_CREDENTIALS`** — JSON array of OAuth creds (advanced, for credential rotation).

Recommend Option A for simplicity. If the human's machine has no browser (headless server), Option A is the only practical choice.

### Setting up .env

```bash
cd jinn-node
cp .env.example .env
```

Then write ONLY the values that need changing:

```bash
# These 3 values need human input — replace them:
RPC_URL=<the human's RPC URL>
OPERATE_PASSWORD=<the human's chosen password>
GEMINI_API_KEY=<the human's API key>  # if using Option A
```

**DO NOT modify these pre-filled values** — they are correct:
- `PONDER_GRAPHQL_URL` — Jinn's indexer endpoint
- `CONTROL_API_URL` — Jinn's control API endpoint
- `X402_GATEWAY_URL` — Payment gateway
- `STAKING_CONTRACT` — Jinn staking contract on Base
- `WORKSTREAM_FILTER` — Growth Agency venture workstream ID
- `CHAIN_ID=8453` — Base chain ID

**Optional values** (ask, but the human can skip):
- `GITHUB_TOKEN` — Strongly recommended if the node will work on code tasks. Personal access token from github.com/settings/tokens.
- `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` — Commit identity for code tasks.

---

## Phase 2: Install Dependencies

```bash
cd jinn-node
yarn install
```

This also installs Python dependencies via Poetry automatically. If `poetry install` fails separately, check the Python version (must be 3.10 or 3.11).

---

## Phase 3: Run Setup

### CRITICAL — Mnemonic Capture Protocol

When `yarn setup` creates a new wallet, it prints the seed phrase **exactly once** as a single line to stdout:

```
Please save the mnemonic phrase for the Master EOA: word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12
```

**You MUST:**
1. Run `yarn setup` and capture ALL stdout output.
2. Search the output for the line starting with `Please save the mnemonic phrase`.
3. Extract the 12 (or 24) words.
4. Present them to the human prominently — make it unmissable:

> **YOUR WALLET SEED PHRASE — SAVE THIS NOW**
>
> These 12 words are the master key to your node's wallet. Anyone with these words can access your funds. Write them down on paper and store them securely. They will NOT be shown again.
>
> ```
> word1 word2 word3 word4
> word5 word6 word7 word8
> word9 word10 word11 word12
> ```
>
> Your wallet address: 0x...
>
> Have you saved your seed phrase securely?

5. Wait for the human to confirm before proceeding.

**On subsequent runs**, the wallet already exists and the mnemonic is NOT printed. If the human missed it and needs their keys, use `yarn wallet:export-keys` (see [Wallet Management](#wallet-management)).

### Running Setup

```bash
cd jinn-node
yarn setup 2>&1
```

Setup runs through these steps automatically:
1. Preflight checks (Poetry, Tendermint, dependencies)
2. Configuration validation (env vars)
3. Wallet creation (Master EOA) — **capture mnemonic here**
4. Funding check — **setup will exit here if unfunded (this is normal)**
5. Safe creation
6. Second funding check — **may exit again for Safe + OLAS funding**
7. Service deployment
8. Mech deployment
9. Staking registration

### Expected "Failures" That Are Actually Normal

**"Funding required before safe creation. Please fund and rerun."** — This is the standard flow, not an error. Setup detected the wallet needs ETH to proceed. Extract the address and amount from the output (look for the `FUNDING REQUIRED` box) and tell the human:

> Your node needs a small amount of ETH on Base to create its Safe wallet.
>
> Send **[amount] ETH** to: `[address]`
>
> This is your node's Master EOA address on the Base network. You can send ETH from any exchange (Coinbase, Binance, etc.) or wallet that supports Base. After sending, wait for the transaction to confirm (usually ~2 seconds on Base), then I'll rerun the setup.

After the human confirms funding, rerun `yarn setup`. It will detect the existing wallet (no new mnemonic) and continue.

**"Funding required before deployment."** — Same pattern, but now it needs both ETH and OLAS tokens in the Safe. The output will show multiple funding requirements — relay them all to the human.

**`.operate directory not found` warnings** — Ignore these. They are first-run noise from the config resolver checking multiple possible locations. They do not indicate a problem.

### Funding Requirements (Typical)

The full setup on Base mainnet typically requires:
- **~0.005 ETH** on the Master EOA (for gas to create the Safe)
- **~0.01 ETH** in the Master Safe (for operational gas)
- **~100 OLAS** in the Master Safe (50 OLAS bond + 50 OLAS stake for the Jinn staking contract)

OLAS can be purchased on Uniswap (Base) or bridged from Ethereum mainnet.

---

## Phase 4: Run the Worker

After setup completes successfully:

```bash
cd jinn-node
yarn worker
```

The worker will:
1. Connect to the Ponder indexer
2. Poll for new job requests matching the workstream filter
3. Claim and execute jobs using Gemini
4. Deliver results on-chain

---

## Phase 5: Deploy to Railway (Optional)

If the operator wants to run their worker 24/7 without keeping a local machine on, [Railway](https://railway.com?referralCode=vEDcil) is the easiest cloud option. New accounts get **$5 free credit**, and using [this link](https://railway.com?referralCode=vEDcil) gives an **additional $5 credit**.

### Prerequisites

- Phases 1-3 completed locally (`.operate/` directory exists with encrypted keystore)
- A GitHub account with a fork of [jinn-node](https://github.com/Jinn-Network/jinn-node)

### Steps

1. **Create a Railway account** at [railway.com](https://railway.com?referralCode=vEDcil)
2. **Create a new project** → "Deploy from GitHub Repo" → select the jinn-node fork
3. Railway auto-detects `railway.toml` and the Dockerfile — no build config needed
4. **Add a persistent volume** in the service settings:
   - Mount path: `/home/jinn`
   - This stores the encrypted keystore (`.operate/`) and Gemini credentials (`.gemini/`)
   - **Loss of this volume means loss of signing keys** — enable Railway backups
5. **Set environment variables** in the Railway dashboard (Variables tab):

   Copy the values from your local `.env` file. The required variables are:

   | Variable | Description |
   |----------|-------------|
   | `RPC_URL` | Base chain RPC endpoint |
   | `CHAIN_ID` | `8453` |
   | `OPERATE_PASSWORD` | Decrypts `.operate/` keystore |
   | `GEMINI_API_KEY` | Gemini API key |
   | `GITHUB_TOKEN` | For code task repo cloning |
   | `GIT_AUTHOR_NAME` | Git commit identity |
   | `GIT_AUTHOR_EMAIL` | Git commit identity |

   Service endpoints (`PONDER_GRAPHQL_URL`, `CONTROL_API_URL`, `X402_GATEWAY_URL`) are pre-filled in `.env.example` and can be copied as-is.

6. **Import `.operate/` into the volume.** Use `railway shell` to access the running container, then copy your local `.operate/` directory contents into `/home/jinn/.operate/`. Alternatively, use `railway volume` commands or the Railway CLI.

7. **Deploy.** Railway builds and deploys automatically on push. The healthcheck at `/health` confirms the worker is running.

### CLI Deploy (Alternative)

If the operator prefers the Railway CLI over the dashboard:

```bash
cd jinn-node
railway login
railway link    # Link to your Railway project
railway up      # Deploy
railway logs -f # Watch logs
```

### Monitoring

- **Logs**: Railway dashboard → Deployments → Logs, or `railway logs -f`
- **Health**: The worker exposes `GET /health` — Railway monitors this automatically
- **Restarts**: `railway.toml` configures automatic restart on failure (up to 10 retries)

---

## Wallet Management

All wallet commands require `OPERATE_PASSWORD` and `RPC_URL` in `.env` (unless noted).

| Command | Purpose |
|---------|---------|
| `yarn wallet:info` | Show addresses, ETH/OLAS balances, staking status |
| `yarn wallet:backup` | Timestamped `.tar.gz` of `.operate` directory (no password needed) |
| `yarn wallet:export-keys` | Display BIP-39 mnemonic — **confirm with human first** |
| `yarn wallet:withdraw --to <addr>` | Transfer funds from Safe to external address |
| `yarn wallet:unstake` | Unstake service (72-hour cooldown applies) |
| `yarn wallet:recover --to <addr>` | Terminate service + withdraw all — **confirm with human first** |

**Destructive operations** (`recover`, `export-keys`): Always pause and get human confirmation before executing. Use `--dry-run` where available to preview first.

**Key flags:**
- `withdraw`: `--to <addr>` (required), `--asset ETH|OLAS|all` (default: all), `--dry-run`
- `recover`: `--to <addr>` (required), `--dry-run`, `--skip-terminate` (if already unstaked)
- `unstake`: `--service-id <id>` (optional, reads from config), `--dry-run`

**72-hour staking cooldown**: OLAS requires minimum 72 hours staked before unstake. Recovery will fail if cooldown has not elapsed.

---

## Troubleshooting

### Prerequisites

| Symptom | Cause | Fix |
|---------|-------|-----|
| `poetry: command not found` | Poetry not installed | `curl -sSL https://install.python-poetry.org \| python3 -` then restart shell |
| `tendermint: command not found` | Tendermint not installed | See [Tendermint on Linux](#tendermint-on-linux) above |
| `poetry install` fails with resolver error | Wrong Python version | `python3 --version` — must be 3.10 or 3.11. Use `poetry env use python3.11` |
| `Cannot import operate module` | Poetry deps not installed | `cd jinn-node && poetry install --sync` |
| Warnings about `@opentelemetry` peer deps | Harmless npm warnings | Ignore — these don't affect functionality |

### Setup Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `OPERATE_PASSWORD not set` | Missing from .env | Add it to `.env` |
| `RPC_URL not set` | Missing from .env | Add it to `.env` |
| `Missing required LLM authentication` | No Gemini creds found | Set `GEMINI_API_KEY` in `.env` or run `npx @google/gemini-cli auth login` |
| `Funding required before safe creation` | Normal — needs ETH | Tell human to fund the Master EOA address, then rerun |
| `Funding required before deployment` | Normal — needs ETH + OLAS | Tell human to fund the Safe address, then rerun |
| Wall of `.operate directory not found` warnings | First-run config resolution noise | Ignore — harmless |
| `Wallet creation failed` | Middleware daemon issue | Check that Python deps are installed, Tendermint is available, and `OPERATE_PASSWORD` is >= 8 chars |

### Runtime

| Symptom | Cause | Fix |
|---------|-------|-----|
| Worker can't connect to Ponder | Network issue or wrong URL | Verify `PONDER_GRAPHQL_URL` matches the pre-filled value in `.env.example` |
| Agent execution fails | LLM auth expired or invalid | Re-authenticate Gemini or check `GEMINI_API_KEY` |
| Git clone fails during job | Missing `GITHUB_TOKEN` or SSH keys | Set `GITHUB_TOKEN` in `.env` for HTTPS clone access |
