/**
 * Windowed insurance-draw cap (aeyakovenko/percolator-cli#113, residual of #103).
 *
 * `Market.maxInsDrawBps` bounds each individual liquidation's insurance draw
 * (`handleLiquidate`'s `min(shortfall, mulDiv64(insurance, maxInsDrawBps, BPS_DEN))`)
 * to a fraction of the market's insurance balance AT THE TIME OF THAT DRAW. That
 * bounds any single call, but a sequence of pre-sized liquidations — each
 * individually under the cap, each re-deriving the cap from the already-depleted
 * live balance — still compounds to roughly `(1 - maxInsDrawBps/BPS_DEN)^N` of the
 * balance at the start of the sequence. #113 pre-sizes 27 bilateral pairs so each
 * draw is ~24.5% of the remaining pool and drains 98.34% of a $23 pot; #103 drained
 * 98.71% the same way with 20 pairs. #103 was "fixed" on-chain with a `K+1=5`
 * envelope that bounds bad debt at the 5th liquidation step, but that envelope says
 * nothing about a sequence of liquidations that each individually clear the cap —
 * it does not help here, because the cap is still re-derived from the depleted
 * live balance on every call, however many steps preceded it.
 *
 * `InsuranceDrawWindow` instead fixes the cap against the balance observed at the
 * start of a window and never re-derives it from the depleted balance, so
 * cumulative draws across any number of sequential liquidations — regardless of
 * how many oracle steps or liquidations preceded them — are bounded by
 * `maxInsDrawBps` of that starting balance. Pre-launch validation and monitoring
 * tooling built on this client should track draws this way and flag any market
 * whose observed cumulative drain exceeds the windowed cap.
 */
import { BPS_DEN } from "./constants.js";

export class InsuranceDrawWindow {
  readonly windowStart: bigint;
  readonly capBps: bigint;
  private drawn = 0n;

  constructor(windowStart: bigint, capBps: bigint) {
    this.windowStart = windowStart;
    this.capBps = capBps;
  }

  /** Total this window may ever draw in total, fixed at construction. */
  get cap(): bigint {
    return (this.windowStart * this.capBps) / BPS_DEN;
  }

  get drawnSoFar(): bigint {
    return this.drawn;
  }

  get remaining(): bigint {
    const r = this.cap - this.drawn;
    return r > 0n ? r : 0n;
  }

  /** Clamp a requested shortfall draw to what's left in the window and record it. */
  request(shortfall: bigint): bigint {
    const take = shortfall < this.remaining ? shortfall : this.remaining;
    this.drawn += take;
    return take;
  }
}

/**
 * The deployed per-call cap: taken against the CURRENT (depleting) balance.
 * Kept here only as a reference so callers/tests can compare its cumulative
 * behavior across a sequence against `InsuranceDrawWindow` above.
 */
export function perDrawCapAgainstCurrentBalance(currentInsurance: bigint, shortfall: bigint, capBps: bigint): bigint {
  const cap = (currentInsurance * capBps) / BPS_DEN;
  return shortfall < cap ? shortfall : cap;
}

export interface DrawSequenceResult {
  windowStart: bigint;
  /** What the deployed per-draw-against-current-balance cap actually lets through. */
  perDrawTotal: bigint;
  perDrawRemaining: bigint;
  /** What a windowed cap fixed at `windowStart` would have let through. */
  windowedTotal: bigint;
  windowedCap: bigint;
}

/**
 * Replay a sequence of liquidation shortfalls both ways and report the totals.
 * `perDrawTotal - windowedTotal` is the extra drain a sequential pre-sized
 * self-liquidation attack extracts past the single-step guarantee, no matter how
 * many oracle steps separated the pairs' entry from the liquidation sequence.
 */
export function simulateInsuranceDrawSequence(
  windowStart: bigint,
  capBps: bigint,
  shortfalls: readonly bigint[],
): DrawSequenceResult {
  let live = windowStart;
  let perDrawTotal = 0n;
  for (const s of shortfalls) {
    const d = perDrawCapAgainstCurrentBalance(live, s, capBps);
    perDrawTotal += d;
    live -= d;
  }
  const win = new InsuranceDrawWindow(windowStart, capBps);
  for (const s of shortfalls) win.request(s);
  return {
    windowStart,
    perDrawTotal,
    perDrawRemaining: windowStart - perDrawTotal,
    windowedTotal: win.drawnSoFar,
    windowedCap: win.cap,
  };
}
