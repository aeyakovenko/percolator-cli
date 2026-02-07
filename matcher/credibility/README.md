# Credibility-Aware Matcher

A deterministic Solana program that prices perpetual futures trades based on market credibility signals.

## Design

The matcher adjusts spreads using four factors:

### 1. Base spread (floor)

Every trade pays at least `min_spread_bps`. This is the cost of immediacy.

### 2. Inventory imbalance (wider when skewed)

```
imbalance_cost = imbalance_k_bps * |inventory| / liquidity_notional_e6
```

When the LP is heavily long or short, spreads widen to discourage further imbalance. This is standard market-making behavior.

### 3. Insurance fund coverage (tighter when well-funded)

```
coverage = min(insurance_balance / total_open_interest, 1.0)
discount = coverage * insurance_weight_bps
spread -= discount
```

A market with a large insurance fund relative to its open interest is structurally safer. The matcher reflects this by offering tighter spreads. The maximum discount is `insurance_weight_bps`.

### 4. Market age (tighter over time)

```
age_discount = min_spread_bps * market_age / (market_age + age_halflife)
spread -= age_discount
```

This is a hyperbolic discount. At `age_halflife` slots, the discount is 50% of `min_spread_bps`. A market that has survived for a long time without insolvency is cheaper to trade.

### Final spread

```
spread = clamp(base - insurance_discount - age_discount + imbalance_cost, 1, max_spread_bps)
exec_price = oracle_price * (1 ± (spread + base_fee_bps) / 10000)
```

## Instructions

| Tag  | Name                | Description                              |
|------|---------------------|------------------------------------------|
| 0x00 | Match               | Price a trade (called by percolator CPI) |
| 0x02 | Init                | Set up context with LP PDA and params    |
| 0x03 | UpdateCredibility   | Refresh insurance/OI/age snapshots       |

### UpdateCredibility (tag 0x03)

Permissionless. Anyone can call this to refresh the matcher's view of the market. Reads from the slab account and updates:

- Insurance fund balance snapshot
- Total open interest snapshot
- Market age (accumulates only when admin is burned)

Accounts: `[matcher_ctx (writable), slab (read-only), clock (read-only)]`

This should be called periodically by a bot (see `scripts/credibility-update-bot.ts`).

## Properties

- **Deterministic**: Same inputs always produce the same price.
- **Autonomous**: No human input required. Parameters are derived from on-chain state.
- **Permissionless updates**: Anyone can refresh credibility snapshots.
- **No admin**: After initialization, no instruction modifies the matcher's configuration parameters.

## Context Layout

320 bytes total. First 64 bytes are return data (execution price + fill size). Remaining 256 bytes are context:

| Offset | Size | Field               |
|--------|------|---------------------|
| 0      | 8    | magic               |
| 8      | 4    | version             |
| 12     | 1    | kind (2)            |
| 16     | 32   | lp_pda              |
| 48     | 4    | base_fee_bps        |
| 52     | 4    | min_spread_bps      |
| 56     | 4    | max_spread_bps      |
| 60     | 4    | imbalance_k_bps     |
| 64     | 16   | liquidity_e6        |
| 80     | 16   | max_fill_abs        |
| 96     | 16   | inventory (i128)    |
| 112    | 8    | last_oracle_price   |
| 120    | 8    | last_exec_price     |
| 128    | 16   | max_inventory_abs   |
| 144    | 16   | insurance_snapshot   |
| 160    | 16   | total_oi_snapshot    |
| 176    | 8    | market_age_slots     |
| 184    | 8    | last_deficit_slot    |
| 192    | 8    | snapshot_slot        |
| 200    | 4    | age_halflife_slots   |
| 204    | 4    | insurance_weight_bps |
| 208    | 48   | _reserved            |

## Building

```bash
cd matcher/credibility
cargo build-sbf
```

Requires the Solana BPF toolchain. See [Solana docs](https://docs.solanalabs.com/cli/install) for installation.

## Deployment

```bash
# Deploy the program
solana program deploy target/deploy/credibility_matcher.so

# Deploy an LP using the program
npx tsx scripts/deploy-credibility-matcher.ts

# Start the credibility update bot
npx tsx scripts/credibility-update-bot.ts 30
```
