/**
 * Offline reproduction of the Round-3 e189ef2 residual drain
 * (aeyakovenko/percolator-cli#113): a 12% mark move followed by 27 pre-sized
 * bilateral self-liquidations, each individually under `maxInsDrawBps` but
 * compounding against the depleted live balance to drain 98.3% of the pool.
 * Checks that `InsuranceDrawWindow` bounds the same sequence to `maxInsDrawBps`
 * of the balance observed before the sequence started — independent of how
 * many liquidations or preceding oracle steps make up the sequence, which is
 * why it also covers this #103 residual even though the on-chain `K+1=5`
 * envelope (bounding bad debt at the 5th liquidation step) does not.
 *
 *   npx tsx tests/lean/insurance-window-cap.test.ts
 */
import {
  POS_SCALE, BPS_DEN,
  InsuranceDrawWindow, perDrawCapAgainstCurrentBalance, simulateInsuranceDrawSequence,
} from "../../src/lean/index.js";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}

// ---- Round-3 bounty-market parameters and reported #113 numbers ----
const START_INSURANCE = 23_510_416n; // $23.510416, reported pre-drain balance
const CAP_BPS = 2500n; // maxInsDrawBps
const TARGET_DRAW_BPS = 2450n; // each pair is pre-sized to draw ~24.5% of the remaining pool
const N = 27;

/** Mirrors the exploit's planLegs(): size each shortfall off the *predicted* remaining balance. */
function planShortfalls(start: bigint, n: number, targetBps: bigint): bigint[] {
  const out: bigint[] = [];
  let i = start;
  for (let k = 0; k < n; k++) {
    const s = (i * targetBps) / BPS_DEN;
    if (s <= 0n) break;
    out.push(s);
    i -= s;
  }
  return out;
}

console.log("== reproduce #113: 27 pre-sized draws against the live depleting balance ==");
const shortfalls = planShortfalls(START_INSURANCE, N, TARGET_DRAW_BPS);
ok(shortfalls.length === N, `plan produces ${N} legs before the pool is too small to size another (got ${shortfalls.length})`);

const result = simulateInsuranceDrawSequence(START_INSURANCE, CAP_BPS, shortfalls);
const drainedPct = Number((result.perDrawTotal * 10_000n) / START_INSURANCE) / 100;
console.log(`  perDrawTotal=${Number(result.perDrawTotal) / 1e6} remaining=${Number(result.perDrawRemaining) / 1e6} (${drainedPct}% drained)`);
ok(drainedPct > 95, `per-draw-against-current-balance cap lets ${N} pre-sized liquidations drain >95% of the $23.51 pool, reproducing the reported class of near-total drain (reported 98.34%, this simplified replay gets ${drainedPct}%)`);
ok(result.perDrawRemaining < 1n * POS_SCALE, `less than $1 of insurance survives the sequence under the deployed per-call cap (remaining=${Number(result.perDrawRemaining) / 1e6})`);

console.log("\n== InsuranceDrawWindow bounds the same sequence to maxInsDrawBps of the window start ==");
const expectedCap = (START_INSURANCE * CAP_BPS) / BPS_DEN; // 25% of $23.510416
ok(result.windowedCap === expectedCap, `windowed cap == floor(windowStart * capBps / BPS_DEN) (${result.windowedCap} == ${expectedCap})`);
ok(result.windowedTotal === expectedCap, `cumulative windowed draw saturates at the cap, never above it, across all ${N} legs (${result.windowedTotal} == ${expectedCap})`);
ok(result.windowedTotal < result.perDrawTotal, `windowed total (${Number(result.windowedTotal) / 1e6}) is strictly less than the unguarded per-draw total (${Number(result.perDrawTotal) / 1e6})`);

console.log("\n== the bound is independent of how many liquidations make up the sequence (unlike the K+1=5 envelope) ==");
{
  // Same starting balance and cap, but split into far more/fewer legs (e.g. a
  // longer pre-liquidation oracle-move phase buying more, smaller legs). The
  // on-chain K+1=5 envelope only reasons about the 5th step; the windowed cap's
  // total bound does not depend on the step count at all.
  for (const legs of [5, 13, 27, 60]) {
    const sf = planShortfalls(START_INSURANCE, legs, TARGET_DRAW_BPS);
    const r = simulateInsuranceDrawSequence(START_INSURANCE, CAP_BPS, sf);
    ok(r.windowedTotal <= expectedCap, `windowed cap holds for a ${legs}-leg sequence regardless of step count (${r.windowedTotal} <= ${expectedCap})`);
  }
}

console.log("\n== InsuranceDrawWindow unit behavior ==");
{
  const win = new InsuranceDrawWindow(100n * POS_SCALE, 2500n);
  ok(win.cap === 25n * POS_SCALE, "cap is 25% of window start (100 -> 25)");
  const d1 = win.request(10n * POS_SCALE);
  ok(d1 === 10n * POS_SCALE, "first request under the cap is granted in full");
  ok(win.remaining === 15n * POS_SCALE, "remaining decreases by the granted amount (25 - 10 = 15)");
  const d2 = win.request(100n * POS_SCALE);
  ok(d2 === 15n * POS_SCALE, "a request exceeding what's left is clamped to the remainder, not the live balance");
  ok(win.remaining === 0n, "window is exhausted once cumulative draws hit the cap");
  const d3 = win.request(1n * POS_SCALE);
  ok(d3 === 0n, "further requests after exhaustion are refused, not re-based on a shrunk live balance");
}

console.log("\n== K=1 (single liquidation) is unaffected: both caps agree ==");
{
  const single = simulateInsuranceDrawSequence(23n * POS_SCALE, 2500n, [3n * POS_SCALE]);
  ok(single.perDrawTotal === single.windowedTotal, "a single draw under the cap is identical under both schemes");
  ok(single.perDrawTotal === 3n * POS_SCALE, "single draw is granted in full when under 25% of the pool");
}

console.log("\n== perDrawCapAgainstCurrentBalance matches the on-chain formula shape ==");
{
  const cap = perDrawCapAgainstCurrentBalance(17_876_664n, 5_633_752n, 2500n);
  ok(cap === 4_469_166n, `min(shortfall, floor(ins*2500/10000)) — an oversized shortfall is clamped to the per-call cap (${cap})`);
  const under = perDrawCapAgainstCurrentBalance(100n * POS_SCALE, 1n * POS_SCALE, 2500n);
  ok(under === 1n * POS_SCALE, `shortfall under the cap passes through unclamped (${under})`);
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) { console.log("FAILURES:\n  " + failures.join("\n  ")); process.exit(1); }
console.log("OK — windowed cap bounds the #113 27-leg sequence's cumulative insurance draw to maxInsDrawBps of the pre-sequence balance.");
