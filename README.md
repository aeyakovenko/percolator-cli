# percolator-cli

TypeScript client for **percolator-lean** — a formally verified Lean 4 → Solana
sBPF perpetuals DEX (core + matcher + oracle_adapter), built with
[`lean-svm`](https://github.com/aeyakovenko/lean-svm) and living in the sibling repo
[`percolator-lean`](https://github.com/aeyakovenko/percolator-lean).

The client is in [`src/lean/`](src/lean) (`import … from "percolator-cli/lean"`).
Deployed program ids and ELF hashes are in [`lean-mainnet.json`](lean-mainnet.json)
and [`lean-devnet.json`](lean-devnet.json); the devnet/mainnet test harnesses are in
[`lean-devnet/`](lean-devnet/README.md) and [`scripts/`](scripts).

> The legacy v16 Rust protocol and its client have been removed from this repo. The
> last commit containing them is in git history before the lean migration.

## Related Repositories

- [percolator-lean](https://github.com/aeyakovenko/percolator-lean) — formally verified Lean 4 → sBPF perps DEX (the deployed program).
- [lean-svm](https://github.com/aeyakovenko/lean-svm) — Lean 4 → Solana sBPF compiler toolchain that builds it.

**Third-party repositories are community contributions. Do not trust — always verify. Review the code yourself before running or deploying anything.**

## Disclaimer

**FOR EDUCATIONAL PURPOSES ONLY.** This code has **NOT been audited** (it is formally
verified at the Lean level, which is not the same as an audit). The percolator program
is experimental software. Use at your own risk.

## Installation

```bash
pnpm install
pnpm build
```

## Deployments

Current build: percolator-lean `e189ef2`. **Round-3 (LIVE, e189ef2)** runs on mainnet ids (upgraded in place);
round-2 programs (`GVV4HC…`) are **deprecated and left as-is**.

| Program | Mainnet (`e189ef2`) | Devnet (`e189ef2`) |
|---|---|---|
| `percolator` (core DEX) | `6NeT5VYzF2DAj8RcUJtLfgv21CR8WiehNpABFV1t4M3Q` | `4xw3wdbqbTXWKdxYkSYgfsk3GX2YTbKsiefKwFr9Q6TM` |
| `reward_module` (wSOL buy-and-burn) | `D8V9aNXEPjgan1Kz4wjYrW5UJZzJWsGYsVJpa6NPtEMw` | `4vj8wK4HBsyxi5xMz7UXVpkKw1CqMBkrvRBmuM8YvHAi` |
| `matcher` (passive-LP / PropAMM) | `EFLgSpuiyXxHJHFAWCZtmzdcTXeHguiMSUyRHN3z3FDR` | `2HQtUrH1u4KnPGABxyVNNmXo9SJ3zQg9otz6wyfJMJip` |
| `oracle_adapter` | `B4v96XfX4df9NtPbHjYsLTYkrjccGqWt4nsgyPpJbCSN` | `BkyW7iLvAWuyEozvnGAwgks4dyuTNm7Xnybd6DwQLu2x` |

Deprecated round-2 percolator: `GVV4HCAohuWDTXRHUYLpFECvTUhCUF2qys36vQKtYJsm`.
Upgrade authority: `A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK`. The ids are exported as
`LEAN_MAINNET` / `LEAN_DEVNET` in [`src/lean/constants.ts`](src/lean/constants.ts) —
the same client talks to either cluster.

> **Collateral note:** the DEX stores token base units directly as its E6 accounting,
> so a market's collateral must be a **6-decimal USD-style token** (e.g. USDC) — not
> 9-decimal wSOL.

## What the program does

Permissionless multi-market cross-margin perps: anyone can create a market, provide
insurance, build their own matcher (passive-LP AMM / CPI-out PropAMM), open positions
(bilateral, single-signer against a matcher, or an atomic flip), and cross-margin a
portfolio across markets on shared capital — with a **per-leg `lockedMm` firewall** so
one market can never raid another's isolated margin or insurance. A market can route a
share of its trade fees to an external **`reward_module`**: a permissionless per-market
Gavel xy=k batch **buy-and-burn** (`StartEpoch`/`SubmitBid`/`SettleEpoch`/`ClaimQuote`),
e.g. BTC/USD fees → wSOL burn. Oracles are read natively from Pyth (`PriceUpdateV2`),
Chainlink (OCR2), or Switchboard (On-Demand), with optional 2-leg composite ratios and
EWMA / Hybrid After-Hours smoothing, all cranked permissionlessly via `oracle_adapter`.
Fund-safety invariant: `V == SPL vault balance == C + I + R + S + totalRewards`.

All of these flows are verified on the live mainnet program by
[`scripts/lean-mainnet-verify.ts`](scripts/lean-mainnet-verify.ts) (7/7), and the
fund-safety / conservation (`V == SPL vault balance`) surface by
[`scripts/lean-attack.ts`](scripts/lean-attack.ts) and
[`scripts/lean-bounty-validate.ts`](scripts/lean-bounty-validate.ts).

## CLI examples (`percolator-cli/lean`)

```ts
import { Connection, Keypair } from "@solana/web3.js";
import {
  LEAN_MAINNET, POS_SCALE, TRADE_MODE,
  initDex, initPortfolio, depositCollateral, trade,
  matcherInit, matcherFill, deriveDexVault, withLegRefresh,
} from "percolator-cli/lean";

const P = LEAN_MAINNET.percolator, M = LEAN_MAINNET.matcher;
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// (mint = a 6-decimal USDC-style collateral; vault = deriveDexVault(P, dex)[0])

// --- open a position: both counterparties sign one bilateral Trade ---
trade(P, { dex, market, longPortfolio: pA, longOwner: ownerA.publicKey,
           shortPortfolio: pB, shortOwner: ownerB.publicKey,
           mode: TRADE_MODE.OPEN, qty: 2n * POS_SCALE });
// NOTE: a Trade/Withdraw needs every open leg refreshed in the same tx —
// wrap with withLegRefresh(conn, [ix], { percolator: P }).

// --- build your OWN matcher (passive-LP AMM) and let anyone take against it ---
matcherInit(M, { cfg: matcherCfg, owner: lpOwner.publicKey, dex, lpPortfolio,
                 percolator: P, halfSpreadBps: 50n, impactBps: 20n, maxFillQty: 10n * POS_SCALE });
matcherFill(M, { cfg: matcherCfg, dex, market, lpPortfolio,
                 takerPortfolio, taker: taker.publicKey, percolator: P,
                 mode: TRADE_MODE.OPEN, takerIsLong: true, qty: POS_SCALE, limitPrice });
```

Runnable end-to-end flow (create market → positions → cross-margin → matcher):
[`scripts/lean-mainnet-verify.ts`](scripts/lean-mainnet-verify.ts). Full feature
smoke on devnet: `pnpm test` ([`tests/lean/devnet-smoke.ts`](tests/lean/devnet-smoke.ts)).
Read-only invariant survey of every DEX: `pnpm lean:survey`.

## Bug bounty — LIVE (round 3, ~$69 on BTC/USD) on percolator-lean `e189ef2`

> **History.** Round 1 was claimed via an insurance account-reuse bug (fixed in `bb54ac6`).
> Round 2 (SOL/USD, 70 USDC) was claimed via a **cross-margin + hostile-oracle insurance drain**
> — a throwaway market with an attacker-controlled oracle, cross-margined against the honest prize
> market, bled its insurance through shared capital. Fixed from `a056eee` on (structural
> cross-market isolation; "user capital, insurance and realized pools are 100% untouchable"),
> verified on devnet (`scripts/_lean-xmargin-drain.ts` → BLOCKED). The round-2 market
> (`CedQKV…` / `BhYaG2…`) is **deprecated and left as-is** (do not use it).

**Round 3** runs on mainnet programs (`e189ef2`, upgraded in place) with three independent prize surfaces on
a BTC/USD market. Winning = extracting more than you put in, or violating conservation
(`V == SPL == C + I + R + S + totalRewards`).

| | Mainnet address |
|---|---|
| percolator | `6NeT5VYzF2DAj8RcUJtLfgv21CR8WiehNpABFV1t4M3Q` |
| reward_module | `D8V9aNXEPjgan1Kz4wjYrW5UJZzJWsGYsVJpa6NPtEMw` |
| DEX | `Ef9p9J2dRBb5aGzPiBG2cxqTCvT3DvcDUYNULBUPTiHh` |
| Market (BTC/USD) | `9JWceeR4k9mworx5QqvvjxSc7xF7PRYjQE3Ng4QYs5Ej` |
| Collateral | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Reward (wSOL buy-and-burn) | cfg `gBfHSSUefHoAM1q92MPENeernKmRxZFDPpxSqmLVkEg` |
| **Prize 1 — insurance** | **$23** (market insurance pot) |
| **Prize 2 — vault portfolio** | **$23** loose collateral — `2YYTS9t2mV2ZSfmXxqNZV6TLQEHwqsHSSSPqJQNrHw4t` |
| **Prize 3 — user long** | **~$23** (0.003 BTC long) — `DtNXawKjnbmAB57qoo2fzamBnQqhuRgmTPmFDZy8ewMj` |

Also in [`lean-mainnet-r3.json`](lean-mainnet-r3.json). The market charges a **2 bps** trade fee,
100% routed to a **wSOL buy-and-burn** reward module (permissionless `StartEpoch`/`SubmitBid`/
`SettleEpoch`/`ClaimQuote`). The BTC oracle is operator-pushed (lazily cranked).

**How to play:** point the `percolator-cli/lean` client at a mainnet RPC + `LEAN_MAINNET`,
create a portfolio, deposit USDC, trade, and find a way to drain the insurance, steal the vault
portfolio's collateral or the user long, or break the reward auction. The harnesses
`scripts/lean-attack.ts`, `scripts/_lean-exploit.ts`, `scripts/_lean-xmargin-drain.ts` and
`scripts/_lean-e2e.ts` show what has already been tried and the normal-case flows.
