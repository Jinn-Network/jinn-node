# stOLAS Onboarding — Design

**Date:** 2026-03-03
**Status:** Draft
**Goal:** Make stOLAS the default onboarding path for jinn-node operators, with graceful fallback to standard OLAS flow when stOLAS is unavailable.

---

## Context

stOLAS (via ExternalStakingDistributor) lets operators stake services without providing 10,000 OLAS upfront — LemonTree depositors fund the capital. This dramatically lowers the onboarding barrier to just ~0.01 ETH for gas on Base L2.

The existing `jinn-node-operator-setup` skill mentions stOLAS as a 4-line footnote. AGENTS.md doesn't reference it. An agent guiding a user through stOLAS has almost no context.

## Approach

**Deploy-first, document-as-we-go.** Walk through the actual deployment on Tenderly testnet, capture what works and what fails, then crystallize into skill updates. Validate on mainnet afterward.

## Architecture

### Flow with automatic fallback

```
Prerequisites → .env setup → yarn install
  → stOLAS preflight check
    → PASS (slots available, distributor configured)
        → Fund Master EOA + Safe with ETH only (~0.01 total)
        → yarn setup --stolas
        → Verify: service staked, mech deployed, agent funded
    → FAIL (no slots / distributor not configured)
        → Inform user: "stOLAS unavailable, falling back to standard flow"
        → Standard flow: fund with 10,000 OLAS + ETH
        → yarn setup
        → Verify: service staked, mech deployed
```

### Detection logic for new vs existing operators

```
Does .operate/ exist with wallets/ethereum.json?
  → NO: Full fresh setup (prereqs, .env, yarn install, wallet creation, stOLAS)
  → YES: Does .operate/services/ have existing configs?
    → NO: Wallet exists but no services — run stOLAS bootstrap directly
    → YES: Existing operator adding a stOLAS service alongside existing ones
```

## Deliverables

### 1. Extend `jinn-node-operator-setup/SKILL.md`

Restructure the workflow:

- **Step 4 becomes:** "Run stOLAS setup (recommended)" — the primary path
- **Step 4b becomes:** "Run standard setup (if stOLAS unavailable)" — fallback
- Add stOLAS-specific preflight section with:
  - ETH-only funding requirements (Master EOA >= 0.001, Master Safe >= 0.007)
  - Distributor config check + slot availability
  - Clear "what to do if stOLAS unavailable" guidance
- Add stOLAS post-deploy verification:
  - Service appears in `yarn service:list`
  - Mech deployed and address recorded in config
  - Agent EOA funded
  - Service staked (staking state = 1)
- Add stOLAS troubleshooting to `references/setup-failures.md`

### 2. Update `AGENTS.md`

- Add stOLAS context to "Default Execution Order"
- Update skill router description to mention stOLAS
- Add stOLAS contract addresses to a reference section
- Note: "stOLAS is recommended default. Standard OLAS flow is the fallback when stOLAS slots are full or the distributor is not configured for this staking contract."

### 3. Testnet validation

Run `yarn setup --testnet --stolas` through the full flow:
- Verify preflight passes on Tenderly VNet
- Capture funding requirements and amounts
- Confirm service creation, mech deployment
- Document any issues encountered

### 4. Mainnet deployment

Fund Master EOA + Safe, run `yarn setup --stolas` on mainnet.
This serves as the production validation of the updated skill.

## Funding Requirements (stOLAS vs Standard)

| Requirement | stOLAS | Standard |
|-------------|--------|----------|
| Master EOA ETH | ~0.001 (gas for Safe tx) | ~0.01 (multiple on-chain txns) |
| Master Safe ETH | ~0.007 (agent funding + mech deploy) | ~0.005 (agent funding) |
| Master Safe OLAS | **0** | **10,000** (5k deposit + 5k bond) |
| Total barrier | ~0.01 ETH (~$25) | 10,000 OLAS + ETH (~$15,000+) |

## Key Contracts

| Contract | Address (Base) |
|----------|---------------|
| ExternalStakingDistributor (stOLAS) | `0x40abf47B926181148000DbCC7c8DE76A3a61a66f` |
| Jinn Staking v2 | `0x66A92CDa5B319DCCcAC6c1cECbb690CA3Fb59488` |
| ServiceRegistryL2 | `0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE` |
| OLAS Token | `0x54330d28ca3357F294334BDC454a032e7f353416` |
| MechMarketplace | `0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020` |

## Sequence

1. Testnet walkthrough (capture outputs, identify gaps)
2. Update skill with stOLAS as primary path + fallback
3. Update AGENTS.md
4. Mainnet deployment to validate
5. Commit all changes
