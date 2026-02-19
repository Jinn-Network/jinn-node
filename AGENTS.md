# JINN Node Agent Entry Point

This file is the routing index for coding agents operating `jinn-node`.

Use dedicated skills for operational workflows. Keep this file minimal.

## Default Venture Context

Primary onboarding venture:

`https://explorer.jinn.network/ventures/0x9470f6f2bec6940c93fedebc0ea74bccaf270916f4693e96e8ccc586f26a89ac`

## Global Non-Negotiables

1. **Security disclosure first** for first-time setup sessions:
   - LLM provider can process terminal session data (including wallet password and mnemonic output).
   - Do not proceed until operator acknowledges.
2. **Railway deploy happens after local setup**:
   - `.operate/` must exist and be valid before Railway migration.
3. **Sensitive operations require explicit confirmation**:
   - mnemonic/key export,
   - destructive recovery operations,
   - non-dry-run fund movements.
4. **GitHub token is strongly encouraged at setup**:
   - without `GITHUB_TOKEN`, participation in most coding jobs is limited or fails.

## Skill Router

Use these skills based on task intent:

- Local first-time onboarding and setup loop:
  - [`skills/jinn-node-operator-setup/SKILL.md`](skills/jinn-node-operator-setup/SKILL.md)
- Railway deployment and canary/prod gateway switching:
  - [`skills/jinn-node-railway-deploy/SKILL.md`](skills/jinn-node-railway-deploy/SKILL.md)
- Wallet operations (backup/export/withdraw/unstake/recover):
  - [`skills/jinn-node-wallet-ops/SKILL.md`](skills/jinn-node-wallet-ops/SKILL.md)
- Staking reward operations:
  - [`skills/jinn-node-staking-ops/SKILL.md`](skills/jinn-node-staking-ops/SKILL.md)
- Support triage and diagnostics:
  - [`skills/jinn-node-support-triage/SKILL.md`](skills/jinn-node-support-triage/SKILL.md)
- High-level baseline onboarding:
  - [`skills/jinn-node/SKILL.md`](skills/jinn-node/SKILL.md)

## Default Execution Order (new operator)

1. Local setup: `jinn-node-operator-setup`
2. Optional local validation run (`yarn worker --single`)
3. Railway migration: `jinn-node-railway-deploy`
4. Ongoing operations via wallet/staking/support skills

If this file and a skill diverge, follow the skill.
