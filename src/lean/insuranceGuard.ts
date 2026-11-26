/**
 * Windowed insurance-draw cap.
 *
 * `Market.maxInsDrawBps` bounds each individual liquidation's insurance draw
 * to a fraction of the market's insurance balance AT THE TIME OF THAT DRAW.
 * That bounds any single draw, but a sequence of N draws against the live
 * (already-depleted) balance still compounds down to roughly
 * `(1 - maxInsDrawBps/BPS_DEN)^N` of the balance at the start of the
 * sequence — far below the single-step bound the cap was meant to enforce.
 *
 * `InsuranceDrawWindow` instead fixes the cap against the balance observed
 * at the start of a window and never re-derives it from the depleted
 * balance, so cumulative draws across any number of sequential liquidations
 * are bounded by `maxInsDrawBps` of that starting balance. Pre-launch
 * validation and monitoring tooling should track draws this way and flag a
 * market whose observed cumulative drain exceeds the windowed cap.
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
 * The deployed per-draw cap: taken against the CURRENT (depleting) balance.
 * Kept here only as a reference so callers/tests can compare its cumulative
 * behavior against `InsuranceDrawWindow` above.
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
 * Replay a sequence of liquidation shortfalls both ways and report the
 * totals. `perDrawTotal - windowedTotal` is the extra drain a sequential
 * self-liquidation attack extracts past the single-step guarantee.
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
