---
name: jinn-node-operator-setup
description: Onboard a first-time jinn-node operator locally, including prerequisite checks, .env configuration, setup funding loops, mnemonic capture protocol, and initial worker run.
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
node --version
yarn --version
python3 --version
poetry --version
tendermint version
git --version
```

Python must be `3.10` or `3.11`.

### 2. Environment bootstrap

```bash
cd jinn-node
cp .env.example .env
```

Collect and set required values:
- `RPC_URL`
- `OPERATE_PASSWORD`
- Gemini auth (`GEMINI_API_KEY` or existing Gemini CLI OAuth)

Strongly encouraged input (for coding-job participation):
- `GITHUB_TOKEN` (treat as effectively required for most coding ventures)

Recommended with `GITHUB_TOKEN`:
- `GIT_AUTHOR_NAME`
- `GIT_AUTHOR_EMAIL`

If operator declines `GITHUB_TOKEN`, explicitly warn that coding-job participation will be limited or fail, then require acknowledgement before continuing.

Do not change prefilled endpoint defaults unless requested.

### 3. Install dependencies

```bash
cd jinn-node
yarn install
```

### 4. Run setup (funding loop)

```bash
cd jinn-node
yarn setup 2>&1
```

When setup exits for funding, treat as expected behavior:
1. capture required address/amount from output,
2. ask operator to fund,
3. rerun `yarn setup`,
4. repeat until complete.

### 5. Mnemonic capture protocol

On first wallet creation, extract and show the mnemonic from setup output immediately.
Require explicit operator confirmation they saved it before continuing.

### 6. Verify local runtime

```bash
cd jinn-node
yarn wallet:info
yarn worker --single
```

### 7. Optional: add a second service

For multi-service rotation readiness:

```bash
cd jinn-node
yarn service:add --dry-run
yarn service:add
```

Repeat funding loop if requested by script.

## Common failure classes

See `references/setup-failures.md`.

## Exit criteria

- `.operate/` exists and contains service config + keys.
- `yarn wallet:info` returns valid addresses and balances.
- Worker starts and reaches polling loop.
- Operator has confirmed mnemonic backup.
