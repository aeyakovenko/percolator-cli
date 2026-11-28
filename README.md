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

Current build: percolator-lean `887ba02`. **Round 4 (LIVE, `887ba02`)** runs on **fresh mainnet program ids**
(launched on `9b45ad1`, upgraded in place to `887ba02` — zero ABI change since): `9b45ad1` changed the ABI (Market grew 400 → 416 bytes for the built-in funding engine), so it could not be
upgraded in place without stranding open positions. The **round-3 programs (`6NeT5…`, `a31a1f8`) are deprecated
but left running untouched** so the users who still hold positions there can refresh and close them (its oracle
keeps being cranked). Round-2 programs (`GVV4HC…`) are deprecated and left as-is.

| Program | Mainnet round 4 (`887ba02`) | Devnet (`887ba02`) |
|---|---|---|
| `percolator` (core DEX) | `EUj4Jj8SY3MpkboazJWLeUMmZjCAwwaUhkAGXZQNfLnB` | `4xw3wdbqbTXWKdxYkSYgfsk3GX2YTbKsiefKwFr9Q6TM` |
| `reward_module` (wSOL buy-and-burn) | `CH9WNijiS9p6bKfSEgpHXujAJuxUJ29rgynZuZst9Utv` | `4vj8wK4HBsyxi5xMz7UXVpkKw1CqMBkrvRBmuM8YvHAi` |
| `matcher` (passive-LP / PropAMM) | `GVN3LTDVGRstkxSYzg2Jw8YoguyvgHBTpewK8mEwBBtp` | `2HQtUrH1u4KnPGABxyVNNmXo9SJ3zQg9otz6wyfJMJip` |
| `oracle_adapter` | `BTJX41YamU8Y74FCcUGMGbjxwamrc2artBUvViF9Tyoz` | `BkyW7iLvAWuyEozvnGAwgks4dyuTNm7Xnybd6DwQLu2x` |

Deprecated round-3 (`a31a1f8`, 400-byte Market) — exported as `LEAN_MAINNET_R3`: percolator
`6NeT5VYzF2DAj8RcUJtLfgv21CR8WiehNpABFV1t4M3Q`, reward `D8V9aNXEPjgan1Kz4wjYrW5UJZzJWsGYsVJpa6NPtEMw`,
matcher `EFLgSpuiyXxHJHFAWCZtmzdcTXeHguiMSUyRHN3z3FDR`, adapter `B4v96XfX4df9NtPbHjYsLTYkrjccGqWt4nsgyPpJbCSN`.
**This client (416-byte Market) cannot parse round-3 markets** — to manage a round-3 position use
`percolator-cli@5ba2b70`. Deprecated round-2 percolator: `GVV4HCAohuWDTXRHUYLpFECvTUhCUF2qys36vQKtYJsm`.

Upgrade authority: `A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK`. The ids are exported as
`LEAN_MAINNET` / `LEAN_DEVNET` in [`src/lean/constants.ts`](src/lean/constants.ts) —
the same client talks to either cluster. Deploying these sBPF v3 binaries needs **Agave CLI ≥ 4.x**
(solana-cli 2.1.0 rejects them with `ELF error: Offset or value is out of bounds`).

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
Since `9b45ad1` a market can enable a **built-in HL/Binance-style funding engine** (immutable `fundingCfg`:
base interest, deadband, ±cap per 8h, premium-EWMA decay — build it with `packFundingCfg()`); funding then accrues
trustlessly on every oracle update from the perp-vs-spot premium, and externally pushed funding is rejected.
Fund-safety invariant: `V == SPL vault balance == C + I + R + S + totalRewards`.

All of these flows are verified on the live mainnet program by
[`scripts/lean-mainnet-verify.ts`](scripts/lean-mainnet-verify.ts) (7/7), and the
fund-safety / conservation (`V == SPL vault balance`) surface by
[`scripts/lean-attack.ts`](scripts/lean-attack.ts) and
[`scripts/lean-bounty-validate.ts`](scripts/lean-bounty-validate.ts).

## CLI examples (`percolator-cli/lean`)

```ts
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  LEAN_MAINNET, POS_SCALE, TRADE_MODE, PROP_CTX_SIZE,
  trade, withLegRefresh,
  propAmmInit, setPortfolioMatcher, tradeWithMatcherFresh,
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

// --- run a passive AMM vault (PropAMM) that anyone can trade against with ONE signature ---
// 1. create the 272-byte ctx and init it in the SAME transaction (init is first-come), then bind it to the LP portfolio:
new Transaction().add(
  SystemProgram.createAccount({ fromPubkey: lp.publicKey, newAccountPubkey: ctx.publicKey,
                                lamports: rent, space: PROP_CTX_SIZE, programId: M }),
  propAmmInit(M, { ctx: ctx.publicKey, owner: lp.publicKey, allowedMarketIds: [marketId],
                   halfSpreadBps: 20n, impactBps: 5n, maxFillQty: POS_SCALE / 10n }));
setPortfolioMatcher(P, { portfolio: lpPortfolio, owner: lp.publicKey, matcherCtx: ctx.publicKey });
// 2. a taker trades against it; the helper prepends the RefreshLegs the program requires for BOTH portfolios:
const ixs = await tradeWithMatcherFresh(conn, P, {
  dex, takerPortfolio, taker: taker.publicKey, lpPortfolio, matcherProgram: M, matcherCtx: ctx.publicKey,
  legs: [{ market, mode: TRADE_MODE.NETTED, takerIsLong: true, maxQty: POS_SCALE, limitPrice }],
});
// NETTED (mode 4) is the always-available path; the vault may fill LESS than maxQty (it clamps to maxFillQty),
// and it quotes buyers at >= mark and sellers at <= mark. The market's oracle must be fresh or trades revert (oracleStale).
```

Runnable end-to-end flows: market → positions → cross-margin → matcher
([`scripts/lean-mainnet-verify.ts`](scripts/lean-mainnet-verify.ts)) and the AMM vault
([`scripts/_lean-propamm-devnet.ts`](scripts/_lean-propamm-devnet.ts)). Full feature
smoke on devnet: `pnpm test` ([`tests/lean/devnet-smoke.ts`](tests/lean/devnet-smoke.ts)).
Read-only invariant survey of every DEX: `pnpm lean:survey`.

## Bug bounty — LIVE (round 4, ~$69 on BTC/USD) on percolator-lean `887ba02`

> **History.** Round 1 was claimed via an insurance account-reuse bug (fixed in `bb54ac6`).
> Round 2 (SOL/USD, 70 USDC) was claimed via a **cross-margin + hostile-oracle insurance drain**
> — a throwaway market with an attacker-controlled oracle, cross-margined against the honest prize
> market, bled its insurance through shared capital. Fixed from `a056eee` on (structural
> cross-market isolation), verified on devnet (`scripts/_lean-xmargin-drain.ts` → BLOCKED).
> Round 3 (BTC/USD, `6NeT5…` / market `9JWceeR4…`) ran through `e189ef2` → `71d38f0` → `a31a1f8` and was not
> claimed; it was retired for round 4 when `9b45ad1` changed the ABI. Its market is **deprecated but still
> live** for the users who hold positions there (its insurance stays in place until their OI reaches 0).

**Round 4** runs on fresh mainnet programs (`887ba02`) with three independent prize surfaces on a BTC/USD market
with **built-in funding** (+0.01%/8h base, ±0.05% deadband, ±1%/8h cap). Winning = actually extracting more
than you put in **from the live mainnet deployment**, or violating conservation
(`V == SPL == C + I + R + S + totalRewards`) on mainnet.

> **Rules — this is a live capture-the-flag, not a report-for-payout program.**
> - **To claim the bounty you must actually execute the attack on mainnet**, against the addresses below.
> - **The only prize is what your attack actually captures on-chain.** Nothing is paid out on top of
>   that, and nothing is paid for reports, write-ups, PoCs, or devnet / localnet / LiteSVM reproductions.
> - Fixes can land at any time. If a bug is patched before you execute it on mainnet, there is nothing
>   to capture.
> - Bug reports are still welcome as issues, but they are not paid.

| | Mainnet address |
|---|---|
| percolator | `EUj4Jj8SY3MpkboazJWLeUMmZjCAwwaUhkAGXZQNfLnB` |
| reward_module | `CH9WNijiS9p6bKfSEgpHXujAJuxUJ29rgynZuZst9Utv` |
| DEX | `6ogqEo6qbCY5dmjkBQNXntoESE4HDHwKQGnushbPysFn` |
| Market (BTC/USD) | `4EWHoCLweWAbb1DZ2sUfLRLnL9xvNJEwhnekaV7qthAp` |
| Collateral | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Reward (wSOL buy-and-burn) | cfg `5CjsnHViXk6Nvj8hoGSW54W9YhggxzTggMsHitRxbAzx` |
| **Prize 1 — insurance** | **$23** (market insurance pot) |
| **Prize 2 — vault portfolio** | **$23** loose collateral — `4oqFBi5VnGrUiwPEC8SZ9kJXHQi2QSucCBQE3TtGMMj7` |
| **Prize 3 — user long** | **~$23** (0.003 BTC long) — `9vtoSvrhv5vw7qt6oUdBw835B4pejrmbjWmie3uz2RMh` |

Also in [`lean-mainnet-r4.json`](lean-mainnet-r4.json). The market charges a **2 bps** trade fee,
100% routed to a **wSOL buy-and-burn** reward module (permissionless `StartEpoch`/`SubmitBid`/
`SettleEpoch`/`ClaimQuote`). The BTC oracle is operator-pushed (a lazy keeper checks every 5 minutes and pushes only when needed); each push also
steps the built-in funding.

**How to play:** point the `percolator-cli/lean` client at a mainnet RPC + `LEAN_MAINNET`,
create a portfolio, deposit USDC, trade, and find a way to drain the insurance, steal the vault
portfolio's collateral or the user long, game the funding engine, or break the reward auction. The harnesses
`scripts/lean-attack.ts`, `scripts/_lean-exploit.ts`, `scripts/_lean-xmargin-drain.ts`,
`scripts/_lean-builtin-funding.ts` and `scripts/_lean-e2e.ts` show what has already been tried and the
normal-case flows.
