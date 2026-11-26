/**
 * Offline reproduction of the Round-2 multi-step self-liquidation drain
 * (20 sequential liquidations, each under the per-draw cap individually,
 * compounding to ~98.71% of the insurance pool) and a check that
 * `InsuranceDrawWindow` bounds the same sequence to `maxInsDrawBps` of the
 * balance observed at the start of the sequence. No network/RPC required.
 *
 *   pnpm test:guards
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

// ---- Round-2 bounty-market parameters and reported numbers ----
const START_INSURANCE = 70n * POS_SCALE; // $70.00
const CAP_BPS = 2500n; // maxInsDrawBps
const SHORTFALL = 5_410_000n; // ~$5.41 per losing leg, per the report
const N = 20;

console.log("== reproduce the reported drain (per-draw cap vs. live depleting balance) ==");
const shortfalls = Array(N).fill(SHORTFALL);
const result = simulateInsuranceDrawSequence(START_INSURANCE, CAP_BPS, shortfalls);
const drainedPct = Number((result.perDrawTotal * 10_000n) / START_INSURANCE) / 100;
console.log(`  perDrawTotal=${Number(result.perDrawTotal) / 1e6} remaining=${Number(result.perDrawRemaining) / 1e6} (${drainedPct}% drained)`);
ok(drainedPct > 95, `per-draw-against-current-balance cap lets ${N} sequential liquidations drain >95% of a $70 pool (got ${drainedPct}%)`);
ok(result.perDrawRemaining < 1n * POS_SCALE, `less than $1 of insurance survives the sequence under the deployed cap (remaining=${Number(result.perDrawRemaining) / 1e6})`);

console.log("\n== InsuranceDrawWindow bounds the same sequence to maxInsDrawBps of the window start ==");
const expectedCap = (START_INSURANCE * CAP_BPS) / BPS_DEN; // 25% of $70 = $17.50
ok(result.windowedCap === expectedCap, `windowed cap == floor(windowStart * capBps / BPS_DEN) (${result.windowedCap} == ${expectedCap})`);
ok(result.windowedTotal === expectedCap, `cumulative windowed draw saturates at the cap, never above it (${result.windowedTotal} == ${expectedCap})`);
ok(result.windowedTotal < result.perDrawTotal, `windowed total (${Number(result.windowedTotal) / 1e6}) is strictly less than the unguarded per-draw total (${Number(result.perDrawTotal) / 1e6})`);

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
  const single = simulateInsuranceDrawSequence(70n * POS_SCALE, 2500n, [3n * POS_SCALE]);
  ok(single.perDrawTotal === single.windowedTotal, "a single draw under the cap is identical under both schemes");
  ok(single.perDrawTotal === 3n * POS_SCALE, "single draw is granted in full when under 25% of the pool");
}

console.log("\n== perDrawCapAgainstCurrentBalance matches the on-chain formula shape ==");
{
  const cap = perDrawCapAgainstCurrentBalance(64_590_000n, 5_410_000n, 2500n);
  ok(cap === 5_410_000n, `min(shortfall, floor(ins*bps/den)) — shortfall under cap passes through (${cap})`);
  const capped = perDrawCapAgainstCurrentBalance(16_010_000n, 5_410_000n, 2500n);
  ok(capped === 4_002_500n, `shortfall over cap is clamped to floor(ins*2500/10000) (${capped})`);
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length) { console.log("FAILURES:\n  " + failures.join("\n  ")); process.exit(1); }
console.log("OK — windowed cap bounds cumulative insurance draw to maxInsDrawBps of the window-start balance.");
