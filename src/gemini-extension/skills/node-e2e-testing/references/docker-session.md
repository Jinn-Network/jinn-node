# Docker Session

Tests: Setup (bare) → Docker build → Docker worker execution with tool use → Healthcheck → IPFS upload → On-chain delivery.

**Prerequisite**: Complete the shared steps (Infrastructure + Setup) from SKILL.md first. Setup runs bare — the Docker image doesn't include Python/Poetry.

## Build the Docker Image

From the monorepo root:
```bash
docker build -f jinn-node/Dockerfile jinn-node/ -t jinn-node:e2e
```

This validates the multi-stage build: TypeScript compilation, Chromium install, Gemini CLI pre-install, production dependency pruning.

If the build fails with `ECONNRESET` on the Gemini CLI install, retry — earlier layers are cached.

## Dispatch a Job

Same as the worker session — from the monorepo root:
```bash
yarn test:e2e:dispatch \
  --workstream 0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac \
  --cwd "$CLONE_DIR"
```

## Fund the Agent EOA

```bash
yarn test:e2e:vnet fund <agent-eoa-address> --eth 0.01
```

## Run the Worker via Docker

Wait a few seconds for Ponder to index the marketplace request, then:

```bash
docker run --rm \
  --name jinn-e2e-worker \
  --network host \
  --env-file "$CLONE_DIR/.env" \
  -e GEMINI_SANDBOX=false \
  -e OPERATE_PROFILE_DIR=/home/jinn/.operate \
  -e JINN_WORKSPACE_DIR=/app/jinn-repos \
  -e PONDER_GRAPHQL_URL=http://localhost:42069/graphql \
  -e CONTROL_API_URL=http://localhost:4001/graphql \
  -v "$CLONE_DIR/.operate:/home/jinn/.operate" \
  -v "$HOME/.gemini:/home/jinn/.gemini:ro" \
  --shm-size=2g \
  jinn-node:e2e \
  node dist/worker/mech_worker.js --single
```

Key points:
- `--network host` — container reaches Ponder (42069) and Control API (4001) on localhost
- `.operate/` mounted from clone dir (contains keystore + service config from bare setup)
- `.gemini/` mounted read-only from host (OAuth creds)
- CMD overridden to `mech_worker.js --single` (not the continuous `worker_launcher.js`)
- `--shm-size=2g` — Chromium needs more than the default 64MB shared memory

### macOS note

`--network host` doesn't work on Docker Desktop for Mac the same way as Linux. If the container can't reach localhost services, use `host.docker.internal` instead:

```bash
docker run --rm \
  --name jinn-e2e-worker \
  --env-file "$CLONE_DIR/.env" \
  -e GEMINI_SANDBOX=false \
  -e OPERATE_PROFILE_DIR=/home/jinn/.operate \
  -e JINN_WORKSPACE_DIR=/app/jinn-repos \
  -e PONDER_GRAPHQL_URL=http://host.docker.internal:42069/graphql \
  -e CONTROL_API_URL=http://host.docker.internal:4001/graphql \
  -v "$CLONE_DIR/.operate:/home/jinn/.operate" \
  -v "$HOME/.gemini:/home/jinn/.gemini:ro" \
  --shm-size=2g \
  jinn-node:e2e \
  node dist/worker/mech_worker.js --single
```

## Verify Healthcheck (optional)

To test the healthcheck with the continuous launcher instead of `--single`:

```bash
docker run -d \
  --name jinn-e2e-healthcheck \
  --network host \
  --env-file "$CLONE_DIR/.env" \
  -e GEMINI_SANDBOX=false \
  -e OPERATE_PROFILE_DIR=/home/jinn/.operate \
  -e JINN_WORKSPACE_DIR=/app/jinn-repos \
  -v "$CLONE_DIR/.operate:/home/jinn/.operate" \
  -v "$HOME/.gemini:/home/jinn/.gemini:ro" \
  --shm-size=2g \
  -p 8080:8080 \
  jinn-node:e2e

# Wait ~60s for startup, then:
curl http://localhost:8080/health
# Should return JSON with status, nodeId, uptime, processedJobs

docker stop jinn-e2e-healthcheck && docker rm jinn-e2e-healthcheck
```

## Verify Tool Use

Same as worker session — check telemetry from the container output. The worker logs the telemetry path early in execution. Since the container runs with `--rm`, capture stdout:

```bash
docker run --rm \
  --name jinn-e2e-worker \
  --network host \
  --env-file "$CLONE_DIR/.env" \
  -e GEMINI_SANDBOX=false \
  -e OPERATE_PROFILE_DIR=/home/jinn/.operate \
  -e JINN_WORKSPACE_DIR=/app/jinn-repos \
  -v "$CLONE_DIR/.operate:/home/jinn/.operate" \
  -v "$HOME/.gemini:/home/jinn/.gemini:ro" \
  -v /tmp/jinn-telemetry:/tmp \
  --shm-size=2g \
  jinn-node:e2e \
  node dist/worker/mech_worker.js --single 2>&1 | tee /tmp/docker-worker-output.log
```

The `-v /tmp/jinn-telemetry:/tmp` mount ensures telemetry files are accessible on the host after the container exits.

Then parse telemetry using the streaming parser from [worker-session.md](worker-session.md#step-1-parse-telemetry-and-check-tool-configuration).

## Expected Flow

1. **Build** — Docker image compiles TypeScript, installs Chromium + Gemini CLI
2. **Poll** — Containerized worker queries Ponder, finds 1 undelivered request
3. **Claim** — Worker claims the job via Control API
4. **Execute** — Spawns Gemini CLI agent with MCP tools (uses pre-installed CLI)
5. **Tool use** — Agent calls `google_web_search` and `create_artifact`
6. **Upload** — Result uploaded to IPFS
7. **Deliver** — On-chain delivery via Safe transaction

## Acceptable Failures

- **Delivery fails with 403 (quota exhausted)**: OK — the key validation is Docker execution with tool use + IPFS upload.
- **`--network host` doesn't work on macOS**: Use `host.docker.internal` variant above.
- **Chromium sandbox warning**: Expected — `GEMINI_SANDBOX=false` disables macOS sandbox (unavailable in Linux containers).

## Success Criteria

- [ ] Docker image builds successfully
- [ ] Container starts without crash
- [ ] Worker found and claimed the dispatched request
- [ ] Agent called `google_web_search` at least once
- [ ] Agent called `create_artifact` at least once
- [ ] Result was uploaded to IPFS
- [ ] On-chain delivery attempted (success or quota error)
- [ ] Healthcheck returns valid JSON (if tested)
