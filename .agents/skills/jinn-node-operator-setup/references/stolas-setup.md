# stOLAS Setup

stOLAS uses the ExternalStakingDistributor so operators stake without providing OLAS. LemonTree depositors fund the capital. Only ETH is needed for gas.

## 1. Ensure wallet exists

If no `.operate/` directory exists, create the wallet first:

```bash
cd jinn-node
yarn setup 2>&1
```

This creates the Master EOA + Master Safe, then exits requesting funding. **Capture the mnemonic** (see Step 5 in SKILL.md). Fund the Master EOA with ~0.005 ETH and rerun until the Master Safe is created.

If `.operate/wallets/ethereum.json` already exists, skip to step 2.

## 2. Check balances

```bash
cd jinn-node
yarn wallet:info
```

Both Master EOA and Master Safe need ETH on Base for gas. The setup flow will print exact amounts if funding is insufficient — relay those to the operator.

## 3. Run stOLAS setup

```bash
cd jinn-node
yarn setup --stolas 2>&1
```

This will:
1. Load Master EOA + Master Safe from `.operate/`
2. Print identity info — relay to operator for verification
3. Generate new agent EOA
4. Preflight check (distributor + slots)
5. Route `stake()` through Master Safe → creates service on-chain
6. Discover serviceId + Safe
7. Store agent key + **back up key to `~/.jinn/key-backups/`** + import config
8. Fund agent EOA from Master Safe
9. Deploy mech via service Safe
10. Update config with mech address

> **Key backup:** Encrypted with `OPERATE_PASSWORD`. Inform the operator to store both the backup file and the password securely.

If mech deployment fails (insufficient Master Safe ETH):
```bash
npx tsx scripts/deploy-mech.ts --service-config-id=<id>
```

Return to **Step 5** in SKILL.md.
