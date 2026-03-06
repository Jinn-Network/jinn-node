---
name: jinn-node-operator-setup
description: Onboard a jinn-node operator locally with stOLAS (default, no OLAS needed) or standard OLAS staking, including prerequisite checks, .env configuration, setup funding loops, mnemonic capture, and initial worker run.
allowed-tools: Bash, Read, Edit, Write, Glob
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: [node, yarn, python3, poetry]
    primaryEnv: OPERATE_PASSWORD
    source: https://github.com/Jinn-Network/jinn-node
---

# jinn-node-operator-setup

Use this skill for first-time local operator onboarding. This is the required path before Railway deployment.

## Critical gate

Before collecting credentials or running setup, disclose this to the operator and wait for explicit acknowledgement:

> Your LLM provider can see terminal session data used during setup, including wallet password and mnemonic output. Do not use this wallet for personal funds.

If the operator is not comfortable, stop and instruct manual setup.

## Workflow

### 1. Prerequisites

Validate toolchain and install missing dependencies where possible:

```bash
node --version        # Must be 20+
yarn --version
python3 --version     # Must be 3.10 or 3.11
poetry --version
tendermint version
git --version
```

Python must be `3.10` or `3.11`. If wrong, install 3.11 alongside existing Python:
```bash
# macOS: brew install python@3.11
# Ubuntu: sudo apt-get install python3.11 python3.11-venv python3.11-dev
poetry env use python3.11
```

### 2. Environment bootstrap

```bash
cd jinn-node
cp .env.example .env
```

Collect and set **secrets only** in `.env`:
- `RPC_URL` — Base network RPC endpoint (Alchemy, Infura, or QuickNode recommended)
- `OPERATE_PASSWORD` — encrypts the wallet keystore (min 8 chars)
- Gemini auth: `GEMINI_API_KEY` (simplest) or Gemini CLI OAuth (`npx @google/gemini-cli auth login`)

Strongly encouraged:
- `GITHUB_TOKEN` — required for most coding ventures. Without it, explicitly warn operator.

Recommended with `GITHUB_TOKEN`:
- `GIT_AUTHOR_NAME`
- `GIT_AUTHOR_EMAIL`

**Configuration:** `jinn.yaml` is auto-generated on first run with correct defaults. Do not create or edit unless the operator has specific customization needs.

### 3. Install dependencies

```bash
cd jinn-node
yarn install
```

### 4. Run stOLAS setup (recommended — no OLAS required)

stOLAS uses the ExternalStakingDistributor so operators stake without providing OLAS. LemonTree depositors fund the capital. Only ETH is needed for gas.

#### 4a. Ensure wallet exists

If this is a brand new setup (no `.operate/` directory), run standard setup first to create the wallet:

```bash
cd jinn-node
yarn setup 2>&1
```

This will create the Master EOA + Master Safe and then exit requesting funding. **Capture the mnemonic** (see Step 5). Fund the Master EOA with ~0.005 ETH and rerun until the Master Safe is created. You do NOT need OLAS for this step.

If `.operate/wallets/ethereum.json` already exists, skip to 4b.

#### 4b. Preflight check

Before running stOLAS setup, verify availability:

```bash
cd jinn-node
npx tsx -e "
import { stolasPreflightCheck } from './src/worker/stolas/StolasServiceBootstrap.js';
import 'dotenv/config';
async function main() {
  const result = await stolasPreflightCheck(process.env.RPC_URL || '');
  if (result.ok) {
    console.log('stOLAS available:', result.slotsRemaining, 'slots remaining');
  } else {
    console.log('stOLAS unavailable:', result.error);
    console.log('Falling back to standard setup (10,000 OLAS required)');
  }
}
main();
"
```

If stOLAS is **unavailable** (no slots or distributor not configured), inform the operator:

> stOLAS is currently unavailable — either all staking slots are occupied or the distributor is not configured for this staking contract. You can use the standard setup path which requires ~10,000 OLAS. See Step 4-alt below.

If stOLAS is **available**, proceed:

#### 4c. Fund for stOLAS

stOLAS requires only ETH — no OLAS:

| Address | Amount | Purpose |
|---------|--------|---------|
| Master EOA | >= 0.003 ETH | Gas for Safe transaction |
| Master Safe | >= 0.015 ETH | Stake tx gas + agent EOA funding + mech deployment |

Total: ~0.02 ETH (~$50 on Base L2).

Check current balances:
```bash
cd jinn-node
npx tsx -e "
import { ethers } from 'ethers';
import 'dotenv/config';
async function main() {
  const p = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const w = JSON.parse(require('fs').readFileSync('.operate/wallets/ethereum.json','utf-8'));
  const eoa = await p.getBalance(w.address);
  const safe = await p.getBalance(w.safes.base);
  console.log('Master EOA (' + w.address + '):', ethers.formatEther(eoa), 'ETH');
  console.log('Master Safe (' + w.safes.base + '):', ethers.formatEther(safe), 'ETH');
  if (eoa < ethers.parseEther('0.003')) console.log('>>> Fund Master EOA with >= 0.003 ETH');
  if (safe < ethers.parseEther('0.015')) console.log('>>> Fund Master Safe with >= 0.015 ETH');
}
main();
"
```

Ask operator to fund if needed. After funding:

#### 4d. Run stOLAS setup

```bash
cd jinn-node
yarn setup --stolas 2>&1
```

This will:
1. Load Master EOA + Master Safe from `.operate/`
2. Print identity info (Master EOA, Master Safe, chain) — relay this to the operator for verification
3. Generate new agent EOA
4. Preflight check (distributor + slots)
5. Route `stake()` through Master Safe → creates service on-chain
6. Discover serviceId + Safe
7. Store agent key + **back up key to `~/.jinn/key-backups/`** + import config to `.operate/services/`
8. Fund agent EOA from Master Safe
9. Deploy mech via service Safe
10. Update config with mech address

> **Key backup:** The backup file is printed in the output (e.g. `~/.jinn/key-backups/0x71E9...5AAe3_2026-03-06T09-17-15.json`). This backup is encrypted with `OPERATE_PASSWORD` — without the password, the key cannot be recovered. Inform the operator to store both the backup file and the password securely.

If mech deployment fails (insufficient Master Safe ETH), setup will succeed but print instructions to deploy the mech separately:
```bash
npx tsx scripts/deploy-mech.ts --service-config-id=<id>
```

### 4-alt. Standard setup (when stOLAS is unavailable)

If stOLAS slots are full or the distributor is not configured:

```bash
cd jinn-node
yarn setup 2>&1
```

Funding requirements for standard path:
- Master EOA: ~0.005 ETH (gas)
- Master Safe: ~0.01 ETH (operational gas) + **~10,000 OLAS** (5k deposit + 5k bond)

When setup exits for funding:
1. Capture required address/amount from output
2. Ask operator to fund (OLAS can be purchased on Uniswap Base or bridged from Ethereum mainnet)
3. Rerun `yarn setup`
4. Repeat until complete

### 5. Mnemonic capture protocol

On first wallet creation, extract and show the mnemonic from setup output immediately.
Require explicit operator confirmation they saved it before continuing.

### 5b. Key backup verification

After setup completes, verify the key backup exists:

```bash
ls -la ~/.jinn/key-backups/
```

Inform the operator:

> Your agent key has been backed up to `~/.jinn/key-backups/`. This backup is encrypted with your `OPERATE_PASSWORD`. Store both the backup file and the password securely — without the password, the key cannot be recovered.

### 6. Verify setup

```bash
cd jinn-node
yarn wallet:info
yarn service:list
yarn service:status
```

Expected:
- Wallet addresses and balances displayed
- At least one service config with a service ID
- Service staked (status = Staked)
- Mech address present in config

### 7. Run the worker

```bash
cd jinn-node
yarn worker --single    # Single job execution to verify
yarn worker             # Full polling loop
```

### 8. Optional: add more services

For multi-service rotation:

```bash
cd jinn-node
yarn setup --stolas     # Add another stOLAS service
# or
yarn service:add        # Add via standard middleware flow
```

## Common failure classes

See `references/setup-failures.md`.

### stOLAS-specific failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `stOLAS distributor not configured` | ExternalStakingDistributor not set up for this staking contract | Contact Jinn team or use standard setup (Step 4-alt) |
| `All staking slots occupied` | Max services reached in the staking contract | Wait for slots to free up or use standard setup (Step 4-alt) |
| `Master EOA has insufficient ETH` | Not enough gas for Safe transaction | Fund Master EOA with >= 0.001 ETH on Base |
| `Master Safe needs ETH for mech deployment` | Mech deploy deferred | Fund Master Safe, then run `npx tsx scripts/deploy-mech.ts --service-config-id=<id>` |
| `stake() via Master Safe reverted` | Safe nonce issue or contract error | Check Master Safe is owner of the service, check on-chain state |
| `Service created but config import failed` | `.operate/services/` write error | Check disk permissions, manually import with `ServiceImporter` |
| `Pre-flight simulation failed` | MechMarketplace.create() would revert | Check service Safe is registered, check mech factory address |

## Exit criteria

- `.operate/` exists and contains service config + keys.
- `~/.jinn/key-backups/` contains at least one backup file per agent key.
- `yarn wallet:info` returns valid addresses and balances.
- `yarn service:list` shows at least one service.
- Service is staked (staking state = 1).
- Mech address is present in service config.
- Worker starts and reaches polling loop.
- Operator has confirmed mnemonic backup.
- Operator has been informed about key backup location and `OPERATE_PASSWORD` requirement.
