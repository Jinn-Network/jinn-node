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
| Worker cannot reach Ponder | Check `services.ponder_url` in jinn.yaml (env: `PONDER_GRAPHQL_URL`) |
| Worker cannot reach Control API | Check `services.control_api_url` in jinn.yaml (env: `CONTROL_API_URL`) |
| Git task failures | Set `GITHUB_TOKEN` and git author vars |

## stOLAS-specific failures

| Symptom | Fix |
|---|---|
| `stOLAS distributor not configured for Jinn staking` | ExternalStakingDistributor not configured. Use standard setup (`yarn setup`) or contact Jinn team |
| `All N staking slots are occupied` | Staking contract is full. Wait for slots or use standard setup (`yarn setup`) |
| `Master EOA has insufficient ETH: X ETH. Need at least 0.001` | Fund Master EOA with >= 0.002 ETH on Base (gas for Safe transaction) |
| `Master Safe needs ETH for mech deployment` | Fund Master Safe with >= 0.007 ETH, then rerun or run `npx tsx scripts/deploy-mech.ts --service-config-id=<id>` |
| `stake() succeeded but no new service ID found` | Rare — check chain for the tx receipt, service may have been created under a different ID |
| `Service created but agent key storage failed` | Disk permission issue in `.operate/keys/`. Fix permissions and reimport |
| `Pre-flight simulation failed (inner call would revert)` | MechMarketplace.create() would fail. Check service registration and mech factory |
| `Safe execTransaction failed` / `Safe execTransaction reverted` | Check Master Safe nonce, ensure Master EOA is a signer on the Safe |
| `--testnet` flag but balance shows mainnet values | Known issue: `secrets.rpcUrl` captured at import time. Pass `RPC_URL=<vnet-url>` as env var prefix instead |
