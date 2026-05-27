# KILLCHAIN: Bankrupt-Recycling via TradeNoCpi

## Vulnerability Summary
The v16 engine fails to properly enforce bankruptcy locks during bilateral `TradeNoCpi` operations. A portfolio that has entered a state of bankruptcy (negative collateral due to adverse price movement) can still execute trades with a solvent counterparty. This allows an attacker controlling both a bankrupt "Probe" portfolio and a solvent "Extractor" portfolio to generate unbounded PnL for the Extractor at the expense of the market's Insurance Fund.

## Execution Trace (Empirically Confirmed on Devnet)
1. **Setup**: The attacker provisions Portfolio A (Extractor) with 0.1 SOL and Portfolio B (Probe) with 0.01 SOL.
2. **Open**: Portfolio A and B enter a bilateral `TradeNoCpi` position (e.g., A Long, B Short) at the current mark price.
3. **Bankruptcy Induction**: The oracle price moves adversely against B (e.g., price doubles). B's position loss exceeds its 0.01 SOL capital, rendering it bankrupt.
4. **The Exploit**: B (now bankrupt) and A execute another `TradeNoCpi` to close the position at a massively off-mark price (e.g. 5x the mark). The engine **accepts** this trade (`Trade SUCCEEDED`).
5. **Drain**: Because B has no capital to pay the realized loss, the deficit is absorbed by the Insurance Fund. Portfolio A's corresponding profit is logged as PnL, which will eventually mature and be withdrawn, effectively draining the Insurance Fund to A.

## Root Cause
The engine's `TradeNoCpi` instruction handler lacks a strict `is_bankrupt()` or `stale_state` guard that properly halts bilateral matching. While liquidations and cranks handle insolvent accounts correctly, `TradeNoCpi` sidesteps these protections, allowing dead capital to be "recycled" into legitimate debt on the protocol.

## Remediation
Implement a strict `bankruptcy_lock` or `health_check` inside `TradeNoCpi`. If either portfolio has `capital + pnl < 0`, the instruction must abort with a specific error (e.g., `EngineLockActive`), forcing the portfolio to be resolved exclusively via `PermissionlessCrank` liquidations.
