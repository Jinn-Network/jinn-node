# Railway Variables

Use this file when setting Railway environment variables for `jinn-node`.

## Required

| Variable | Notes |
|---|---|
| `RPC_URL` | Base RPC endpoint |
| `CHAIN_ID` | `8453` for Base mainnet |
| `OPERATE_PASSWORD` | Must decrypt `.operate` keystore |
| `PONDER_GRAPHQL_URL` | Shared Ponder GraphQL endpoint |
| `CONTROL_API_URL` | Shared Control API GraphQL endpoint |
| `X402_GATEWAY_URL` | Canary gateway URL for canary rollout, prod URL after promotion |

## Strongly Recommended

| Variable | Notes |
|---|---|
| `GITHUB_TOKEN` | Needed for most code-task workflows |
| `GIT_AUTHOR_NAME` | Commit author identity |
| `GIT_AUTHOR_EMAIL` | Commit author identity |
| `WORKSTREAM_FILTER` | Restrict worker to canary workstream during rollout |
| `WORKER_ID` | Distinct worker ID for logs/observability |
| `WORKER_MULTI_SERVICE` | Set `true` when `.operate/services` has multiple services |

## Optional

| Variable | Notes |
|---|---|
| `GEMINI_API_KEY` | If not using persisted Gemini CLI OAuth files |
| `WORKER_COUNT` | Parallel worker processes in one container |
| `WORKER_STUCK_EXIT_CYCLES` | Auto-exit safety watchdog |
| `WORKER_JOB_DELAY_MS` | Delay between job cycles |

## Canary -> Prod gateway switch

Only change:

```bash
railway variables set X402_GATEWAY_URL="https://<prod-gateway-domain>"
railway up
```
