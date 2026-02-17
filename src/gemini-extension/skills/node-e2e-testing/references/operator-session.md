# Operator Session

Tests: Setup → Operator scripts → Add 2nd service → Multi-service validation → Simulate activity → Dispatch job → Worker rotation switching + job execution.

**Prerequisite**: Complete the shared steps (Infrastructure + Setup) from SKILL.md first.

**Quota budget**: First service setup uses ~3-4 write transactions. Adding a 2nd service uses ~5-6 more (mint, activate, register agents, deploy Safe, approve NFT, stake). Job dispatch + delivery adds ~2-3 more. Total: ~12-15 writes. Paid Tenderly tier supports this.

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
3. Show funding requirements and exit

Fund the required addresses from the monorepo root:
```bash
yarn test:e2e:vnet fund <address> --eth <amount> --olas <amount>
```

Then re-run to continue deployment:
```bash
cd "$CLONE_DIR" && yarn service:add
```

Repeat the fund + re-run cycle until the service is fully deployed and staked.

## Validate Multi-Service Scripts

After the 2nd service is provisioned:

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

**Record the Safe addresses** for both services — you'll need them for the rotation test:
```bash
cd "$CLONE_DIR" && yarn service:list 2>&1 | grep -i safe
```

Save as `SERVICE_A_SAFE` (first service) and `SERVICE_B_SAFE` (second service).

## Simulate Activity for Service A

**Do this BEFORE dispatching or starting the worker.** This makes the rotator pick Service B from the start, so the dispatched job (which targets Service B's mech) gets processed immediately.

**Key insight**: We can't wait for ~864 real requests per epoch. Instead, use Tenderly's `tenderly_setStorageAt` to manipulate on-chain activity counters, making Service A appear eligible while Service B still needs work.

Read the VNet admin RPC URL from `.env.e2e`:
```bash
source .env.e2e
ADMIN_RPC="$RPC_URL"
```

The WhitelistedRequesterActivityChecker checks two nonces:
- `nonces[0]` = Safe nonce (storage slot 5 in GnosisSafe)
- `nonces[1]` = Marketplace request count (`mapRequestCounts[multisig]` at slot 9 in MechMarketplace)

**Both must increase** and `requestCount <= safeNonce` must hold.

Run this script to make Service A appear eligible (replace `SERVICE_A_SAFE` with the actual address):

```bash
node -e "
const { ethers } = require('ethers');

const rpcUrl = '$ADMIN_RPC';
const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const multisig = '$SERVICE_A_SAFE';
const ACTIVITY = 1000; // well above ~864 threshold

async function rpc(method, params) {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({jsonrpc:'2.0', id:1, method, params})
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
  return j.result;
}

async function main() {
  // 1. Set Safe nonce (slot 5) to ACTIVITY value
  await rpc('tenderly_setStorageAt', [
    multisig,
    ethers.zeroPadValue(ethers.toBeHex(5), 32),
    ethers.zeroPadValue(ethers.toBeHex(ACTIVITY), 32),
  ]);
  console.log('Set Safe nonce to', ACTIVITY);

  // 2. Set mapRequestCounts[multisig] in MechMarketplace (slot 9, keccak256 mapped)
  const slot = ethers.solidityPackedKeccak256(
    ['bytes32', 'bytes32'],
    [ethers.zeroPadValue(multisig, 32), ethers.zeroPadValue(ethers.toBeHex(9), 32)]
  );
  await rpc('tenderly_setStorageAt', [
    MECH_MARKETPLACE, slot, ethers.zeroPadValue(ethers.toBeHex(ACTIVITY), 32),
  ]);
  console.log('Set mapRequestCounts[multisig] to', ACTIVITY);

  // Verify
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const checker = new ethers.Contract(
    '0x1dF0be586a7273a24C7b991e37FE4C0b1C622A9B', // activity checker
    ['function getMultisigNonces(address) view returns (uint256[])'],
    provider
  );
  const nonces = await checker.getMultisigNonces(multisig);
  console.log('Verified nonces:', nonces.map(n => n.toString()));
}

main().catch(e => { console.error(e); process.exit(1); });
"
```

Expected output: `Verified nonces: [ '1000', '1000' ]`

## Fund Agent EOAs

Both agent EOAs need ETH for gas (marketplace request payment costs ~0.01 ETH). Get the addresses from `service:list` output, then fund from the monorepo root:
```bash
yarn test:e2e:vnet fund <agent-eoa-1> --eth 0.05
yarn test:e2e:vnet fund <agent-eoa-2> --eth 0.05
```

## Dispatch a Job

From the monorepo root, dispatch a job for the worker to process:
```bash
yarn test:e2e:dispatch \
  --workstream 0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac \
  --cwd "$CLONE_DIR"
```

The dispatch uses the active service's mech. Since the rotator will pick Service B (Service A is eligible from storage manipulation), the job is dispatched to Service B's mech.

## Run the Worker with Rotation

```bash
cd "$CLONE_DIR" && WORKER_MULTI_SERVICE=true WORKER_ACTIVITY_POLL_MS=15000 yarn worker --single > /tmp/worker-rotation.log 2>&1
```

Using `--single` here because we only need one poll cycle: the rotator picks Service B at startup (Service A is already eligible), finds the dispatched job, and processes it.

Look for in the output:
- `Multi-service rotation active` — confirms ServiceRotator initialized with 2 services
- `activeService` set to Service B's config ID (Service A is eligible, so rotator picks B)
- `reason` — should say something like "service #N needs N more requests"
- Worker claims and processes the dispatched job

## Debugging Sources

Always report these paths at session end for investigation:

- **Worker log**: `/tmp/worker-rotation.log` — full worker output including rotation events
- **Script output**: stdout from each operator command
- **Middleware logs**: `$CLONE_DIR/.operate/` — middleware daemon output
- **Service configs**: `$CLONE_DIR/.operate/services/` — all service config directories
- **Ponder logs**: Background stack output (task output file)
- **Clone directory**: `$CLONE_DIR` — contains `.env`, `.operate/`, service configs
- **VNet config**: `.env.e2e` — VNet RPC URL and session state
- **VNet quota**: `yarn test:e2e:vnet status` — check remaining write quota

## Acceptable Failures

- **Delivery fails with 403 (quota exhausted)**: OK — the key validation is rotation picking Service B and claiming the job.
- **Rewards show `0.0000 OLAS`**: Expected for freshly staked services.
- **`tenderly_setStorageAt` not available**: This is an admin RPC method. Ensure you're using the admin RPC URL (from VNet creation), not the public RPC URL.
- **Dispatch fails with insufficient balance**: Fund the agent EOAs with ETH first (see "Fund Agent EOAs" step).

## Success Criteria

- [ ] `service:list` showed 1 service after initial setup
- [ ] `service:status` displayed epoch and staking data for 1 service
- [ ] `rewards:summary` displayed contract details and health summary
- [ ] `service:add` successfully provisioned and staked a 2nd service
- [ ] `service:list` showed 2 services with distinct config IDs, service IDs, and safe addresses
- [ ] `service:status` displayed data for both services
- [ ] `tenderly_setStorageAt` made service A appear eligible (verified via `getMultisigNonces`)
- [ ] Worker initialized rotation with 2 services (logged "Multi-service rotation active")
- [ ] Worker picked Service B as active (Service A eligible, B needs work)
- [ ] Worker claimed and processed the dispatched job on Service B
