---
name: jinn-node-railway-deploy
description: Deploy a jinn-node worker to Railway after local setup, including volume mount, .operate/.gemini import, environment variable setup, canary gateway override, and live health verification.
allowed-tools: Bash, Read, Edit, Write, Glob
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: [railway, tar]
    primaryEnv: OPERATE_PASSWORD
    source: https://github.com/Jinn-Network/jinn-node
---

# jinn-node-railway-deploy

Deploy a `jinn-node` worker to Railway using the standalone `jinn-node` runtime contract.

Use this skill only **after local setup is complete** and `.operate/` exists with a working service.

## When to use

Use this skill when the user asks to:
- deploy a worker to Railway,
- migrate a locally configured operator node to Railway,
- run canary worker validation with a canary `X402_GATEWAY_URL`.

Do not use this skill for local-only setup (`yarn setup`, local worker loops).

## Preconditions

Run these checks first:

```bash
cd jinn-node
[ -d .operate ] || { echo ".operate missing. Run local setup first."; exit 1; }
[ -f .env ] || { echo ".env missing. Copy from .env.example and fill required vars."; exit 1; }
railway --version
railway whoami
```

If `.operate` is missing, stop and direct user to finish local setup first.

## Workflow

### 1. Confirm deployment mode

Ask once:
- `canary` mode: set `X402_GATEWAY_URL` to canary gateway URL.
- `prod` mode: set `X402_GATEWAY_URL` to production gateway URL.

### 2. Create/link Railway project and service

From `jinn-node/`:

```bash
railway login
railway init
railway link
railway up
```

This picks up `railway.toml` automatically.

### 3. Create and attach persistent volume

Create and attach a volume mounted at `/home/jinn`:

```bash
railway volume add --mount-path /home/jinn
railway volume list
# attach if needed:
railway volume attach --volume <volume-id-or-name>
```

The worker requires persisted `/home/jinn/.operate` and `/home/jinn/.gemini`.

### 4. Configure Railway variables

Use the variable contract in `references/variables.md`.

Minimum required values are:
- `RPC_URL`
- `CHAIN_ID=8453`
- `OPERATE_PASSWORD`
- `PONDER_GRAPHQL_URL`
- `CONTROL_API_URL`
- `X402_GATEWAY_URL`

Recommended:
- `GITHUB_TOKEN`
- `GIT_AUTHOR_NAME`
- `GIT_AUTHOR_EMAIL`
- `WORKSTREAM_FILTER` (canary workstream)
- `WORKER_MULTI_SERVICE=true` when `.operate/services` contains 2+ services.

Set values one-by-one to avoid quoting mistakes:

```bash
railway variables set RPC_URL="..."
railway variables set CHAIN_ID="8453"
railway variables set OPERATE_PASSWORD="..."
railway variables set PONDER_GRAPHQL_URL="..."
railway variables set CONTROL_API_URL="..."
railway variables set X402_GATEWAY_URL="..."
```

### 5. Import `.operate` and `.gemini`

Use the `tar` streaming method in `references/volume-import.md`.

This is mandatory before first successful worker run.

### 6. Deploy and verify

```bash
railway up
railway logs -f
```

Expected signals in logs:
- init script completed,
- worker started,
- no keystore decryption failure,
- worker polling requests,
- health endpoint available.

### 7. Canary validation (if canary mode)

- Keep `WORKSTREAM_FILTER` restricted to canary workstream.
- Keep `X402_GATEWAY_URL` pointed at canary gateway.
- Run canary job(s), validate tool/business success and delivery.
- Promote by switching only `X402_GATEWAY_URL` to prod and redeploying.

## Runtime contract reminders

- Railway deployment is `.operate`-first (`/home/jinn/.operate`).
- `JINN_SERVICE_MECH_ADDRESS` and `JINN_SERVICE_SAFE_ADDRESS` are fallback overrides, not primary operator flow.
- Use `jinn-node/railway.toml` (standalone), not monorepo deploy configs.

## Failure handling

If deployment fails:
1. capture `railway logs --lines 300`,
2. confirm volume exists and is attached,
3. confirm `/home/jinn/.operate` and `/home/jinn/.gemini` are present,
4. verify `OPERATE_PASSWORD` matches local keystore,
5. verify endpoint URLs and gateway mode (canary vs prod).
