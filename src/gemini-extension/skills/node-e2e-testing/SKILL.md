---
name: node-e2e-testing
description: End-to-end test the jinn-node operator experience using Tenderly VNets. Activates when running E2E tests, validating operator setup, testing worker job execution, or verifying wallet recovery. Use when asked to "run e2e tests", "test jinn-node", "validate operator flow", or "test on tenderly".
allowed-tools: Bash Read Edit Write Glob Grep
user-invocable: true
disable-model-invocation: true
argument-hint: "[worker|wallet|docker|operator|all]"
---

# jinn-node E2E Testing

Validates the full jinn-node operator lifecycle on a Tenderly VNet.

**IMPORTANT: Always start fresh.** Every session must create a new VNet and a new jinn-node clone. Never reuse existing VNets or clones.

## Session Strategy

Tenderly free tier allows ~5-10 write transactions per VNet. Full coverage requires multiple sessions:

| Argument | Sessions | What it tests |
|----------|----------|---------------|
| `worker` | 1 VNet | Setup → Operator scripts → Dispatch → Worker execution with rotation (bare) |
| `wallet` | 1 VNet | Setup → Wallet info → Recovery (unstake + withdraw) |
| `docker` | 1 VNet | Setup (bare) → Docker build → Docker worker execution |
| `operator` | 1 VNet | Setup → Operator scripts → Add 2nd service → Multi-service validation |
| `all` | 4 VNets | `worker` first, then `wallet`, then `docker`, then `operator` |

**Based on the argument, read the corresponding session file:**
- `worker` or `all` → read [references/worker-session.md](references/worker-session.md)
- `wallet` or `all` → read [references/wallet-session.md](references/wallet-session.md)
- `docker` or `all` → read [references/docker-session.md](references/docker-session.md)
- `operator` or `all` → read [references/operator-session.md](references/operator-session.md)

For `all`: complete each session (including cleanup) before starting the next.

## Quick Reference

| Script | Purpose |
|--------|---------|
| `yarn test:e2e:vnet create` | Create VNet, save RPC to `.env.e2e` |
| `yarn test:e2e:vnet fund <addr> --eth N --olas N` | Fund address on VNet |
| `yarn test:e2e:vnet time-warp <seconds>` | Advance VNet time |
| `yarn test:e2e:vnet status` | Check VNet health + quota |
| `yarn test:e2e:vnet cleanup --max-age-hours=0` | Delete all VNets |
| `yarn test:e2e:dispatch --workstream <id> --cwd <path>` | Dispatch job in workstream |
| `yarn test:e2e:stack` | Start local Ponder + Control API |
| `docker build -f jinn-node/Dockerfile jinn-node/ -t jinn-node:e2e` | Build Docker image for testing |

## Prerequisites

1. **Tenderly creds in `.env.test`** (monorepo root): `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT_SLUG`, `TENDERLY_PROJECT_SLUG`.
2. **Supabase creds in `.env`**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (needed by Control API).
3. **Runtime**: Node 22+, Python 3.10-3.11, Poetry, `yarn install` completed.
4. **Gemini CLI**: Authenticated (`~/.gemini/oauth_creds.json`).

**Environment file priority**: `.env` (base creds) -> `.env.test` override (Tenderly creds) -> `.env.e2e` override (VNet RPC_URL).

## Shared Steps (every session starts with these)

### 1. Infrastructure

```bash
yarn test:e2e:vnet cleanup --max-age-hours=0  # Delete any stale VNets
yarn test:e2e:vnet create   # Creates NEW VNet, writes fresh .env.e2e
yarn test:e2e:stack          # Kills old processes, cleans .ponder cache, starts Ponder + Control API
# Wait for "Local stack ready" — leave running in its own terminal
```

The stack script automatically kills port processes, cleans `.ponder` cache, sets `PONDER_START_BLOCK` near VNet head, and reads RPC_URL from `.env.e2e`.

### 2. Setup

Ask the user which branch to test. List available branches:
```bash
git ls-remote --heads git@github.com:Jinn-Network/jinn-node.git | sed 's|.*refs/heads/||'
```

Clone the chosen branch:
```bash
CLONE_DIR=$(mktemp -d)/jinn-node
BRANCH=main  # or the branch the user chose
git clone -b "$BRANCH" https://github.com/Jinn-Network/jinn-node.git "$CLONE_DIR"
cd "$CLONE_DIR" && yarn install
cp .env.example .env
```

Save session state to `.env.e2e`:
```bash
echo "CLONE_DIR=$CLONE_DIR" >> .env.e2e
echo "OPERATE_PASSWORD=e2e-test-password-2024" >> .env.e2e
```

Edit `$CLONE_DIR/.env` — read RPC_URL from `.env.e2e`:
```
RPC_URL=<from .env.e2e>
OPERATE_PASSWORD=e2e-test-password-2024
PONDER_GRAPHQL_URL=http://localhost:42069/graphql
CONTROL_API_URL=http://localhost:4001/graphql
STAKING_CONTRACT=0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139
WORKSTREAM_FILTER=0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac
X402_GATEWAY_URL=https://x402-gateway-production-1b84.up.railway.app
```

**Setup is iterative** — it pauses when funding is needed, prints exact addresses and amounts. Fund those exact amounts and re-run until it completes:
```bash
cd "$CLONE_DIR" && yarn setup
# Read funding requirements from output, then from monorepo root:
yarn test:e2e:vnet fund <address> --eth <amount> --olas <amount>
cd "$CLONE_DIR" && yarn setup
# Repeat until complete.
```

### 3. Continue with session-specific steps

Now read the relevant session file and follow its instructions.

## Cleanup

After each session, ask user: clean up or leave for debugging?
- `yarn test:e2e:vnet cleanup --max-age-hours=0` — delete all VNets
- `rm -rf "$CLONE_DIR"` — remove temp clone
- Ctrl+C — stop local stack

## Troubleshooting

See [references/troubleshooting.md](references/troubleshooting.md) for common issues.
