# Railway Variables

Use this file when setting Railway environment variables for `jinn-node`.

**No third-party API keys needed.** Credentials for tools (Twitter, Umami, Supabase, etc.) are served at runtime by the credential bridge (`X402_GATEWAY_URL`). Workers only need on-chain keys (in `.operate/`) and the variables below.

**Important:** When setting multiple variables, use `--skip-deploys` on each call to avoid triggering a redundant redeployment per variable. Deploy explicitly after all variables are configured.

```bash
railway variables --set "KEY=value" --skip-deploys
```

## Required

| Variable | Notes |
|---|---|
| `RPC_URL` | Base RPC endpoint |
| `CHAIN_ID` | `8453` for Base mainnet |
| `OPERATE_PASSWORD` | Must decrypt `.operate` keystore |
| `PONDER_GRAPHQL_URL` | Shared Ponder GraphQL endpoint |
| `CONTROL_API_URL` | Shared Control API GraphQL endpoint (ERC-8128 signed auth) |
| `X402_GATEWAY_URL` | Credential bridge URL — serves third-party credentials at runtime |
| `STAKING_CONTRACT` | Staking contract address (used by activity monitor) |

## Mech Filtering (required for multi-operator)

| Variable | Notes |
|---|---|
| `WORKER_MECH_FILTER_MODE` | `staking` for production — matches all mechs staked in contract |
| `WORKER_STAKING_CONTRACT` | Address of the staking contract to scan for mechs |
| `WORKER_MULTI_SERVICE` | Set `true` when `.operate/services` has multiple services |

## Strongly Recommended

| Variable | Notes |
|---|---|
| `GITHUB_TOKEN` | Needed for most code-task workflows |
| `GIT_AUTHOR_NAME` | Commit author identity |
| `GIT_AUTHOR_EMAIL` | Commit author identity |
| `WORKSTREAM_FILTER` | Restrict worker to a specific workstream |
| `WORKER_ID` | Distinct worker ID for logs/observability |

## Optional

| Variable | Notes |
|---|---|
| `GEMINI_API_KEY` | If not using persisted Gemini CLI OAuth files |
| `WORKER_COUNT` | Parallel worker processes in one container |
| `WORKER_STUCK_EXIT_CYCLES` | Auto-exit safety watchdog |
| `WORKER_JOB_DELAY_MS` | Delay between job cycles |
| `HEALTHCHECK_PORT` | Override healthcheck port (takes priority over Railway's `PORT`) |
| `EARNING_SCHEDULE` | Time window for job claiming, e.g. `22:00-08:00` (unset = always) |
| `EARNING_MAX_JOBS` | Max jobs per earning window (unset = unlimited) |
| `AUTO_RESTAKE` | Set `false` to disable auto-restake of evicted services at startup (default: enabled) |

**Note:** Railway auto-sets the `PORT` environment variable. The worker reads `HEALTHCHECK_PORT` > `PORT` > `8080` (default). Do not set `PORT` manually.

## Canary -> Prod gateway switch

Only change:

```bash
railway variables --set "X402_GATEWAY_URL=https://<prod-gateway-domain>"
railway up --detach
```
