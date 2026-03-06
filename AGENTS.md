# JINN Node Agent Entry Point

This file is the routing index for coding agents operating `jinn-node`.

Use dedicated skills for operational workflows. Keep this file minimal.

## Default Venture Context

Primary onboarding venture:

`https://explorer.jinn.network/ventures/0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac`

## Global Non-Negotiables

1. **Security disclosure first** for first-time setup sessions:
   - LLM provider can process terminal session data (including wallet password and mnemonic output).
   - Do not proceed until operator acknowledges.
2. **Railway deploy happens after local setup**:
   - `.operate/` must exist and be valid before Railway migration.
3. **Sensitive operations require explicit confirmation**:
   - mnemonic/key export,
   - destructive recovery operations,
   - non-dry-run fund movements.
4. **GitHub token is strongly encouraged at setup**:
   - without `GITHUB_TOKEN`, participation in most coding jobs is limited or fails.

## Skill Router

Use these skills based on task intent:

- Local first-time onboarding (stOLAS default, OLAS fallback):
  - [`skills/jinn-node-operator-setup/SKILL.md`](skills/jinn-node-operator-setup/SKILL.md)
- Railway deployment and canary/prod gateway switching:
  - [`skills/jinn-node-railway-deploy/SKILL.md`](skills/jinn-node-railway-deploy/SKILL.md)
- Wallet operations (backup/export/withdraw/unstake/recover):
  - [`skills/jinn-node-wallet-ops/SKILL.md`](skills/jinn-node-wallet-ops/SKILL.md)
- Staking reward operations:
  - [`skills/jinn-node-staking-ops/SKILL.md`](skills/jinn-node-staking-ops/SKILL.md)
- Support triage and diagnostics:
  - [`skills/jinn-node-support-triage/SKILL.md`](skills/jinn-node-support-triage/SKILL.md)
- High-level baseline onboarding:
  - [`skills/jinn-node/SKILL.md`](skills/jinn-node/SKILL.md)

## Default Execution Order (new operator)

1. Local setup: `jinn-node-operator-setup`
   - **Default path:** stOLAS (no OLAS required, ~0.01 ETH total)
   - **Fallback:** Standard OLAS staking if stOLAS slots are full or distributor not configured (requires ~10,000 OLAS)
2. Optional local validation run (`yarn worker --single`)
3. Railway migration: `jinn-node-railway-deploy`
4. Ongoing operations via wallet/staking/support skills

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

## Setup, Environment & Worker

For the full step-by-step setup workflow, use the **operator setup skill**:

→ [`skills/jinn-node-operator-setup/SKILL.md`](skills/jinn-node-operator-setup/SKILL.md)

This covers: prerequisites, `.env` configuration, `yarn setup` / `yarn setup --stolas`, mnemonic capture, key backup, funding loops, delivery rate verification, and initial worker run.

### Configuration (jinn.yaml)

`jinn.yaml` is auto-generated on first run with correct defaults for the Jinn network. **Do not create it manually.**

#### Multi-Staking Contract Support

`staking.contract` supports **comma-separated** addresses. The worker queries each contract in parallel and merges all staked mech addresses into one filter pool:

```yaml
staking:
  # Single contract (default)
  contract: "0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488"

  # Multiple contracts — worker picks up requests for mechs in ANY of these pools
  contract: "0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139,0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488"
```

Each contract's mech list is cached independently (5-minute TTL). To customize, edit `jinn.yaml` after first run. Legacy env var names also work as overrides.

**Multi-operator note:** The worker uses `staking` filter mode by default, so it sees requests dispatched to ANY mech in the Jinn staking contract — not just its own. Each request has a 61-second priority window for the original mech, after which any staked mech can deliver.

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
5. **Set secrets** in the Railway dashboard (Variables tab):

   Copy secrets from your local `.env` file:

   | Variable | Description |
   |----------|-------------|
   | `RPC_URL` | Base chain RPC endpoint |
   | `CHAIN_ID` | `8453` |
   | `OPERATE_PASSWORD` | Decrypts `.operate/` keystore |
   | `GEMINI_API_KEY` | Gemini API key |
   | `GITHUB_TOKEN` | For code task repo cloning |
   | `GIT_AUTHOR_NAME` | Git commit identity |
   | `GIT_AUTHOR_EMAIL` | Git commit identity |

   If your RPC requires auth (e.g. `RPC_PROXY_TOKEN`), add that too. Configuration values are in `jinn.yaml`, which is auto-generated on first run. For Railway, `jinn.yaml` lives on the persistent volume.

6. **Import `.operate/` into the volume.** Use `railway shell` to access the running container, then copy your local `.operate/` directory contents into `/home/jinn/.operate/`. Alternatively, use `railway volume` commands or the Railway CLI.

7. **Deploy.** Railway builds and deploys automatically on push. The healthcheck at `/health` confirms the worker is running.

### CLI Deploy (Alternative)

If the operator prefers the Railway CLI over the dashboard:

```bash
cd jinn-node
railway login
railway link    # Link to your Railway project
railway up      # Deploy
railway logs --lines 100  # View recent logs
```

### Monitoring

- **Logs**: Railway dashboard → Deployments → Logs, or `railway logs --lines 100`
- **Health**: The worker exposes `GET /health` — Railway monitors this automatically
- **Restarts**: `railway.toml` configures automatic restart on failure (up to 10 retries)

---

## Staking Reward Claims

OLAS staking rewards require two separate claim steps. Both require `OPERATE_PASSWORD` in `.env`.

### 1. Claim L1 Dispenser Incentives (every ~14 days)

Bridges OLAS from the Ethereum mainnet Dispenser to the Jinn staking contract on Base. This must be done after each tokenomics epoch ends (~14 days). Permissionless — any EOA with mainnet ETH can call it.

```bash
cd jinn-node
yarn staking:claim-incentives              # Claim all pending epochs
yarn staking:claim-incentives --dry-run    # Preview without sending txs
```

**Requirements:** Master EOA needs ~0.005 ETH on Ethereum mainnet for gas. The Dispenser enforces `maxNumClaimingEpochs=1`, so the script automatically loops to claim one epoch at a time. After claiming, OLAS arrives on Base via the Optimism bridge (~20 min delay).

### 2. Claim Service Rewards (after each L2 checkpoint)

Claims rewards allocated to a specific service by the staking contract on Base. The L2 `checkpoint()` (called automatically by the worker every ~24h) allocates rewards to eligible services. This script then claims those rewards via the Master Safe.

```bash
cd jinn-node
yarn staking:claim-rewards              # Claim pending rewards for service 165
yarn staking:claim-rewards --dry-run    # Preview without sending tx
```

**Requirements:** Master EOA needs Base ETH for gas. Safe threshold must be 1. Rewards are sent to the service multisig.

### Reward Flow Summary

```
L1 Tokenomics Epoch ends (~14 days)
  → yarn staking:claim-incentives     (L1 tx, bridges OLAS to Base)
  → ~20 min bridge delay
  → Worker calls checkpoint()         (automatic, allocates to services)
  → yarn staking:claim-rewards        (L2 Safe tx, sends OLAS to multisig)
```

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
| `yarn wallet:restake` | Restake an evicted service |

**Destructive operations** (`recover`, `export-keys`): Always pause and get human confirmation before executing. Use `--dry-run` where available to preview first.

**Key flags:**
- `withdraw`: `--to <addr>` (required), `--asset ETH|OLAS|all` (default: all), `--dry-run`
- `recover`: `--to <addr>` (required), `--dry-run`, `--skip-terminate` (if already unstaked)
- `unstake`: `--service-id <id>` (optional, reads from config), `--dry-run`
- `restake`: `--service <config-id>` (optional), `--dry-run`

**72-hour staking cooldown**: OLAS requires minimum 72 hours staked before unstake. Recovery will fail if cooldown has not elapsed.

---

## Service Management

| Command | Purpose |
|---------|---------|
| `yarn service:list` | List all configured services in `.operate/` |
| `yarn service:status` | Show health status for all services |
| `yarn service:fleet` | Fleet health summary (JSON output) |
| `yarn service:add` | Add another service (multi-service rotation) |
| `yarn rewards:summary` | View pending staking rewards |
| `yarn wallet:restake --target=jinn_v2` | Migrate between staking contracts |

---

## Optional Configuration

These settings can be customized in `jinn.yaml` (auto-generated on first run):

| YAML Path | Default | Description |
|-----------|---------|-------------|
| `filtering.earning_schedule` | (empty — always earning) | Time window for job claiming, e.g. `22:00-08:00`. Overnight windows work. |
| `filtering.earning_max_jobs` | `0` (unlimited) | Max jobs per earning window |
| `worker.poll_base_ms` | `30000` | Base polling interval |
| `worker.poll_max_ms` | `300000` | Max idle polling interval |
| `filtering.workstreams` | `[]` (all) | Restrict to specific workstream IDs |

Legacy env var names (e.g., `EARNING_SCHEDULE`, `EARNING_MAX_JOBS`) also work as overrides in `.env`.

---

## Getting Help — Support Bundle

If you're having issues and need help from the Jinn team, run the support bundle to collect diagnostic information:

```bash
cd jinn-node
yarn support:bundle
```

This outputs a JSON bundle containing:
- System info (OS, Node/Python versions, git commit)
- Which environment variables are set (never the actual values of secrets)
- Wallet addresses and on-chain balances
- Staking status
- Connectivity checks (RPC, Ponder indexer, Control API)
- `.operate` directory state

**No passwords, API keys, or private keys are ever included.** The output is safe to share.

### How to share

1. Run `yarn support:bundle` and copy the JSON output
2. Share it with the Jinn team (Discord, GitHub issue, or direct message)
3. If the worker is running on Railway, also include recent logs: `railway logs --tail 50`

### What to include with the bundle

When reporting an issue, also describe:
- **What you expected** to happen
- **What actually happened** (error messages, unexpected behavior)
- **When it started** (after an update? after restaking? randomly?)
- **Steps to reproduce** if you can

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
| Worker can't connect to Ponder | Network issue or wrong URL | Check `jinn.yaml` has correct `services.ponder_url` (default is correct for Jinn network) |
| Agent execution fails | LLM auth expired or invalid | Re-authenticate Gemini or check `GEMINI_API_KEY` |
| Git clone fails during job | Missing `GITHUB_TOKEN` or SSH keys | Set `GITHUB_TOKEN` in `.env` for HTTPS clone access |
