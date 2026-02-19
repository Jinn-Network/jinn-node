# Troubleshooting Matrix

## Prerequisites

| Symptom | Cause | Fix |
|---|---|---|
| `poetry: command not found` | Poetry missing | `curl -sSL https://install.python-poetry.org | python3` then restart shell |
| `tendermint: command not found` | Tendermint missing | Install Tendermint v0.34.x binary |
| `poetry install` resolver errors | Wrong Python version | Use Python 3.10/3.11 (`poetry env use python3.11`) |
| `Cannot import operate module` | Middleware deps missing | `cd jinn-node && poetry install --sync` |

## Setup failures

| Symptom | Cause | Fix |
|---|---|---|
| `OPERATE_PASSWORD not set` | Missing env | Add to `.env` |
| `RPC_URL not set` | Missing env | Add to `.env` |
| `Missing required LLM authentication` | No Gemini auth | Set `GEMINI_API_KEY` or run `npx @google/gemini-cli auth login` |
| `Funding required before safe creation` | Expected setup checkpoint | Fund Master EOA and rerun `yarn setup` |
| `Funding required before deployment` | Expected setup checkpoint | Fund Master Safe (ETH + OLAS) and rerun `yarn setup` |
| `Wallet creation failed` | Middleware/runtime issue | Re-check prerequisites + env + retry |

## Runtime failures

| Symptom | Cause | Fix |
|---|---|---|
| Worker cannot reach Ponder | Wrong or unavailable endpoint | Verify `PONDER_GRAPHQL_URL` |
| Worker cannot reach Control API | Wrong or unavailable endpoint | Verify `CONTROL_API_URL` |
| Credentialed tools fail | Wrong gateway URL or ACL missing | Verify `X402_GATEWAY_URL`, gateway health, ACL grants |
| Git task failures | Missing credentials | Set `GITHUB_TOKEN`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` |

## Railway failures

| Symptom | Cause | Fix |
|---|---|---|
| Keystore decryption failure | Wrong `OPERATE_PASSWORD` | Match local password used for `.operate` |
| `.operate` not found in runtime | Volume/import issue | Verify volume mount `/home/jinn` and import `/home/jinn/.operate` |
| Worker boot loops | Missing required env | Check required vars and `railway logs --tail 300` |
