# Docker Session

Tests: Setup (bare) → Docker build → Docker worker execution with tool use → Healthcheck → IPFS upload → On-chain delivery.

**Prerequisite**: Complete the shared steps (Infrastructure + Setup) from SKILL.md first. Setup runs bare — the Docker image doesn't include Python/Poetry.

**Shell variables**: Commands below use `$CLONE_DIR`. Resolve to the absolute path before running — shell state does not persist between separate bash calls.

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
yarn test:e2e:docker-run --cwd "$CLONE_DIR" --single
```

The wrapper script handles:
- macOS detection (`host.docker.internal` vs `localhost`)
- Individual auth file mounts (avoids host extension symlinks crashing the CLI)
- All fixed env vars (`GEMINI_SANDBOX`, `OPERATE_PROFILE_DIR`, etc.)
- `--shm-size=2g` for Chromium

## Verify Healthcheck (required)

```bash
yarn test:e2e:docker-run --cwd "$CLONE_DIR" --healthcheck
```

Wait ~60s for startup, then validate the endpoint returns all required fields:
```bash
curl -s http://localhost:8080/health | jq '{
  status: .status,
  nodeId: .nodeId,
  workerId: .workerId,
  processedJobs: .processedJobs,
  heapUsedMB: .memory.heapUsedMB,
  heapTotalMB: .memory.heapTotalMB,
  rssMB: .memory.rssMB,
  idlePercent: .efficiency.idlePercent
}'
```

**Required assertions** (fail the test if any are false):
- `.status` equals `"ok"`
- `.memory.heapUsedMB` is a number > 0
- `.memory.heapTotalMB` is a number > 0 and <= 2200 (heap cap is 2048MB, allow overhead)
- `.memory.rssMB` is a number > 0
- `.nodeId` is a non-empty string

Clean up:
```bash
docker stop jinn-e2e-healthcheck && docker rm jinn-e2e-healthcheck
```

## Verify Tool Use

**WARNING: Do NOT run Docker again or dispatch a new job for this step.** Telemetry files from the `--single` run above are already on the host at `/tmp/jinn-telemetry/`. Just parse them.

Find the telemetry file and parse it:
```bash
TFILE=$(ls -t /tmp/jinn-telemetry/telemetry-*.json 2>/dev/null | head -1)
echo "Telemetry file: $TFILE"
python3 -c "
import json
content = open('$TFILE').read()
events, buf, started, brace_count, in_string, escape_next = [], '', False, 0, False, False
for ch in content:
    if not started:
        if ch == '{':
            started, brace_count, buf, in_string, escape_next = True, 1, '{', False, False
        continue
    buf += ch
    if escape_next: escape_next = False
    elif ch == '\\\\' and in_string: escape_next = True
    elif ch == '\"': in_string = not in_string
    elif not in_string:
        if ch == '{': brace_count += 1
        elif ch == '}': brace_count -= 1
    if started and brace_count == 0:
        try: events.append(json.loads(buf))
        except: pass
        started, buf, in_string, escape_next = False, '', False, False
for evt in events:
    attrs = evt.get('attributes', {})
    if attrs.get('event.name') == 'gemini_cli.config':
        print(f\"core_tools_enabled: {attrs.get('core_tools_enabled', '')}\")
tools = []
for evt in events:
    attrs = evt.get('attributes', {})
    if attrs.get('event.name') in ('gemini_cli.tool_call', 'gemini_cli.function_call'):
        name = attrs.get('function_name') or attrs.get('tool_name') or 'unknown'
        tools.append(name)
        print(f\"Tool call: {name} (success={attrs.get('success','?')}, {attrs.get('duration_ms','?')}ms)\")
if not tools:
    print('ERROR: No tool calls found in telemetry')
else:
    print(f'Total tool calls: {len(tools)}')
    for req in ['google_web_search', 'create_artifact']:
        print(f\"  [{'PASS' if req in tools else 'FAIL'}] {req}\")
"
```

## Expected Flow

1. **Build** — Docker image compiles TypeScript, installs Chromium + Gemini CLI
2. **Poll** — Containerized worker queries Ponder, finds 1 undelivered request
3. **Claim** — Worker claims the job via Control API
4. **Execute** — Spawns Gemini CLI agent with MCP tools (uses pre-installed CLI)
5. **Tool use** — Agent calls `google_web_search` and `create_artifact`
6. **Upload** — Result uploaded to IPFS
7. **Deliver** — On-chain delivery via Safe transaction

## Debugging Sources

Always report these paths at session end for investigation:

- **Docker worker output**: stdout from `yarn test:e2e:docker-run`
- **Telemetry file**: `/tmp/jinn-telemetry/telemetry-*.json` (always available)
- **Docker logs**: `docker logs jinn-e2e-worker` (if container still running)
- **Ponder logs**: Background stack output (task output file)
- **Clone directory**: `$CLONE_DIR` — contains `.env`, `.operate/`, service config
- **VNet config**: `.env.e2e` — VNet RPC URL and session state

## Acceptable Failures

- **Delivery fails with 403 (quota exhausted)**: OK — the key validation is Docker execution with tool use + IPFS upload.
- **Chromium sandbox warning**: Expected — `GEMINI_SANDBOX=false` disables macOS sandbox (unavailable in Linux containers).

## Success Criteria

- [ ] Docker image builds successfully
- [ ] Container starts without crash
- [ ] Worker found and claimed the dispatched request
- [ ] Agent called `google_web_search` at least once
- [ ] Agent called `create_artifact` at least once
- [ ] Result was uploaded to IPFS
- [ ] On-chain delivery attempted (success or quota error)
- [ ] Healthcheck returns `status: "ok"` with valid memory metrics
- [ ] Heap total is within cap (`heapTotalMB <= 2200`)
