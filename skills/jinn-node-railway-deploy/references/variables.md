# Railway Variables

Use this file when setting Railway environment variables for `jinn-node`.

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
| `HEALTHCHECK_PORT` | Override healthcheck port (takes priority over Railway's `PORT`) |

**Note:** Railway auto-sets the `PORT` environment variable. The worker reads `HEALTHCHECK_PORT` > `PORT` > `8080` (default). Do not set `PORT` manually.

## Canary -> Prod gateway switch

Only change:

```bash
railway variables --set "X402_GATEWAY_URL=https://<prod-gateway-domain>"
railway up --detach
```
