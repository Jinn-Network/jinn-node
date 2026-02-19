---
name: jinn-node-staking-ops
description: Execute jinn-node staking reward operations, including L1 dispenser incentive claims and L2 service reward claims, with dry-run-first and funding prechecks.
allowed-tools: Bash, Read
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: [node, yarn]
    primaryEnv: OPERATE_PASSWORD
    source: https://github.com/Jinn-Network/jinn-node
---

# jinn-node-staking-ops

Use this skill for staking reward operations.

## Claim flow

1. Claim L1 dispenser incentives (bridges OLAS to Base).
2. Wait bridge finalization (~20 min typical).
3. Claim L2 service rewards on Base.

## Commands

### 1. L1 dispenser incentives

```bash
cd jinn-node
yarn staking:claim-incentives --dry-run
yarn staking:claim-incentives
```

### 2. L2 service rewards

```bash
cd jinn-node
yarn staking:claim-rewards --dry-run
yarn staking:claim-rewards
```

## Preconditions

- `.operate` exists and service is configured.
- `OPERATE_PASSWORD` set in `.env`.
- Sufficient gas on relevant chain:
  - Ethereum mainnet gas for `claim-incentives`.
  - Base gas for `claim-rewards`.

## Failure handling

If claim fails:
1. capture full stderr/stdout,
2. verify wallet balances with `yarn wallet:info`,
3. retry dry-run to confirm command path and chain context.
