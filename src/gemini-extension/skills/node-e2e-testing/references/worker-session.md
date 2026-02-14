# Worker Session

Tests: Setup → Dispatch (with blueprint + tools) → Worker claim → Agent execution with tool use → IPFS upload → On-chain delivery.

**Prerequisite**: Complete the shared steps (Infrastructure + Setup) from SKILL.md first.

## Dispatch a Job

The dispatch script sends a job that **requires tool use** (web search + artifact creation). The IPFS metadata includes a `blueprint` with invariants and `enabledTools` so the agent knows which tools to call.

From the monorepo root:
```bash
yarn test:e2e:dispatch \
  --workstream 0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac \
  --cwd "$CLONE_DIR"
```

Default behavior:
- **Blueprint**: Three invariants — GOAL-001 (research OLAS price), TOOL-001 (must use google_web_search), TOOL-002 (must use create_artifact)
- **Enabled tools**: `google_web_search`, `web_fetch`, `create_artifact`
- **IPFS path**: Uses `buildIpfsPayload()` + `marketplaceInteract()` — same as production

**CRITICAL**: The worker reads ONLY `metadata.blueprint` — there is no `prompt` field. The actual task must be described in the blueprint's GOAL invariants. Tool-validation invariants (TOOL-001, etc.) are secondary.

To use a custom blueprint:
```bash
yarn test:e2e:dispatch \
  --workstream <id> --cwd "$CLONE_DIR" \
  --blueprint '{"invariants":[{"id":"GOAL-001","type":"BOOLEAN","condition":"Your task description here","assessment":"How to verify"}]}' \
  --enabled-tools "google_web_search,web_fetch,create_artifact"
```

## Fund the Agent EOA

The agent EOA needs ETH for gas to claim and deliver. Get the address from the setup output, then:
```bash
yarn test:e2e:vnet fund <agent-eoa-address> --eth 0.01
```

## Run the Worker

Wait a few seconds for Ponder to index the marketplace request, then:
```bash
cd "$CLONE_DIR" && yarn worker --single
```

## Verify Tool Use

After the worker completes, inspect the **telemetry file** for definitive evidence of tool invocation. The worker logs the telemetry path early in execution:

```
Will write telemetry to file: /var/folders/.../telemetry-<timestamp>-<id>.json
```

### Telemetry file format

The telemetry file contains **concatenated JSON objects** (not a JSON array). Each object is a complete OpenTelemetry event. You must use a streaming brace-counting parser — `json.JSONDecoder().raw_decode()` does NOT work reliably with this format.

**Streaming parser** (use this for all telemetry parsing):

```python
def parse_telemetry(filepath):
    """Parse concatenated JSON objects from Gemini CLI telemetry file."""
    content = open(filepath).read()
    events = []
    buf = ''
    started = False
    brace_count = 0
    in_string = False
    escape_next = False
    for ch in content:
        if not started:
            if ch == '{':
                started = True
                brace_count = 1
                buf = '{'
                in_string = False
                escape_next = False
            continue
        buf += ch
        if escape_next:
            escape_next = False
        elif ch == '\\' and in_string:
            escape_next = True
        elif ch == '"':
            in_string = not in_string
        elif not in_string:
            if ch == '{': brace_count += 1
            elif ch == '}': brace_count -= 1
        if started and brace_count == 0:
            try:
                import json
                events.append(json.loads(buf))
            except:
                pass
            started = False
            buf = ''
            in_string = False
            escape_next = False
    return events
```

### Event types in the telemetry file

| Event name | What it contains |
|------------|-----------------|
| `gemini_cli.config` | `core_tools_enabled`, `model`, `sandbox_enabled` |
| `gemini_cli.startup_stats` | CLI startup timing |
| `gemini_cli.user_prompt` | `prompt`, `prompt_length` |
| `gemini_cli.model_routing` | Model routing decision |
| `gemini_cli.api_request` | `model`, `request_text` (full conversation JSON) |
| `gemini_cli.api_response` | `input_token_count`, `output_token_count`, `duration_ms` |
| `gemini_cli.tool_call` | `function_name`, `function_args`, `duration_ms`, `success` |
| `gen_ai.client.inference.operation.details` | `gen_ai.output.messages`, system instructions |

Events live under `event.attributes['event.name']`. Tool calls have `function_name` (not `tool_name`).

### Step 1: Parse telemetry and check tool configuration

```bash
python3 << 'PYEOF'
import json, sys

TELEMETRY_FILE = "TELEMETRY_FILE_PATH"  # Replace with actual path from worker log

content = open(TELEMETRY_FILE).read()
events, buf, started, brace_count, in_string, escape_next = [], '', False, 0, False, False
for ch in content:
    if not started:
        if ch == '{':
            started, brace_count, buf, in_string, escape_next = True, 1, '{', False, False
        continue
    buf += ch
    if escape_next: escape_next = False
    elif ch == '\\' and in_string: escape_next = True
    elif ch == '"': in_string = not in_string
    elif not in_string:
        if ch == '{': brace_count += 1
        elif ch == '}': brace_count -= 1
    if started and brace_count == 0:
        try: events.append(json.loads(buf))
        except: pass
        started, buf, in_string, escape_next = False, '', False, False

# Check config
for evt in events:
    attrs = evt.get('attributes', {})
    if attrs.get('event.name') == 'gemini_cli.config':
        core = attrs.get('core_tools_enabled', '')
        print(f'core_tools_enabled: {core}')
        if not core:
            print('ERROR: Native tools not configured')
        break

# Check tool calls
tools = []
for evt in events:
    attrs = evt.get('attributes', {})
    if attrs.get('event.name') in ('gemini_cli.tool_call', 'gemini_cli.function_call'):
        name = attrs.get('function_name') or attrs.get('tool_name') or 'unknown'
        success = attrs.get('success', '?')
        duration = attrs.get('duration_ms', '?')
        args_str = str(attrs.get('function_args', ''))[:120]
        tools.append(name)
        print(f'Tool call: {name} (success={success}, {duration}ms)')
        print(f'  args: {args_str}')

if not tools:
    print('\nERROR: No tool calls found in telemetry')
else:
    print(f'\nTotal tool calls: {len(tools)}')
    for required in ['google_web_search', 'create_artifact']:
        status = 'PASS' if required in tools else 'FAIL'
        print(f'  [{status}] {required}')

# Token usage
for evt in events:
    attrs = evt.get('attributes', {})
    if attrs.get('event.name') == 'gemini_cli.api_response':
        inp = attrs.get('input_token_count', 0)
        out = attrs.get('output_token_count', 0)
        if inp or out:
            print(f'\nTokens: input={inp}, output={out}')

# Event summary
from collections import Counter
counts = Counter(evt.get('attributes', {}).get('event.name', 'unknown') for evt in events)
print(f'\nEvent types: {dict(counts)}')
PYEOF
```

### Step 2: Cross-check with worker output

Also check the worker stdout for tool evidence:
- `google_web_search` — agent searched the web
- `create_artifact` — agent created an artifact with results
- `create_measurement` — agent measured GOAL-001 invariant
- `web_fetch` — agent fetched a URL

**If the agent answers without using tools**, the E2E test has failed. Check `core_tools_enabled` first — if empty, the tools were never available to the agent.

## Expected Flow

1. **Poll** — Worker queries Ponder, finds 1 undelivered request
2. **Claim** — Worker claims the job via Control API
3. **Fetch metadata** — Worker reads IPFS payload including blueprint + enabledTools
4. **Execute** — Spawns Gemini CLI agent with MCP tools configured per enabledTools
5. **Tool use** — Agent calls `google_web_search` and `create_artifact` (at minimum)
6. **Upload** — Result uploaded to IPFS
7. **Deliver** — On-chain delivery via Safe transaction

## Acceptable Failures

- **Delivery fails with 403 (quota exhausted)**: OK — the key validation is agent execution with tool use + IPFS upload.
- **AEA deployment failed during setup**: Expected — CLI version mismatch. Worker uses its own execution path.
- **Web search returns no results**: Possible on VNet if external network is restricted. The important thing is the tool was *called*.

## Success Criteria

- [ ] Worker found and claimed the dispatched request
- [ ] IPFS metadata included `blueprint` and `enabledTools`
- [ ] Agent called `google_web_search` at least once
- [ ] Agent called `create_artifact` at least once
- [ ] Result was uploaded to IPFS
- [ ] On-chain delivery attempted (success or quota error)
