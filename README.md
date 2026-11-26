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

| Program | Mainnet | Devnet |
|---|---|---|
| `percolator` (core DEX) | `GVV4HCAohuWDTXRHUYLpFECvTUhCUF2qys36vQKtYJsm` | `GD43BhWwAjiZLs56juEkacSKkY3TVCTbD7cG7HHDYKdA` |
| `matcher` (passive-LP AMM) | `EFLgSpuiyXxHJHFAWCZtmzdcTXeHguiMSUyRHN3z3FDR` | `9NqBGzLYY5d8v426voAT3VqJUprJX6fwyGJ2a8P4A22N` |
| `oracle_adapter` | `B4v96XfX4df9NtPbHjYsLTYkrjccGqWt4nsgyPpJbCSN` | `5PasXKLBKCAhTPJ2WxPjQxJYbxVnMZY7ZNiQpEVUZ5K2` |

Deployed bytes are byte-identical to the devnet-validated `35cd13c` build
(core `c6dc8329…`, matcher `9d79d159…`, adapter `4a49d558…`). Upgrade authority:
`A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK`. The ids are also exported as
`LEAN_MAINNET` / `LEAN_DEVNET` in [`src/lean/constants.ts`](src/lean/constants.ts) —
the same client talks to either cluster.

> **Collateral note:** the DEX stores token base units directly as its E6 accounting,
> so a market's collateral must be a **6-decimal USD-style token** (e.g. USDC) — not
> 9-decimal wSOL.

## What the program does

Permissionless multi-market cross-margin perps: anyone can create a market, provide
insurance, build their own matcher (passive-LP AMM), open positions (bilateral or
single-signer against a matcher), and cross-margin a portfolio across markets on
shared capital. Oracles are read natively from Pyth (`PriceUpdateV2`), Chainlink
(OCR2), or Switchboard (On-Demand), with optional 2-leg composite ratios and EWMA /
Hybrid After-Hours smoothing, all cranked permissionlessly via `oracle_adapter`.

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

## Bug bounty — LIVE (round 2, 70 USDC prize) on the FIXED build

> **Round 1 (2026-11-26) was claimed** — the 70 USDC was drained via an insurance
> account-reuse/reinjection bug (`InitPortfolio` → `CloseAccount` → `DepositInsurance`,
> where a reused account's stale bytes at offset 80 became the InsReceipt `shares`).
> It is **fixed** in percolator-lean `bb54ac6` (CloseAccount now zeroes the full account
> data and stamps a `MAGIC_CLOSED` sentinel; exact-size checks). The fix is verified on
> devnet — the exploit now fails (`scripts/_lean-exploit.ts` → BLOCKED) — and the mainnet
> programs were upgraded to the byte-identical build.

**Break this live market and keep the insurance fund.** Winning = draining the insurance
pot or otherwise violating conservation (`V == SPL vault balance`).

| | Mainnet address |
|---|---|
| DEX | `CedQKVmmHuta5QcqRNkA96smV33LYtQBHo9wc1YcmFq3` |
| Market (SOL/USD) | `BhYaG2JYRHGrLpWs85TroedmkcG7toX1Ly5YbG1FDZHH` |
| Vault (holds the prize) | `6k2H4GiRDGa7o9X8Ai99sGkPQGAvrAW7gVbKkAKuH2Fk` |
| Collateral | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Oracle | Pyth SOL/USD via `oracle_adapter` (cfg `4P2D6KUS7AcpfDniZrFJvNbw55Mh3qxo95pMW1CE5KZL`) |
| **Prize** | **70 USDC** (insurance pot) |

Also in [`lean-mainnet.json`](lean-mainnet.json) under `bountyMarket`. The old (drained,
tombstoned) round-1 market `76oGDQ…` is closed — do not use it.

**How to play:** point the `percolator-cli/lean` client at a mainnet RPC + `LEAN_MAINNET`,
create a portfolio, deposit USDC, trade (bilateral `trade` or `matcherFill`), and find a
way to extract more USDC than you put in. The attack harnesses `scripts/lean-attack.ts`,
`scripts/lean-bounty-validate.ts` and `scripts/_lean-exploit.ts` show what's already been
tried. The oracle is cranked permissionlessly against the live Pyth SOL/USD feed.
