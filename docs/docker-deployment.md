# Docker Deployment Guide

Run a jinn-node worker in a Docker container.

## Prerequisites

- Docker Engine 24+ and Docker Compose v2+
- Completed OLAS setup (`.operate/` directory with encrypted keystore)
- Gemini CLI authenticated (`~/.gemini/` with `oauth_creds.json`)
- Base chain RPC endpoint (e.g., Alchemy, Infura)

## Quick Start

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env: set RPC_URL, OPERATE_PASSWORD, and optionally GEMINI_API_KEY

# 2. Import credentials into the persistent volume
docker volume create jinn-node_node-data
docker run --rm -v jinn-node_node-data:/home/jinn \
  -v /path/to/your/.operate:/src-operate \
  -v ~/.gemini:/src-gemini \
  busybox sh -c "cp -a /src-operate /home/jinn/.operate && cp -a /src-gemini /home/jinn/.gemini"

# 3. Build and start
docker compose up -d --build

# 4. Check health
curl http://localhost:8080/health
docker compose logs -f worker
```

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `RPC_URL` | Base chain RPC endpoint | `https://base-mainnet.g.alchemy.com/v2/KEY` |
| `CHAIN_ID` | Network ID | `8453` |
| `OPERATE_PASSWORD` | Decrypts `.operate/` keystore (min 8 chars) | — |

### Service Endpoints (defaults to hosted infrastructure)

| Variable | Default |
|----------|---------|
| `PONDER_GRAPHQL_URL` | `https://ponder-production-6d16.up.railway.app/graphql` |
| `CONTROL_API_URL` | `https://control-api-production-c1f5.up.railway.app/graphql` |
| `X402_GATEWAY_URL` | `https://x402-gateway-production-1b84.up.railway.app` |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Alternative to OAuth (simpler, no `.gemini/` needed) | — |
| `GEMINI_OAUTH_CREDENTIALS` | OAuth creds JSON array (written to `~/.gemini/` at startup) | — |
| `GITHUB_TOKEN` | For code-based tasks | — |
| `GIT_AUTHOR_NAME` | Git commit identity | — |
| `GIT_AUTHOR_EMAIL` | Git commit identity | — |
| `WORKSTREAM_FILTER` | Filter specific workstream | — |
| `WORKER_COUNT` | Parallel workers per container | `1` |
| `WORKER_MECH_FILTER_MODE` | `staking` / `list` / `single` / `any` | `single` |
| `HEALTHCHECK_PORT` | Health endpoint port | `8080` |

### Set by Docker (do not override)

| Variable | Value | Reason |
|----------|-------|--------|
| `GEMINI_SANDBOX` | `false` | macOS `sandbox-exec` unavailable in Linux containers |
| `OPERATE_PROFILE_DIR` | `/home/jinn/.operate` | Volume mount path |
| `NODE_ENV` | `production` | Runtime optimization |

> **Security note:** For production deployments, avoid storing `OPERATE_PASSWORD` in a plaintext `.env` file. Use [Docker secrets](https://docs.docker.com/engine/swarm/secrets/), a secrets manager, or inject the value from your CI/CD pipeline at runtime.

## Volumes

### `node-data` → `/home/jinn` (CRITICAL)

The jinn user's home directory. Contains:

- `.operate/` — Encrypted wallet keystore and service configuration. **Loss of this data means loss of signing keys.** Back up regularly.
- `.gemini/` — OAuth credentials (`oauth_creds.json`, `google_accounts.json`), CLI settings, and installed extensions. Persisting avoids re-authentication and extension re-downloads.

### `jinn-repos` → `/app/jinn-repos` (ephemeral)

Cached venture repository clones. Can be safely deleted — repos are re-cloned as needed.

## Importing Credentials

Before first start, import your local `.operate/` and `.gemini/` directories into the Docker volume:

```bash
docker volume create jinn-node_node-data

docker run --rm -v jinn-node_node-data:/home/jinn \
  -v /path/to/your/.operate:/src-operate \
  -v ~/.gemini:/src-gemini \
  busybox sh -c "cp -a /src-operate /home/jinn/.operate && cp -a /src-gemini /home/jinn/.gemini"
```

To verify the import:
```bash
docker run --rm -v jinn-node_node-data:/home/jinn busybox ls -la /home/jinn/.operate /home/jinn/.gemini
```

## Deploy to Railway

[Railway](https://railway.com?referralCode=vEDcil) provides one-click cloud deployment. The repo includes a pre-configured `railway.toml` that uses the Dockerfile.

1. Fork jinn-node on GitHub
2. Create a Railway project → "Deploy from GitHub Repo" → select your fork
3. Add a persistent volume at mount path `/home/jinn`
4. Set environment variables from `.env.example` in the Railway dashboard
5. Import your `.operate/` directory into the volume (via `railway shell`)
6. Deploy — Railway auto-detects the Dockerfile and `railway.toml`

The healthcheck, restart policy, and init script are pre-configured. See [AGENTS.md](../AGENTS.md#phase-5-deploy-to-railway-optional) for the full step-by-step guide.

## Scaling

Run multiple workers with the `WORKER_COUNT` environment variable:

```bash
# In .env
WORKER_COUNT=3
```

Or run multiple container instances with workstream filtering:

```bash
# Instance 1
WORKSTREAM_FILTER=0xabc...

# Instance 2
WORKSTREAM_FILTER=0xdef...
```

## Monitoring

When running without `docker compose` (standalone `docker run`), add a healthcheck manually:

```bash
docker run -d --name jinn-worker \
  --health-cmd='node -e "fetch(\"http://localhost:8080/health\").then(r=>{if(r.ok)process.exit(0);else process.exit(1)}).catch(()=>process.exit(1))"' \
  --health-interval=30s --health-timeout=5s --health-start-period=60s --health-retries=3 \
  jinn-node
```

The worker exposes a health endpoint at `GET /health` (port 8080) returning:

```json
{
  "status": "ok",
  "nodeId": "a1b2c3d4",
  "uptime": { "ms": 3600000, "human": "1h 0m" },
  "processedJobs": 42,
  "efficiency": {
    "idleCycles": 100,
    "avgJobDurationMs": 45000,
    "idlePercent": 85
  }
}
```

## Updating

```bash
docker compose build --no-cache
docker compose up -d
```

## Troubleshooting

### Chrome crashes with "Failed to launch browser"

- Ensure `shm_size` is at least `1gb` in `docker-compose.yml` (default: `2gb`)
- Verify Chromium is installed: `docker run --rm jinn-node chromium-browser --version`

### "OPERATE_PASSWORD not set" error

- Ensure `OPERATE_PASSWORD` is in your `.env` file
- The `.operate/` directory must exist in the volume with encrypted keystores

### Healthcheck failing

- The worker takes ~60 seconds to initialize (covered by `start_period`)
- Check logs: `docker compose logs worker`
- Verify endpoint: `curl http://localhost:8080/health`

### Gemini authentication errors

- Check that `.gemini/oauth_creds.json` exists in the volume
- Alternative: set `GEMINI_API_KEY` in `.env` (simpler, no `.gemini/` volume needed)
- Verify: `docker run --rm -v jinn-node_node-data:/home/jinn busybox cat /home/jinn/.gemini/oauth_creds.json`

### Container runs out of memory

- Increase the `memory` limit in `docker-compose.yml` (default: `8G`)
- Gemini CLI + Chrome + MCP tools can be memory-intensive during job execution
