# Operator Session

Tests: Setup → Service management scripts → Add 2nd service → Multi-service validation → Rotation initialization with 2 services.

**Prerequisite**: Complete the shared steps (Infrastructure + Setup) from SKILL.md first. Do NOT dispatch a job or run the worker for job execution — this session conserves VNet quota for service provisioning.

**Quota budget**: First service setup uses ~3-4 write transactions. Adding a 2nd service uses ~5-6 more (mint, activate, register agents, deploy Safe, approve NFT, stake). Total: ~8-10 writes, which is at the VNet free-tier limit.

## Validate Single-Service Scripts

After setup, verify operator scripts work with the initial service:

```bash
cd "$CLONE_DIR" && yarn service:list
```

Expected: Shows 1 service with config ID, service ID, safe address, staking contract, and on-chain activity status.

```bash
cd "$CLONE_DIR" && yarn service:status
```

Expected: Shows epoch info, per-service eligibility, staking health (slots, APY, deposit), and wallet balances.

```bash
cd "$CLONE_DIR" && yarn rewards:summary
```

Expected: Shows total accrued rewards (`0.0000 OLAS` for fresh service), per-service breakdown, contract details, and health summary.

All three must exit 0.

## Add a Second Service

```bash
cd "$CLONE_DIR" && yarn service:add
```

The script will:
1. Detect the existing service and auto-inherit its staking contract
2. Create a new service config via the middleware API
3. Show funding requirements for the new service

Fund the new service from the monorepo root:
```bash
yarn test:e2e:vnet fund <new-service-safe-address> --eth <amount> --olas <amount>
```

Then re-run to continue deployment:
```bash
cd "$CLONE_DIR" && yarn service:add
```

Repeat the fund + re-run cycle until the service is fully deployed and staked.

**If quota is exhausted**: The key validation is steps 1-3 (preflight + config creation + funding requirements display). Full on-chain staking is a bonus. Note how far the flow got in your report.

## Validate Multi-Service Scripts

After the 2nd service is provisioned (or as far as it got):

```bash
cd "$CLONE_DIR" && yarn service:list
```

Expected: Shows **2 services** with distinct config IDs, service IDs, and safe addresses. Both should show on-chain activity status.

```bash
cd "$CLONE_DIR" && yarn service:status
```

Expected: Dashboard shows **both services** under the "Services" section with individual eligibility status.

```bash
cd "$CLONE_DIR" && yarn rewards:summary
```

Expected: Per-service breakdown shows **both services** with individual accrued rewards.

## Verify Rotation Initialization

Test that the worker initializes multi-service rotation with 2 services. The `--single` flag makes the worker exit after one poll cycle:

```bash
cd "$CLONE_DIR" && WORKER_MULTI_SERVICE=true yarn worker --single 2>&1
```

Look for in the output:
- `Multi-service rotation active` — confirms `ServiceRotator` initialized
- `activeService` — which service was selected as initial active
- `reason` — should indicate "most requests needed" or similar selection logic
- No crash or error from rotation initialization

The rotator should pick the service with more `requestsNeeded` since both are freshly staked.

## Debugging Sources

Always report these paths at session end for investigation:

- **Script output**: stdout from each operator command
- **Middleware logs**: `$CLONE_DIR/.operate/` — middleware daemon output
- **Service configs**: `$CLONE_DIR/.operate/services/` — all service config directories
- **Ponder logs**: Background stack output (task output file)
- **Clone directory**: `$CLONE_DIR` — contains `.env`, `.operate/`, service configs
- **VNet config**: `.env.e2e` — VNet RPC URL and session state
- **VNet quota**: `yarn test:e2e:vnet status` — check remaining write quota

## Acceptable Failures

- **`service:add` fails after config creation due to VNet quota** — the preflight and config creation are the key validations. Full staking requires many writes.
- **Worker times out after 30s** — expected, we just want to see rotation initialization.
- **Rewards show `0.0000 OLAS`** — expected for freshly staked services.
- **`service:status` shows 1 service** if `service:add` didn't complete — still validates the dashboard works.

## Success Criteria

- [ ] `service:list` showed 1 service after initial setup
- [ ] `service:status` displayed epoch and staking data for 1 service
- [ ] `rewards:summary` displayed contract details and health summary
- [ ] `service:add` ran preflight checks (detected existing service, inherited staking contract)
- [ ] `service:add` created new service config (or reached quota limit trying)
- [ ] `service:list` showed 2 services after adding 2nd service (if provisioning completed)
- [ ] `service:status` displayed data for both services (if provisioning completed)
- [ ] Worker initialized rotation with 2 services (logged "Multi-service rotation active")
