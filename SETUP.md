# JINN Node Setup

## Quick Start

```bash
# 1. Install dependencies
yarn install
cd ../olas-operate-middleware && poetry install && cd ../jinn-node

# 2. Configure environment
cp .env.example .env
# Edit .env with your RPC_URL and OPERATE_PASSWORD

# 3. Run setup
yarn setup
```

## Requirements

- **Node.js** 20+ (22 recommended)
- **Python** 3.10-3.11
- **Poetry** - Python dependency manager
- **RPC URL** - Base network RPC endpoint (Alchemy, Infura, etc.)
- **OPERATE_PASSWORD** - Minimum 8 characters for wallet encryption

### Funding Requirements

Setup will prompt you to fund addresses. Have ready:
- ~0.01 ETH for gas (Master EOA + Master Safe)
- ~100 OLAS for staking (if staking enabled)

## Environment Variables

Required in `.env`:
```
OPERATE_PASSWORD=your_secure_password_min_8_chars
RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

## For AI Assistants (Claude, Gemini, etc.)

If you're an AI agent helping a user set up a jinn-node:

### Run Setup in Background

**Important**: Run the setup command in the background so you can monitor output:

```bash
yarn setup 2>&1 &
```

Or use your tool's background execution feature (e.g., `run_in_background: true`).

### Monitor for Funding Prompts

Watch the output for lines like:
```
Please transfer at least 0.005 ETH to the Master EOA 0x...
Please transfer at least 0.01 ETH to the Master Safe 0x...
Please transfer at least 100 OLAS to the Master Safe 0x...
```

When you see these:
1. Tell the user the exact address and amount needed
2. Wait for user to confirm funding is complete
3. Setup will automatically detect funding and continue

### Common Issues

| Issue | Solution |
|-------|----------|
| `poetry not found` | Install Poetry: `curl -sSL https://install.python-poetry.org \| python3 -` |
| `OPERATE_PASSWORD not set` | Add to .env or export: `export OPERATE_PASSWORD="password"` |
| `RPC_URL not set` | Add to .env: `RPC_URL=https://...` |
| Setup hangs | It's waiting for funding - check output for addresses |

### Typical Flow

1. Run `yarn setup` in background
2. Setup creates wallet, shows Master EOA address needing ~0.005 ETH
3. User funds, setup detects and continues
4. Setup creates Safe, shows Master Safe address needing ETH + OLAS
5. User funds, setup detects and deploys
6. Setup completes with Service Config ID

### Exit Codes

- `0` - Setup complete
- `1` - Error (check output)
- Setup waiting for funding doesn't exit - it polls until funded

## CLI Options

```
--testnet           Use .env.test for Tenderly VNet deployment
--chain=NETWORK     Network: base, gnosis, mode, optimism (default: base)
--no-mech           Disable mech deployment
--no-staking        Disable staking
--unattended        Non-interactive mode (requires pre-funded wallets)
--isolated          Fresh .operate in temp directory
```

## After Setup

Setup outputs:
- **Service Config ID** - Used to manage the service
- **Service Safe Address** - The deployed multisig

These are saved to `/tmp/jinn-service-setup-*.json`.

To run the worker:
```bash
yarn dev:mech
```
