/** Pure tests for src/lean/oracle-clamp.ts against an independent reference model of
 *  handleUpdateOracle (percolator-lean 9b45ad1, Percolator/Program.lean). No network. */
import test from "node:test";
import assert from "node:assert/strict";
import { clampPush, maxAllowedMove, effMaxMoveBps, keeperStepCap, stampsRamp, stampsRampPending } from "../../src/lean/oracle-clamp.js";

// ---------------------------------------------------------------- reference model (written from the Lean source,
// deliberately NOT sharing code with the module under test: slot-based, u64-checked, subtraction-based floor).
const U64 = (1n << 64n) - 1n;
const REF_BPS_DEN = 10_000n, REF_MAX_PRICE = 1_000_000_000_000n;
function refMulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  const prod = a * b, q = (prod - (prod % d)) / d;
  assert.ok(q <= U64, "mulDiv64 overflow");
  return q;
}
/** stamps = deployed 9b45ad1 rule (>= 75%); stampsPending = unreleased working-tree rule (>= 50%, inclusive) */
interface RefResult { ok: boolean; err?: string; maxAllowed: bigint; diff: bigint; remBudget: bigint; stamps: boolean; stampsPending: boolean }
/** Loaded market (isEmpty == false), built-in funding on (fundingCfg != 0), fundE6 == 0. */
function refUpdateOracle(oldPrice: bigint, newPrice: bigint, rawMaxMove: bigint, lastSlot: bigint, curSlot: bigint): RefResult {
  const z = { maxAllowed: 0n, diff: 0n, remBudget: 0n, stamps: false, stampsPending: false };
  if (!(curSlot > lastSlot)) return { ok: false, err: "oracleSameSlot", ...z };
  if (!(newPrice > 0n && newPrice <= REF_MAX_PRICE)) return { ok: false, err: "invalidParams", ...z };
  const diff = newPrice >= oldPrice ? newPrice - oldPrice : oldPrice - newPrice;
  const effMaxMove = curSlot === lastSlot + 1n && rawMaxMove > 1n ? rawMaxMove >> 1n : rawMaxMove;
  const maxAllowed = refMulDivFloor(oldPrice, effMaxMove, REF_BPS_DEN);
  if (!(diff <= maxAllowed)) return { ok: false, err: "oracleClamp", maxAllowed, diff, remBudget: 0n, stamps: false, stampsPending: false };
  const rampThresh = maxAllowed - maxAllowed / 4n;   // 9b45ad1: `maxAllowed - (maxAllowed >>> 2)`
  const rampThreshPending = maxAllowed / 2n;         // working tree: `maxAllowed >>> 1`
  return { ok: true, maxAllowed, diff, remBudget: maxAllowed - diff,
    stamps: maxAllowed > 0n && diff >= rampThresh, stampsPending: maxAllowed > 0n && diff >= rampThreshPending };
}
const LAST = 1_000n;
const ref = (mark: bigint, push: bigint, bps: bigint, dt: bigint) => refUpdateOracle(mark, push, bps, LAST, LAST + dt);

// seeded PRNG (mulberry32) so the fuzz is reproducible
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const abs = (x: bigint) => (x < 0n ? -x : x);

const MARKS = [1n, 2n, 3n, 99n, 100n, 101n, 199n, 200n, 399n, 400n, 401n, 9_999n, 10_000n, 10_001n, 123_456_789n,
  100_000_000n, 94_321_987_654n, 999_999_999_999n, REF_MAX_PRICE];
const BPS = [0n, 1n, 2n, 3n, 75n, 99n, 100n, 101n, 1499n, 1500n];
const DTS = [1n, 2n, 3n, 150n, 9_000n, 1_000_000n];

test("maxAllowedMove is the exact on-chain boundary: +0 accepted, +1 rejected (both directions, all dt)", () => {
  for (const mark of MARKS) for (const bps of BPS) for (const dt of DTS) {
    const ma = maxAllowedMove(mark, bps, dt);
    assert.equal(ma, ref(mark, mark, bps, dt).maxAllowed, `maxAllowed mark=${mark} bps=${bps} dt=${dt}`);
    for (const dir of [1n, -1n]) {
      const at = mark + dir * ma, over = mark + dir * (ma + 1n);
      if (at >= 1n && at <= REF_MAX_PRICE) assert.equal(ref(mark, at, bps, dt).ok, true, `exact boundary accepted mark=${mark} bps=${bps} dt=${dt} dir=${dir}`);
      if (over >= 1n && over <= REF_MAX_PRICE) assert.equal(ref(mark, over, bps, dt).err, "oracleClamp", `boundary+1 rejected mark=${mark} bps=${bps} dt=${dt} dir=${dir}`);
    }
  }
});

test("dt == 1 halves the BPS (floor), not the allowance; bps <= 1 is not halved; dt >= 2 is the full step", () => {
  assert.equal(effMaxMoveBps(100n, 1n), 50n);
  assert.equal(effMaxMoveBps(75n, 1n), 37n);
  assert.equal(effMaxMoveBps(3n, 1n), 1n);
  assert.equal(effMaxMoveBps(1n, 1n), 1n);
  assert.equal(effMaxMoveBps(0n, 1n), 0n);
  assert.equal(effMaxMoveBps(100n, 2n), 100n);
  assert.equal(effMaxMoveBps(100n, 0n), 50n); // dt 0 cannot land (oracleSameSlot); treated as the half step
  // 75 bps on 123_456_789: full = floor(925925.9175) = 925925; half uses 37 bps = floor(456790.1193) = 456790 (not 925925>>1 = 462962)
  assert.equal(maxAllowedMove(123_456_789n, 75n, 2n), 925_925n);
  assert.equal(maxAllowedMove(123_456_789n, 75n, 1n), 456_790n);
  assert.equal(ref(123_456_789n, 123_456_789n + 456_790n, 75n, 1n).ok, true);
  assert.equal(ref(123_456_789n, 123_456_789n + 456_791n, 75n, 1n).err, "oracleClamp");
});

test("regression: the old hard-coded mark*99/100 clamp is off by one at a non-divisible mark (rejected on-chain)", () => {
  const mark = 123_456_789n, bps = 100n;
  const oldDn = (mark * 99n) / 100n; // 122_222_221 -> diff 1_234_568
  assert.equal(maxAllowedMove(mark, bps, 2n), 1_234_567n);
  assert.equal(ref(mark, oldDn, bps, 2n).err, "oracleClamp");
  // and the old clamp ignored Market.maxMoveBps entirely: on a 75 bps market its +1% push is rejected too
  assert.equal(ref(mark, (mark * 101n) / 100n, 75n, 2n).err, "oracleClamp");
  for (const b of [100n, 75n]) for (const tgt of [1n, REF_MAX_PRICE]) {
    const r = ref(mark, clampPush(mark, tgt, b, 2n), b, 2n);
    assert.equal(r.ok, true);
    assert.equal(r.stamps, false);
    assert.equal(r.stampsPending, false);
  }
});

test("keeper step: far target moves exactly (maxAllowed >> 1) - 1, never stamps the ramp, leaves > 50% funding budget", () => {
  for (const mark of MARKS) for (const bps of BPS) for (const dt of DTS) {
    const ma = maxAllowedMove(mark, bps, dt), cap = keeperStepCap(ma);
    for (const target of [1n, REF_MAX_PRICE]) {
      const push = clampPush(mark, target, bps, dt);
      const r = ref(mark, push, bps, dt);
      assert.equal(r.ok, true, `accepted mark=${mark} bps=${bps} dt=${dt} target=${target}`);
      const gap = abs(target - mark);
      assert.equal(r.diff, gap < cap ? gap : cap, `step = min(gap, cap) mark=${mark} bps=${bps} dt=${dt}`);
      if (ma >= 4n) {
        assert.equal(cap, (ma >> 1n) - 1n);
        assert.equal(r.stamps, false, `no ramp stamp (deployed rule) mark=${mark} bps=${bps} dt=${dt}`);
        assert.equal(r.stampsPending, false, `no ramp stamp (pending 50% rule) mark=${mark} bps=${bps} dt=${dt}`);
        assert.ok(2n * r.remBudget > ma, "more than half of maxAllowed left for funding");
        assert.equal(stampsRamp(ma, r.diff), false);
        assert.equal(stampsRampPending(ma, r.diff), false);
        if (ma >= 6n && mark + cap + 1n <= REF_MAX_PRICE) assert.equal(ref(mark, mark + cap + 1n, bps, dt).stampsPending, true, "cap is the LARGEST step that is ramp-free under the pending rule");
      }
      if (ma >= 2n) assert.equal(r.stamps, false, `deployed rule: no stamp for maxAllowed >= 2 mark=${mark} bps=${bps} dt=${dt}`);
    }
  }
});

test("degenerate tiny allowance (maxAllowed 0..3): documented behaviour", () => {
  assert.equal(keeperStepCap(0n), 0n); // price cannot move at all
  assert.equal(keeperStepCap(1n), 1n); // minimal progress (the only possible move; stamps under both rules)
  assert.equal(keeperStepCap(2n), 1n);
  assert.equal(keeperStepCap(3n), 1n);
  assert.equal(keeperStepCap(4n), 1n); // pending threshold 2: 1 is ramp-free
  assert.equal(keeperStepCap(5n), 1n);
  assert.equal(keeperStepCap(6n), 2n);
  // deployed 9b45ad1 rule: diff >= maxAllowed - (maxAllowed >> 2)
  assert.equal(stampsRamp(0n, 0n), false);
  assert.equal(stampsRamp(1n, 0n), false);
  assert.equal(stampsRamp(1n, 1n), true);
  assert.equal(stampsRamp(2n, 1n), false);
  assert.equal(stampsRamp(3n, 1n), false);
  assert.equal(stampsRamp(1_234_444n, 925_832n), false);
  assert.equal(stampsRamp(1_234_444n, 925_833n), true); // 1_234_444 - 308_611
  // pending rule: diff >= maxAllowed >> 1 (inclusive; at maxAllowed == 1 even a zero move stamps)
  assert.equal(stampsRampPending(0n, 0n), false);
  assert.equal(stampsRampPending(1n, 0n), true);
  assert.equal(stampsRampPending(3n, 1n), true);
  assert.equal(stampsRampPending(4n, 1n), false);
  assert.equal(stampsRampPending(4n, 2n), true);
  // mark 99 @ 100 bps: maxAllowed 0 -> hold; mark 250 @ 100 bps: maxAllowed 2 -> 1-unit step, accepted
  assert.equal(clampPush(99n, 1_000_000n, 100n, 2n), 99n);
  assert.equal(clampPush(250n, 1_000_000n, 100n, 2n), 251n);
  assert.equal(ref(250n, 251n, 100n, 2n).ok, true);
  assert.equal(clampPush(250n, 1n, 100n, 2n), 249n);
});

test("near target is pushed exactly; price stays inside [1, MAX_PRICE]; bad inputs throw", () => {
  const mark = 94_321_987_654n; // ~$94,321.99, maxAllowed @100bps = 943_219_876, cap = 471_609_937
  assert.equal(keeperStepCap(maxAllowedMove(mark, 100n, 2n)), 471_609_937n);
  assert.equal(clampPush(mark, mark, 100n, 2n), mark);
  assert.equal(clampPush(mark, mark + 471_609_937n, 100n, 2n), mark + 471_609_937n);
  assert.equal(clampPush(mark, mark + 471_609_938n, 100n, 2n), mark + 471_609_937n);
  assert.equal(clampPush(mark, mark - 5n, 100n, 2n), mark - 5n);
  assert.equal(clampPush(mark, mark - 471_609_938n, 100n, 2n), mark - 471_609_937n);
  // half step at dt 1: maxAllowed = floor(mark*50/10000) = 471_609_938 -> cap 235_804_968
  assert.equal(clampPush(mark, REF_MAX_PRICE, 100n, 1n), mark + 235_804_968n);
  // MAX_PRICE ceiling / 1 floor
  assert.equal(clampPush(REF_MAX_PRICE, REF_MAX_PRICE * 5n, 100n, 2n), REF_MAX_PRICE);
  assert.equal(clampPush(REF_MAX_PRICE - 3n, REF_MAX_PRICE * 5n, 100n, 2n), REF_MAX_PRICE);
  assert.equal(clampPush(1n, 1n, 1500n, 2n), 1n);
  assert.throws(() => clampPush(mark, 0n, 100n, 2n), RangeError);
  assert.throws(() => clampPush(mark, -1n, 100n, 2n), RangeError);
  assert.throws(() => clampPush(0n, 5n, 100n, 2n), RangeError);
  assert.throws(() => maxAllowedMove(mark, -1n, 2n), RangeError);
});

test("a push computed for dt <= 1 is also accepted if it lands later (dt lower bound is safe)", () => {
  for (const mark of MARKS) for (const bps of BPS) for (const target of [1n, REF_MAX_PRICE]) {
    const push = clampPush(mark, target, bps, 1n);
    for (const dt of DTS) assert.equal(ref(mark, push, bps, dt).ok, true);
  }
});

test("fuzz invariants (seeded): within [mark-maxAllowed, mark+maxAllowed], toward the target, never overshoots, accepted on-chain model", () => {
  const rnd = rng(0xC1A4_9B45);
  const big = (max: bigint) => { // log-uniform-ish in [1, max]
    const bits = 1 + Math.floor(rnd() * max.toString(2).length);
    let v = 0n; for (let i = 0; i < bits; i++) v = (v << 1n) | (rnd() < 0.5 ? 1n : 0n);
    return v < 1n ? 1n : v > max ? max : v;
  };
  for (let i = 0; i < 50_000; i++) {
    const mark = big(REF_MAX_PRICE);
    const bps = BigInt(Math.floor(rnd() * 1501));
    const dt = rnd() < 0.3 ? 1n : BigInt(1 + Math.floor(rnd() * 20_000));
    const mode = rnd();
    const target = mode < 0.4 ? big(REF_MAX_PRICE * 4n)                       // anywhere (incl. above MAX_PRICE)
      : (() => { const d = big(mark / 50n + 2n) - 1n, t = rnd() < 0.5 ? mark + d : mark - d; return t < 1n ? 1n : t; })(); // near the mark
    const push = clampPush(mark, target, bps, dt);
    const ma = maxAllowedMove(mark, bps, dt);
    const ctx = `mark=${mark} target=${target} bps=${bps} dt=${dt} push=${push}`;
    assert.ok(push >= 1n && push <= REF_MAX_PRICE, `price range: ${ctx}`);
    assert.ok(push >= mark - ma && push <= mark + ma, `within clamp: ${ctx}`);
    const tgt = target > REF_MAX_PRICE ? REF_MAX_PRICE : target;
    if (tgt >= mark) assert.ok(push >= mark && push <= tgt, `toward/no overshoot (up): ${ctx}`);
    else assert.ok(push <= mark && push >= tgt, `toward/no overshoot (down): ${ctx}`);
    const r = ref(mark, push, bps, dt);
    assert.equal(r.ok, true, `reference accepts: ${ctx}`);
    if (ma >= 4n) assert.equal(r.stamps || r.stampsPending, false, `no ramp stamp (either rule): ${ctx}`);
    if (ma >= 2n) assert.equal(r.stamps, false, `no ramp stamp (deployed rule): ${ctx}`);
    if (ma >= 4n && abs(tgt - mark) > (ma >> 1n)) assert.equal(r.diff, (ma >> 1n) - 1n, `far target takes the full keeper step: ${ctx}`);
    if (push !== tgt && ma > 0n) assert.ok(abs(tgt - push) < abs(tgt - mark), `strict progress: ${ctx}`);
  }
});

test("repeated pushes converge on the target without ever stamping the ramp", () => {
  for (const [start, target] of [[60_000_000_000n, 94_321_987_654n], [94_321_987_654n, 60_000_000_000n]] as const) {
    let mark: bigint = start, n = 0;
    while (mark !== target) {
      const push = clampPush(mark, target, 100n, 5n);
      const r = ref(mark, push, 100n, 5n);
      assert.equal(r.ok, true);
      assert.equal(r.stamps || r.stampsPending, false);
      mark = push;
      assert.ok(++n < 1_000, "converges");
    }
    assert.ok(n > 80 && n < 120, `~0.5%/push: ${n} pushes`);
  }
});
