# provenance

Reference implementation: adminless, inverted perpetual markets on Percolator.

## What this is

This fork of `percolator-cli` explores a specific market design:

- **Inverted perp markets** where the traded token is the collateral.
- **All fees paid in the token**, flowing irreversibly into an insurance fund.
- **Admin key burned after initialization.** No governance, no voting, no discretionary controls.
- **Credibility earned through time, solvency, and behavior** — not through promises or authority.

After admin burn, no instruction can modify fees, risk parameters, oracle sources, or the matcher registry. This is verifiable on-chain.

## What this is not

- Not a frontend or production exchange.
- Not an audited protocol ready for real funds.
- Not a governance system or DAO.

This is a **reference implementation** — infrastructure documentation in code form — demonstrating that a perpetual market can be designed to require zero human intervention after launch.

## Design principles

### No parameters are changeable after admin burn

The admin key is transferred to `11111111111111111111111111111111` (the system program). Since the system program cannot sign admin-gated instructions, all admin operations become permanently disabled:

- `update-config` (funding/threshold parameters)
- `set-risk-threshold`
- `update-admin`
- `set-oracle-authority`
- `resolve-market`
- `close-slab`
- `withdraw-insurance`

### The insurance fund is a one-way accumulator

- Receives all trading fees and account initialization fees.
- Non-withdrawable after admin burn (no signer can call `withdraw-insurance`).
- Non-upgradeable (no proxy, no migration path).
- Usable only for liquidation shortfalls (haircut ratio mechanism).
- Its growth is the market's primary credibility signal.

### Credibility is measured, not claimed

On-chain state exposes:

| Metric | Source | Meaning |
|---|---|---|
| Market age | Slots since admin burn | Survival duration |
| Keeper crank count | `next_account_id` progression | Operational continuity |
| Liquidation history | `lifetime_liquidations`, `lifetime_force_closes` | Risk event frequency |
| Insurance fund balance | `insurance_fund.balance` | Loss absorption capacity |
| Insurance fee revenue | `insurance_fund.fee_revenue` | Cumulative fee capture |
| Parameter changes | Admin key check | Should be zero after burn |
| Total open interest | `total_open_interest` | Market utilization |

These metrics are read-only. They do not affect pricing in the base implementation. They exist to make credibility measurable — to turn "trust me" into "measure this."

### Pricing adapts to market conditions

The credibility-aware matcher adjusts spreads based on:

- **Net open interest imbalance** — wider spreads when skewed.
- **Insurance fund size relative to open interest** — larger fund enables tighter spreads.
- **Market age and solvency streak** — older, solvent markets are structurally cheaper to trade.

The matcher is deterministic, requires no human input, and signs quotes autonomously.

## Architecture

This CLI interacts with three on-chain programs:

1. **percolator-prog** — The risk engine. Handles margin, liquidation, funding, settlement. Not modified by this fork.
2. **percolator-match** — The matcher program. Extended with a credibility-aware pricing mode.
3. **System program** — The burned admin key. Its inability to sign is the enforcement mechanism.

### What Percolator already handles (not modified)

- Margin accounting
- Liquidation mechanics
- Keeper crank scheduling
- Oracle price ingestion (Pyth, Chainlink)
- Funding rate calculation from LP inventory
- Haircut ratio for socialized losses

This fork's contribution is **economic behavior** — how the market prices risk and accumulates credibility — not protocol safety.

## Lifecycle

### 1. Initialize market

```bash
provenance init-market \
  --slab <pubkey> --mint <pubkey> --vault <pubkey> \
  --index-feed-id <hex> --invert 1 \
  --trading-fee-bps 10 --maintenance-margin-bps 500 \
  --initial-margin-bps 1000 ...
```

### 2. Burn admin

```bash
provenance burn-admin --slab <pubkey>
```

Transfers admin to `11111111111111111111111111111111`. Irreversible.

### 3. Verify immutability

```bash
provenance verify-immutability --slab <pubkey>
```

Reads on-chain state and confirms:
- Admin is the system program (burned).
- Oracle authority is zero or non-functional.
- No entity can modify market parameters.

Anyone can run this at any time. The verification is purely on-chain data.

## CLI commands

### Market lifecycle

| Command | Description |
|---|---|
| `init-market` | Initialize a new market with all parameters |
| `burn-admin` | Transfer admin to system program (irreversible) |
| `verify-immutability` | Prove the market is adminless on-chain |

### Insurance fund observability

| Command | Description |
|---|---|
| `insurance:status` | Current balance, fee revenue, growth metrics |
| `insurance:health` | Insurance vs open interest, coverage ratio |

### Credibility metrics

| Command | Description |
|---|---|
| `credibility:status` | Market age, solvency streak, keeper activity, parameter immutability |

### Market liveness

| Command | Description |
|---|---|
| `prove-liveness` | Snapshot proving the market runs without intervention |

### Standard operations (unchanged from percolator-cli)

| Command | Description |
|---|---|
| `init-user` | Create a trading account |
| `init-lp` | Create an LP account |
| `deposit` | Deposit collateral |
| `withdraw` | Withdraw collateral |
| `trade-cpi` | Trade via matcher |
| `trade-nocpi` | Trade directly |
| `keeper-crank` | Update funding and process liquidations |
| `best-price` | Find best available prices |
| `topup-insurance` | Add to the insurance fund |
| `slab:*` | Inspect on-chain market state |

## Installation

```bash
pnpm install
pnpm build
```

## Configuration

Create `~/.config/percolator-cli.json`:

```json
{
  "rpcUrl": "https://api.devnet.solana.com",
  "programId": "<program-id>",
  "walletPath": "~/.config/solana/id.json"
}
```

Or use flags: `--rpc <url>`, `--program <pubkey>`, `--wallet <path>`, `--json`, `--simulate`.

## Success criteria

The system is correct when the following statement is true:

> This market has no owner, no knobs, and no promises. Its only reputation is how long it has survived and how honestly it prices risk.

If the system needs emergency switches, governance votes, or manual rebalancing, it failed the design goal.

## Related repositories

- [percolator](https://github.com/aeyakovenko/percolator) — Risk engine library
- [percolator-prog](https://github.com/aeyakovenko/percolator-prog) — Solana program
- [percolator-match](https://github.com/aeyakovenko/percolator-match) — Matcher program

## Disclaimer

**FOR EDUCATIONAL AND RESEARCH PURPOSES ONLY.** This code has not been audited. Do not use with real funds. Experimental software provided as a reference implementation.

## License

Apache 2.0 — see [LICENSE](LICENSE)
