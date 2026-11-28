# Same-slot pre-oracle staleness in the deployed `887ba02` core

Status: **confirmed on the live mainnet binary** (2026-11-29). Read-only; no
transaction was signed or sent.

Runnable reproduction: `scripts/lean-same-slot-staleness-poc.ts`

```
LEAN_RPC_URL=<mainnet-rpc> npx tsx scripts/lean-same-slot-staleness-poc.ts
```

Exit 0 = exploit reproduced, exit 1 = blocked (which is what should happen once
the upstream fix is deployed — this PoC doubles as an upgrade canary).

## The defect

`checkAllLegsFreshLoop` in `percolator-lean@887ba02`
(`Percolator/Program.lean:201-215`) is slot-granular only:

```lean
SolanaM.require (rSlot == curSlot) PErr.stalePortfolioLeg
if requireLocked then
  SolanaM.require (bankruptMark == 0 && lockedMm >= cachedMm) PErr.insufficientMargin
```

It does **not** verify `leg.entryK == mkt.kSide`, has no `postOracle` flag, and
does not recompute `cachedMm` against the live mark / ADL factor.
`handleWithdrawCollateral` (`Program.lean:1032`), `handleLiquidate`, `handleTrade`
and `TradeWithMatcher` all rely on this gate. Because `curSlot` is per-block, a
`RefreshLeg` in one transaction of a slot still counts as "fresh" after a later
`UpdateOracle` in the same slot.

Upstream `8774e86` added `verifyLegFreshAgainstMkt`, the `postOracle` byte,
`freshCtx` trailing market accounts and a live `cachedMm` recomputation. Its
regression suite names the three attacks:

- `svm-runner/src/boring_tests.rs:4555` — 1A "Same-Slot Pre-Oracle RefreshLeg ->
  UpdateOracle -> WithdrawCollateral Cash Theft!"
- `:4591` — 1B "Same-Slot Pre-Oracle Selective Hedged-Spread Liquidation!"
- `:4642` — 1C "Pre-Oracle probeBankrupt(optFlag=2) + Positive UpdateOracle in
  Same Slot!"
- `:4588` — asserts the fixed build rejects 1A with `Custom(122)`

## Reproduction against the deployed binary

Built with this client's own instruction builders and simulated against live
mainnet state via `simulateTransaction` with `sigVerify=false` and
`replaceRecentBlockhash=true`. `sigVerify=false` preserves the message's
`is_signer` flags, which is what the on-chain program checks.

Cross-checked on three independent RPC endpoints (Helius,
`api.mainnet-beta.solana.com`, `solana-rpc.publicnode.com`): all three return
`OK` with identical `unitsConsumed` and 9 program log lines.

| Sequence | Result | `entryK` vs `kSide` |
|---|---|---|
| `[UpdateOracle, Withdraw]` | `Custom(122)` | gate exists |
| `[UpdateOracle, RefreshLeg, Withdraw]` (honest) | OK | coherent (`staleDelta=0`) |
| `[RefreshLeg, UpdateOracle, Withdraw]` (**exploit**) | OK | stale by ~2.4–2.8e8 raw K |
| `[RefreshLeg, UpdateOracle, RefreshLeg, Withdraw]` (control) | OK | coherent — divergence eliminated |

Quantified on the live round-4 BTC/USD market (mark `-0.506%`, `$1` withdrawal):

- exploit path leaves ~`$0.76`–`$0.79` more `capital` than the honest path;
- under-credits the counterparty's realized pool `R_m` by ~`$0.81`–`$0.84`;
- permits ~`$0.73` **more cash withdrawn** in the same slot (`$3.834` vs
  `$3.102` max, measured by binary search over the withdrawal amount).

The unsettled loss equals `ceil(rawBasis * (entryK - kSide) / POS_SCALE)`, and
scales with `maxMoveBps` (100 bps live). The oracle is rate-limited to one update
per slot, so this is repeatable once per slot.

All three upstream `8774e86` freshness predicates evaluate FALSE against the
exploit post-state:

1. `entryK == kSide` — FALSE
2. `lastOrac != curSlot || postOracle == 1` — FALSE (same slot, flag 0)
3. `cachedMm == computeMarginWithFloor(effRaw, mark, mmBps, minMm)` — FALSE

Therefore the fixed build rejects this sequence with `Custom(122)`.

## Preconditions

`UpdateOracle` requires a signature from `Market.oracleAuth`
(`Program.lean:877,881`). The live round-4 `oracleAuth` is an off-chain keypair
held by the operator's keeper, so an attacker does not hold it. Two paths:

1. **Same-slot sandwich.** `[RefreshLeg]` in tx A, the keeper's `UpdateOracle`
   in tx B, `[WithdrawCollateral]` in tx C, all in one slot. Needs
   priority-fee / bundle engineering; probabilistic, not executed here.
2. **Attacker-created market.** `CreateMarket` is permissionless and the creator
   sets `oracleAuth`, making the sequence fully atomic. Per-market insurance
   isolation confines the resulting bad debt to that market's own `I_m`.

## Action

The fix already exists upstream in `8774e86` (`b3a4971` on top). The README
notes the in-place mainnet upgrade is "pending a devnet proof that no existing
account is stranded" and requires a client update to pass trailing market
accounts on withdraw / trade / liquidate. Until that upgrade lands this
sequence is live. This PoC should be run again after the upgrade; exit 1 is the
expected result.

## Related findings in the same deployed build

- `checkFundingCfg` (`Program.lean:666-677`) uses gross `tradeFeeBps` rather
  than the irrecoverable fee slice. The live market has `rewardBps=10000`, so
  `irrecovFeeBps=0` and the coalition-negative-EV funding-wash guarantee is
  vacuous. Upstream `8774e86` fixed this explicitly ("blocking
  `rewardBps = 10000`").
- `realizeWinnerPnl` (`Program.lean:418-460`) pays winners order-dependently in
  an ADL deficit; the first `RefreshLeg` bot takes its full face from the scarce
  `R_m` while an equal winner is left unpaid (`maxFrontBps=0` live). Upstream
  added `deficitMode` escrow; t30 Target #1 asserts exact `$110/$110` in both
  orders.
