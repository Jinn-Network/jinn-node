# Setup Failures

## Prerequisite failures

| Symptom | Fix |
|---|---|
| `poetry: command not found` | `curl -sSL https://install.python-poetry.org | python3` then restart shell |
| `tendermint: command not found` | Install Tendermint v0.34.x binary |
| Python 3.12 resolver issues | Use Python 3.11 (`poetry env use python3.11`) |

## Setup failures

| Symptom | Fix |
|---|---|
| `OPERATE_PASSWORD not set` | Add to `.env` and rerun |
| `RPC_URL not set` | Add to `.env` and rerun |
| `Missing required LLM authentication` | Set `GEMINI_API_KEY` or run `npx @google/gemini-cli auth login` |
| `Funding required before safe creation` | Fund Master EOA and rerun |
| `Funding required before deployment` | Fund Master Safe (ETH + OLAS) and rerun |
| `.operate directory not found` warnings on first run | Usually non-fatal bootstrap noise |

## Runtime failures after setup

| Symptom | Fix |
|---|---|
| Worker cannot reach Ponder | Verify `PONDER_GRAPHQL_URL` |
| Worker cannot reach Control API | Verify `CONTROL_API_URL` |
| Git task failures | Set `GITHUB_TOKEN` and git author vars |
