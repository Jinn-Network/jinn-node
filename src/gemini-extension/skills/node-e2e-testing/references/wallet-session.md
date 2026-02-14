# Wallet Session

Tests: Setup → Wallet info → Key export → Time warp → Unstake → Withdraw (full recovery).

**Prerequisite**: Complete the shared steps (Infrastructure + Setup) from SKILL.md first. Do NOT run the worker — skip dispatch to conserve VNet quota for recovery transactions.

## Wallet Info

```bash
cd "$CLONE_DIR"
yarn wallet:info
```

Expected output: Master EOA, Master Safe, Service Safe, Agent EOA addresses with ETH/OLAS balances. Verify all addresses match the setup output.

## Export Keys

```bash
cd "$CLONE_DIR"
yarn wallet:export-keys
```

Expected output: BIP-39 mnemonic for the master EOA. Verify it produces a valid 12/24-word phrase.

## Recovery (Unstake + Withdraw)

OLAS staking has a 72-hour minimum cooldown before unstaking is allowed. Use time-warp to skip it.

### 1. Advance VNet Time

From the monorepo root:
```bash
yarn test:e2e:vnet time-warp 259200   # 72 hours in seconds
```

### 2. Dry Run

Test recovery without executing:
```bash
cd "$CLONE_DIR" && yarn wallet:recover --to <destination-address> --dry-run
```

Use any valid address as the destination (e.g., the Master EOA). The dry run should show:
- Current staking status
- OLAS amount to be recovered
- ETH amount to be recovered
- Destination address

### 3. Execute Recovery

```bash
cd "$CLONE_DIR" && yarn wallet:recover --to <destination-address>
```

This performs:
1. **Terminate & Withdraw** — Calls the middleware API to unstake from the staking contract, returning OLAS to the Master Safe
2. **Withdraw from Safe** — Transfers OLAS and ETH from the Master Safe to the destination address

### 4. Verify

```bash
cd "$CLONE_DIR" && yarn wallet:info
```

After recovery:
- Master Safe should have reduced OLAS/ETH balances
- The destination address should have received the funds

## Acceptable Failures

- **Recovery fails with 403 (quota exhausted)**: The unstake + withdraw flow requires multiple on-chain transactions. If quota runs out mid-recovery, the partial state is expected on Tenderly.
- **"Not enough time passed"**: Time-warp didn't advance enough. Run `yarn test:e2e:vnet time-warp 259200` again.

## Success Criteria

- `wallet:info` displayed correct addresses and balances
- `wallet:export-keys` produced a valid mnemonic
- `wallet:recover --dry-run` showed correct recovery plan
- `wallet:recover` executed unstake + withdraw (or reached quota limit trying)
