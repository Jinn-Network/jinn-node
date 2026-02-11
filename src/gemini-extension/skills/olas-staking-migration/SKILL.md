---
name: olas-staking-migration
description: Migrate an OLAS service between staking contracts (e.g., AgentsFun1 -> Jinn). Handles evicted services, bond top-ups, and preflight checks.
allowed-tools: Bash, Read, Edit, Write, Glob, Grep
---

# OLAS Staking Migration

Migrate a service NFT from one OLAS staking contract to another on Base.

## Recommended: Use the Middleware HTTP API

The **olas-operate-middleware** daemon handles the full migration flow. This is how the
official olas-operate-app does it. Two API calls:

```bash
# 1. Start daemon
cd olas-operate-middleware && poetry run operate daemon --port=8700

# 2. Login
curl -X POST http://localhost:8700/api/account/login \
  -H 'Content-Type: application/json' -d '{"password":"<OPERATE_PASSWORD>"}'

# 3. Update service config to point to new staking contract
curl -X PATCH http://localhost:8700/api/v2/service/<service_config_id> \
  -H 'Content-Type: application/json; charset=UTF-8' \
  -d '{"configurations": {"base": {"staking_program_id": "<target_address>"}}}'

# 4. Deploy (triggers full on-chain flow: terminate -> re-register -> activate -> register -> deploy -> stake)
curl -X POST http://localhost:8700/api/v2/service/<service_config_id> \
  -H 'Content-Type: application/json; charset=UTF-8'
```

The middleware handles everything: unstaking, terminating, re-registering with new bond,
activating, registering agents, deploying multisig, and staking in the new contract.

**Note:** The POST endpoint also calls `deploy_service_locally` (Docker), which may fail
if Docker is not running. The on-chain operations run first, so if Docker fails, the
on-chain state will still be correct.

## Key Concepts

### Service States (on-chain)
| State | Value | Meaning |
|-------|-------|---------|
| NON_EXISTENT | 0 | Not registered |
| PRE_REGISTRATION | 1 | Registered, not yet activated |
| ACTIVE_REGISTRATION | 2 | Activated, agents can register |
| FINISHED_REGISTRATION | 3 | All agents registered |
| DEPLOYED | 4 | Multisig deployed, ready to stake |
| TERMINATED_BONDED | 5 | Terminated, bond held |

### Staking States
- **Actively staked**: NFT owned by staking contract, service ID in `getServiceIds()` list
- **Evicted**: NFT owned by staking contract but NOT in `getServiceIds()` list. `unstake()` still works.
- **Unstaked**: NFT owned by the service owner (Master Safe). Ready to stake elsewhere.

### Staking Contracts on Base

| Name | Address | Min Stake |
|------|---------|-----------|
| AgentsFun1 | `0x2585e63df7BD9De8e058884D496658a030b5c6ce` | 50 OLAS |
| Jinn | `0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139` | 5,000 OLAS |

### Core OLAS Contracts on Base

| Contract | Address |
|----------|---------|
| ServiceRegistry | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` |
| ServiceRegistryTokenUtility | `0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5` |
| ServiceManagerToken (CORRECT) | `0x1262136cac6a06A782DC94eb3a3dF0b4d09FF6A6` |
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` |

### Our Addresses

| Address | Value |
|---------|-------|
| Master EOA | `0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2` |
| Master Safe (Operate) | `0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645` |
| Venture Safe (AMP2) | `0x900Db2954a6c14C011dBeBE474e3397e58AE5421` |
| Agent Key | `0x62fb5FC6ab3206b3C817b503260B90075233f7dD` |
| Service Safe (multisig) | `0xb8B7A89760A4430C3f69eeE7Ba5D2B985D593D92` |
| Service ID | 165 |
| Service Config ID | `sc-b3aaf73c-78fe-4b28-98ef-6cf8730d04a1` |

## Migration Flow (Middleware Internal)

When the middleware's `_deploy_service_onchain_from_safe` detects `is_update=True`
(bond mismatch between current and target staking contract), it runs:

```
1. Terminate (if staked: unstake first)
   - DEPLOYED → TERMINATED_BONDED (returns security deposit in OLAS)
   - TERMINATED_BONDED → PRE_REGISTRATION (unbond, returns agent bond in OLAS)

2. Safe Owner Swap
   - Enable recovery module if needed
   - Swap safe owners back to agent addresses

3. Update Service (re-register with new bond)
   - Calls ServiceManagerToken.update() with cost_of_bond = target min_staking_deposit
   - PRE_REGISTRATION stays PRE_REGISTRATION (but bond amount is updated)

4. Activate Registration
   - Approves OLAS to ServiceRegistryTokenUtility (security deposit)
   - Calls activateRegistration (costs 1 wei native + security deposit in OLAS)
   - PRE_REGISTRATION → ACTIVE_REGISTRATION

5. Register Agent Instances
   - Approves OLAS to ServiceRegistryTokenUtility (agent bond)
   - Calls registerAgents (costs 1 wei native + agent bond in OLAS)
   - ACTIVE_REGISTRATION → FINISHED_REGISTRATION

6. Deploy Multisig
   - FINISHED_REGISTRATION → DEPLOYED

7. Stake in Target
   - Approve NFT transfer to staking contract
   - Call stake(serviceId) on target
   - NFT transfers to staking contract
```

## OLAS Funding Requirements

**CRITICAL**: The total OLAS needed is **2x the min_staking_deposit** per agent:

| Item | Amount | When Paid |
|------|--------|-----------|
| Security Deposit | 1 × min_staking_deposit | During activation (step 4) |
| Agent Bond | 1 × min_staking_deposit per agent | During registration (step 5) |
| **Total (1 agent)** | **2 × min_staking_deposit** | |

For Jinn (5,000 OLAS min): **10,000 OLAS total** needed in the Master Safe.

Both deposits are returned when the service is terminated and unbonded.

The Master Safe also needs ETH for gas (~0.02 ETH should be sufficient for the full flow).

## Environment Requirements

- `OPERATE_PASSWORD` - Decrypts master wallet keystore at `olas-operate-middleware/.operate/wallets/ethereum.txt`
- `RPC_URL` - Base RPC endpoint (defaults to `https://mainnet.base.org`)
- Service config at `olas-operate-middleware/.operate/services/<config_id>/config.json`

## Troubleshooting

### Wrong ServiceManagerToken in autonomy library (CRITICAL)

**Issue:** All service management operations (terminate, register, activate, deploy) fail
with `ManagerOnly` error or `intrinsic gas too low: gas 0`.

**Root Cause:** The `open-autonomy` library's `CHAIN_PROFILES` has the wrong
`service_manager_token` address for Base. The on-chain `ServiceRegistry.manager()` returns
`0x1262136cac6a06A782DC94eb3a3dF0b4d09FF6A6`, but the autonomy profile has
`0x63e66d7ad413C01A7b49C7FF4e3Bb765C4E4bd1b`.

**Solution:** Patched in `operate/ledger/profiles.py`:
```python
if Chain.BASE in CONTRACTS:
    CONTRACTS[Chain.BASE]["service_manager"] = "0x1262136cac6a06A782DC94eb3a3dF0b4d09FF6A6"
```

**Detection:** The error manifests as "intrinsic gas too low: gas 0" because the autonomy
library's gas estimation calls `eth_estimateGas` on the Safe's `execTransaction`, which
simulates the inner call to the wrong ServiceManagerToken. The inner call reverts with
`ManagerOnly`, causing gas estimation to fail, falling back to `gas=0`.

**Verification:** Check with `ServiceRegistry.manager()`:
```javascript
const reg = new ethers.Contract('0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE',
  ['function manager() view returns (address)'], provider);
const manager = await reg.manager(); // Should match what middleware uses
```

### Staking program ID not in STAKING dict

**Issue:** Jinn (`0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139`) is not listed in the
middleware's `STAKING[Chain.BASE]` dict.

**Non-issue:** `get_staking_contract()` falls back to using the raw address:
```python
return STAKING[Chain(chain)].get(staking_program_id, staking_program_id)
```

### Gas 0 / intrinsic gas too low

**Issue:** Middleware operations fail with `intrinsic gas too low: gas 0`.

**Root Cause:** The autonomy `get_raw_safe_transaction` function passes `fallback_gas=0` by
default. When `eth_estimateGas` fails (because the inner call would revert), the transaction
is constructed with `gas=0`.

**Diagnosis:** If gas estimation fails, the REAL issue is that the inner Safe transaction
would revert. Check the middleware logs for:
```
WARNING: Unable to retrieve gas estimate: ('execution reverted', '0x...')
```
Decode the revert data to find the actual error (e.g., `ManagerOnly`, `GS013`, etc.).

### GS013 (Safe inner transaction reverted)

**Issue:** Safe's `execTransaction` succeeds but the inner call reverts.

**Common causes:**
1. Wrong contract address (e.g., wrong ServiceManagerToken)
2. Insufficient token balance (OLAS) for bond/deposit
3. Wrong service state for the operation being attempted
4. Agent already registered, or trying to register with wrong agent ID

### Insufficient OLAS for bond top-up

**Issue:** `registerAgents` fails because the Safe doesn't have enough OLAS.

**Root Cause:** Increasing the bond from a lower amount (e.g., 50 → 5000 OLAS) requires
**2x the new bond amount**: security deposit + agent bond. Both are paid in OLAS via the
ServiceRegistryTokenUtility.

**Solution:** Ensure the Master Safe has at least `2 × min_staking_deposit` OLAS before
starting the migration.

### Direct EOA signing fails — must use Safe

**Issue:** Calling `unstake()` or `stake()` directly from the Master EOA fails with a
custom error containing two addresses (the EOA and the Safe).

**Root Cause:** Staking operations must be executed FROM the Safe that originally staked
the service. The staking contract checks `msg.sender` against the recorded service owner.

**Solution:** Route all write operations through the Safe using the middleware (preferred)
or `@safe-global/protocol-kit`.

### mapServiceInfo reverts

Some staking contract versions have a `mapServiceInfo` that reverts for certain service IDs.
This is non-blocking — the function is only used for logging, not for the actual migration flow.

### Service not found in getServiceIds

If the NFT is owned by the staking contract but the service ID is not in `getServiceIds()`,
the service is **evicted**. `unstake()` still works.

### "Position out of bounds" errors

This is a viem ABI decoding issue with `mapServiceInfo` on AgentsFun1. The actual return
data layout may differ from the declared ABI. Use JSON ABI format (not `parseAbi`) and
wrap calls in try/catch.

### Bond amount decoding returns unrealistic values

`mapServiceIdTokenDeposit` on Base's ServiceRegistryTokenUtility may return garbled values
for staked/evicted services. The migration script detects values > 1B OLAS and defers bond
comparison to after unstaking.

### RPC endpoint in service config

**Issue:** The service config may use a public RPC (e.g., `base.publicnode.com`) that has
gas estimation issues or rate limits.

**Solution:** Update the RPC in the service config to a reliable endpoint:
```json
"ledger_config": {
  "rpc": "https://your-reliable-rpc-endpoint",
  "chain": "base"
}
```

### .env not loading (0 vars)

The `import 'jinn-node/env'` module finds `jinn-node/` as repo root, loading the wrong
`.env`. The migration script pre-loads the root `.env` via explicit `dotenv.config()`.

### is_update=True infinite loop (staking_token mismatch)

**Issue:** Middleware detects `is_update=True` on every run, causing an infinite
terminate → re-register → fail cycle.

**Root Cause:** When `current_staking_program=None` (service is unstaked), `get_staking_params`
returns fallback values with `staking_token=ZERO_ADDRESS`. The target staking params have
the real OLAS token address. The staking_token comparison at line ~832 always differs.

**Solution:** Patched `manage.py` to skip the staking_token comparison when
`current_staking_program is None`:
```python
or (
    current_staking_program is not None
    and current_staking_params["staking_token"]
    != target_staking_params["staking_token"]
)
```

### NoRewardsAvailable — staking contract needs reward deposit

**Issue:** `stake(serviceId)` reverts with `NoRewardsAvailable()` (selector `0xafb0be33`).

**Root Cause:** The staking contract enforces on-chain that `availableRewards > 0` before
accepting new stakers. A new staking contract has 0 OLAS until rewards are deposited.

**Solution:** Deposit OLAS rewards into the staking contract before staking:
```typescript
// 1. approve(stakingContract, amount) on OLAS token
// 2. deposit(amount) on staking contract (permissionless)
```
The `deposit(uint256)` function is permissionless — anyone with OLAS can call it.
At ~41 OLAS/day reward rate (Jinn), even 50 OLAS covers initial staking.

**Detection:** Error selector `0xafb0be33` in the gas estimation failure revert data.

### Master Safe vs Venture Safe

- **Master Safe (Operate)**: `0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645` — returned by
  `getMasterSafe('base')`. This is the Safe that owns/staked service 165.
- **Venture Safe (AMP2)**: `0x900Db2954a6c14C011dBeBE474e3397e58AE5421` — the AMP2
  treasury Safe. DIFFERENT from the operate Safe.

## Files

| File | Purpose |
|------|---------|
| `scripts/migrate-staking-contract.ts` | Main migration script (direct Safe SDK) |
| `scripts/check-post-unstake.ts` | Diagnostic: check service state after unstaking |
| `olas-operate-middleware/operate/ledger/profiles.py` | Patched: ServiceManagerToken override for Base |
| `olas-operate-middleware/.operate/services/*/config.json` | Service configuration (staking_program_id, RPC, etc.) |
| `ponder/abis/StakingToken.json` | Staking contract ABI (events + view functions) |
| `jinn-node/src/worker/filters/stakingFilter.ts` | Worker filter using staking data from Ponder |

## Migration Log (Service 165: AgentsFun1 → Jinn)

### Completed Steps
1. **Unstake from AgentsFun1** — TX: `0x07489d16...` (via Safe SDK, previous session)
2. **Fund Master Safe** — Transferred 5,050 OLAS from agent key to Master Safe
3. **Patch ServiceManagerToken** — Fixed wrong address in autonomy profiles
4. **Terminate** — TX: `0xcff76568...` (via middleware HTTP)
5. **Unbond** — TX: `0xe59f1574...` (via middleware HTTP)
6. **Update/re-register** — TX: `0x7f86fa01...` (5,000 OLAS bond)
7. **Approve OLAS + Activate** — TX: `0x127baad9...`
8. **Fund Master Safe** — User sent ~4,900 OLAS to cover agent bond
9. **Register agents + Deploy** — via middleware POST (successful)
10. **Deposit staking rewards** — 50 OLAS deposited into Jinn staking contract via agent key
    - Approve TX: `0x808ce0dc...`
    - Deposit TX: `0x328bbbb2...`
11. **Stake in Jinn** — via middleware POST (successful)

### Final State (COMPLETE)
- Service state: **4 (DEPLOYED)**, staked in Jinn
- NFT owner: Jinn staking contract (`0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139`)
- Staking state: **STAKED**
- Jinn `getServiceIds()`: `[165]`
- Security deposit: 5,000 OLAS (locked in ServiceRegistry)
- Agent bond: 5,000 OLAS (locked in ServiceRegistry)
- Staking rewards available: ~50 OLAS (~1.2 days at 41 OLAS/day)

## Staking ABI (Key Functions)

```solidity
// Read
function getServiceIds() view returns (uint256[])
function mapServiceInfo(uint256 serviceId) view returns (address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity)
function minStakingDeposit() view returns (uint256)
function maxNumServices() view returns (uint256)
function getStakingState(uint256 serviceId) view returns (uint8)

// Write
function stake(uint256 serviceId) external
function unstake(uint256 serviceId) external returns (uint256)
```

## Events

```solidity
event ServiceStaked(uint256 epoch, uint256 indexed serviceId, address indexed owner, address indexed multisig, uint256[] nonces)
event ServiceUnstaked(uint256 epoch, uint256 indexed serviceId, address indexed owner, address indexed multisig, uint256[] nonces, uint256 reward, uint256 availableRewards)
```
