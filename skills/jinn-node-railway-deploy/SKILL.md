---
name: jinn-node-railway-deploy
description: Deploy a jinn-node worker to Railway after local setup, including volume mount, .operate/.gemini import, environment variable setup, canary gateway override, and live health verification.
allowed-tools: Bash, Read, Edit, Write, Glob
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: [railway, tar]
      railway_min_version: "4.16.0"
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

# 1. Local setup must be complete
[ -d .operate ] || { echo ".operate missing. Run local setup first."; exit 1; }
[ -f .env ] || { echo ".env missing. Copy from .env.example and fill required vars."; exit 1; }

# 2. Railway CLI version check (minimum 4.16.0)
RAILWAY_VERSION=$(railway --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
if [ -z "$RAILWAY_VERSION" ]; then
  echo "Railway CLI not found. Install: npm install -g @railway/cli"
  exit 1
fi
MAJOR=$(echo "$RAILWAY_VERSION" | cut -d. -f1)
MINOR=$(echo "$RAILWAY_VERSION" | cut -d. -f2)
if [ "$MAJOR" -lt 4 ] || { [ "$MAJOR" -eq 4 ] && [ "$MINOR" -lt 16 ]; }; then
  echo "Railway CLI $RAILWAY_VERSION is too old. Minimum: 4.16.0"
  echo "Update: npm install -g @railway/cli@latest"
  exit 1
fi
echo "Railway CLI $RAILWAY_VERSION OK"

# 3. Authentication check
railway whoami || { echo "Not logged in. Run: railway login"; exit 1; }
```

If `.operate` is missing, stop and direct user to finish local setup first.

## Workflow

### 1. Confirm deployment mode

Ask once:
- `canary` mode: set `X402_GATEWAY_URL` to canary gateway URL.
- `prod` mode: set `X402_GATEWAY_URL` to production gateway URL.

### 2. Link or create Railway project and service

First, check if already linked:

```bash
railway status
```

If already linked to the correct project **and** service, skip to step 3.

**Option A — Existing project, existing service:**

Always include `-s` to link the service. Without it, `railway link` leaves the service unlinked and subsequent commands (`volume add`, `variables --set`, `up`) fail with "No service found".

```bash
railway link -p <project-name-or-id> -s <service-name> -e production
```

**Option B — Existing project, new service:**

Link the project first (without `-s`), then create and link the new service:

```bash
railway link -p <project-name-or-id> -e production
railway add --service <new-service-name>
railway service link <new-service-name>
```

**Option C — New project:**

```bash
railway init
# When prompted, select workspace and enter project name.
# After creation, add and link the service:
railway add --service <service-name>
railway service link <service-name>
```

**Important:**
- `railway init` creates a new project every time. Always check `railway status` first to avoid duplicates.
- `railway link` without `-s` leaves no service linked. Always verify with `railway status` that both project and service are shown before proceeding.

### 3. Create and attach persistent volume

```bash
railway volume add --mount-path /home/jinn
```

Verify:

```bash
railway volume list
```

The worker requires persistent `/home/jinn/.operate` and `/home/jinn/.gemini`.

### 4. Configure Railway variables

Use the variable contract in `references/variables.md`.

Batch all variables in a single call with `--skip-deploys`:

```bash
railway variables \
  --set "RPC_URL=..." \
  --set "CHAIN_ID=8453" \
  --set "OPERATE_PASSWORD=..." \
  --set "PONDER_GRAPHQL_URL=..." \
  --set "CONTROL_API_URL=..." \
  --set "X402_GATEWAY_URL=..." \
  --skip-deploys
```

Strongly recommended (can be batched in the same or a separate call):

```bash
railway variables \
  --set "GITHUB_TOKEN=..." \
  --set "GIT_AUTHOR_NAME=..." \
  --set "GIT_AUTHOR_EMAIL=..." \
  --set "WORKSTREAM_FILTER=..." \
  --set "WORKER_MULTI_SERVICE=true" \
  --skip-deploys
```

**Note:** Multiple `--set` flags work in one call. Use `--skip-deploys` to defer deployment until step 5.

### 5. Deploy idle container for SSH import

The volume import (step 6) requires `railway ssh`, which needs a running container. But the real worker will crash without `.operate/` on the volume. Deploy with an idle start command first.

Temporarily edit `railway.toml`:

```toml
[deploy]
startCommand = "tail -f /dev/null"
```

Then deploy:

```bash
railway up --detach
```

Wait for it to reach Running state:

```bash
railway service status
```

### 6. Import .operate and .gemini via SSH

With the idle container running, stream credentials into the volume:

```bash
# Create target directories
railway ssh -- bash -lc 'mkdir -p /home/jinn/.operate /home/jinn/.gemini'

# Stream .operate
tar czf - .operate | railway ssh -- bash -lc 'tar xzf - -C /home/jinn'

# Stream .gemini (if using Gemini CLI OAuth)
[ -d "$HOME/.gemini" ] && tar czf - -C "$HOME" .gemini | railway ssh -- bash -lc 'tar xzf - -C /home/jinn'

# Verify
railway ssh -- bash -lc 'ls -la /home/jinn/.operate /home/jinn/.gemini'
```

**Fallback:** If `railway ssh` fails, use the Railway dashboard shell (Project > Service > Shell tab) to run the tar commands manually.

See `references/volume-import.md` for details.

### 7. Restore real start command and redeploy

Restore `railway.toml` to the real start command:

```toml
[deploy]
startCommand = "bash scripts/init.sh && node dist/worker/worker_launcher.js"
healthcheckPath = "/health"
healthcheckTimeout = 300
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

Redeploy:

```bash
railway up --detach
```

### 8. Verify deployment

Check deployment status and retrieve logs:

```bash
# List recent deployments to identify the deployment ID
railway deployment list

# Get deployment-specific logs (replace <deployment-id> with the ID from above)
railway logs --lines 200 <deployment-id>
```

Expected signals in logs:
- `[init] Worker initialization complete`
- Worker started and polling for requests
- No keystore decryption failure
- Health endpoint responding

**Healthcheck port:** Railway auto-sets the `PORT` environment variable. The worker reads `HEALTHCHECK_PORT` > `PORT` > `8080` (default). Do not set `PORT` manually.

**Do NOT use `railway logs -f`** — in CLI 4.16+, `-f` is the `--filter` flag, not "follow". Default `railway logs` (without `--lines`) streams live. Use `railway logs --lines N` for historical logs.

### 9. Canary validation (if canary mode)

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

1. List deployments and identify the failed one:
   ```bash
   railway deployment list
   ```

2. Capture deployment-specific logs:
   ```bash
   railway logs --lines 300 <failed-deployment-id>
   ```

3. Confirm volume exists and is attached:
   ```bash
   railway volume list
   ```

4. Confirm `/home/jinn/.operate` and `/home/jinn/.gemini` are present:
   ```bash
   railway ssh -- bash -lc 'ls -la /home/jinn/.operate /home/jinn/.gemini'
   ```

5. Verify `OPERATE_PASSWORD` matches local keystore.

6. Verify endpoint URLs and gateway mode (canary vs prod).
