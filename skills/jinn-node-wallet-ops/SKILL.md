---
name: jinn-node-wallet-ops
description: Operate and recover jinn-node wallets safely, including backup, key export, withdraw, unstake, restake evicted services, and full recovery with mandatory dry-run and confirmation gates.
allowed-tools: Bash, Read
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: [node, yarn]
    primaryEnv: OPERATE_PASSWORD
    source: https://github.com/Jinn-Network/jinn-node
---

# jinn-node-wallet-ops

Use this skill for wallet and funds operations.

All commands run from `jinn-node/`.

## Safety gates

For destructive or sensitive operations, require explicit confirmation:
- `yarn wallet:export-keys`
- `yarn wallet:recover ...`
- real withdrawals (non-`--dry-run`)

Default sequence: inspect -> dry run -> execute.

## Commands

### Status

```bash
cd jinn-node
yarn wallet:info
```

### Backup

```bash
cd jinn-node
yarn wallet:backup
yarn wallet:backup --output my-backup.tar.gz
```

### Export keys (sensitive)

```bash
cd jinn-node
yarn wallet:export-keys
```

### Withdraw funds

```bash
cd jinn-node
yarn wallet:withdraw --to <address> --dry-run
yarn wallet:withdraw --to <address>
```

### Restake evicted services

```bash
cd jinn-node
yarn wallet:restake --dry-run
yarn wallet:restake
yarn wallet:restake --service <config-id>   # specific service only
```

Routes through the middleware's `deploy_service_onchain_from_safe` → `stake_service_on_chain_from_safe` (the same Safe tx path Pearl uses). Automatically handles: detect eviction → claim pending rewards → unstake → approve NFT → restake. The local deployment phase will fail on non-Docker environments (expected); the on-chain restaking completes before that step.

Pre-flight checks: minimum staking duration elapsed, staking slots available, rewards available.

### Unstake service

```bash
cd jinn-node
yarn wallet:unstake --dry-run
yarn wallet:unstake
```

72-hour staking cooldown applies.

### Full recovery (destructive)

```bash
cd jinn-node
yarn wallet:recover --to <address> --dry-run
yarn wallet:recover --to <address>
```

## Required env

- `RPC_URL`
- `OPERATE_PASSWORD`

## Post-action verification

After any write action, run:

```bash
cd jinn-node
yarn wallet:info
```
