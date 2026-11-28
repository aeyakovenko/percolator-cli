/** Pure tests (no network) for the quote-keeper trigger (src/lean/quote-trigger.ts) and the spot guard
 *  (src/lean/spot-source.ts), plus a REPLAY of the trigger over ~25 h of real 1-minute BTC-USD closes
 *  (tests/lean/fixtures/btc-usd-1m-25h.json, fetched once from the public Coinbase Exchange candles API). */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import {
  decidePush, heartbeatAgeSlots, alarmAgeSlots, rampFreeStep, gapBpsOf, thresholdE2, type TriggerState, type Decision,
  DEFAULT_THRESHOLD_BPS, DEFAULT_HEARTBEAT_FRACTION, DEFAULT_MIN_INTERVAL_MS, DEFAULT_MAX_PUSHES_PER_HOUR, URGENT_MULT, RELEASE_NUM, RELEASE_DEN, AGE_ALARM_FRACTION,
} from "../../src/lean/quote-trigger.js";
import { maxAllowedMove, stampsRampPending, stampsRamp, keeperStepCap } from "../../src/lean/oracle-clamp.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { QuoteKeeper, maskSecrets } from "../../src/lean/quote-keeper.js";
import { MAGIC, MARKET_SIZE, MktOff } from "../../src/lean/constants.js";
import type { SpotSource } from "../../src/lean/spot-source.js";
import { SpotGuard, parseCoinbaseTicker, parseKrakenTicker, parseCoinbaseV2Spot, backoffSource, DEFAULT_SPOT_GUARD, type SourceReading } from "../../src/lean/spot-source.js";

const MAX_PRICE = 1_000_000_000_000n;
const abs = (x: bigint) => (x < 0n ? -x : x);
const P0 = 60_000_000_000n; // $60,000 (E6)
const bpsOf = (p: bigint, b: number) => p + (p * BigInt(Math.round(b * 100))) / 1_000_000n;
/** a calm, fresh, loaded-market state: 100 bps maxMove, 9000-slot staleness, last push 50 slots ago */
const base = (o: Partial<TriggerState> = {}): TriggerState => ({
  mark: P0, spot: P0, maxMoveBps: 100n, thresholdBps: 10, lastOracleSlot: 1_000n, currentSlot: 1_050n,
  maxStalenessSlots: 9_000n, nowMs: 1_000_000, lastPushMs: null, minIntervalMs: 10_000, ...o,
});

test("constants: the exported rule set", () => {
  assert.equal(DEFAULT_THRESHOLD_BPS, 10);
  assert.equal(DEFAULT_HEARTBEAT_FRACTION, 0.4);
  assert.equal(AGE_ALARM_FRACTION, 0.8);
  assert.equal(URGENT_MULT, 2n);
  assert.equal(RELEASE_NUM * 2n, RELEASE_DEN);
  assert.equal(DEFAULT_MIN_INTERVAL_MS, 10_000);
  assert.ok(DEFAULT_MAX_PUSHES_PER_HOUR >= 60);
  assert.equal(thresholdE2(10), 1000n);
  assert.throws(() => thresholdE2(0));
  assert.throws(() => thresholdE2(NaN));
});

test("threshold: no push below it, snap exactly to spot at/above it (both directions)", () => {
  for (const dir of [1, -1]) {
    const below = decidePush(base({ spot: bpsOf(P0, dir * 9.99) }));
    assert.equal(below.push, null); assert.equal(below.reason, "within-threshold");
    const at = decidePush(base({ spot: bpsOf(P0, dir * 10) }));
    assert.equal(at.push, bpsOf(P0, dir * 10)); assert.equal(at.reason, "gap"); assert.equal(at.capped, false);
    const big = decidePush(base({ spot: bpsOf(P0, dir * 25) }));
    assert.equal(big.push, bpsOf(P0, dir * 25)); assert.equal(big.reason, "gap-urgent");
  }
  // fractional thresholds are exact
  assert.equal(decidePush(base({ thresholdBps: 2.5, spot: bpsOf(P0, 2.49) })).push, null);
  assert.equal(decidePush(base({ thresholdBps: 2.5, spot: bpsOf(P0, 2.5) })).push, bpsOf(P0, 2.5));
});

test("hysteresis: a push lands ON spot, so noise inside +-threshold around it never re-triggers (no ping-pong, no dribbling)", () => {
  let mark = P0, pushes = 0, slot = 1_050n, last = 1_000n;
  // spot oscillates +12 / +3 / +12 / +3 ... bps around P0: one push to +12, then |gap| = 9 bps of noise -> nothing
  for (let i = 0; i < 200; i++) {
    const spot = bpsOf(P0, i % 2 === 0 ? 12 : 3);
    const d = decidePush(base({ mark, spot, currentSlot: slot, lastOracleSlot: last, nowMs: 1_000_000 + i * 2_000, lastPushMs: pushes ? 1_000_000 : null }));
    if (d.push !== null) { mark = d.push; last = slot; pushes++; }
    slot += 5n;
  }
  assert.equal(pushes, 1);
  assert.equal(mark, bpsOf(P0, 12));
  // tiny gaps are never pushed, however long they persist (liveness aside)
  for (const g of [0.01, 1, 5, 9.9]) assert.equal(decidePush(base({ spot: bpsOf(P0, g), currentSlot: 1_000n + 3_599n })).push, null);
});

/** drive the trigger like the daemon would: one decision per slot until it settles */
function settle(st: TriggerState, maxSlots = 50): { pushes: Decision[]; mark: bigint; slots: bigint; waits: number } {
  let mark = st.mark, last = st.lastOracleSlot, slot = st.currentSlot, catchUp = st.catchUp ?? false, lastPushMs = st.lastPushMs, waits = 0;
  const pushes: Decision[] = [];
  for (let i = 0; i < maxSlots; i++) {
    const d = decidePush({ ...st, mark, lastOracleSlot: last, currentSlot: slot, catchUp, lastPushMs, nowMs: st.nowMs + i * 400 });
    if (d.push !== null) {
      const ma = maxAllowedMove(mark, st.maxMoveBps, slot - last < 2n ? 1n : slot - last);
      assert.ok(!stampsRampPending(ma, abs(d.push - mark)), "step stamps the ramp");
      pushes.push(d); mark = d.push; last = slot; catchUp = d.capped; lastPushMs = st.nowMs + i * 400;
    } else if (d.reason === "wait-dt" || d.reason === "same-slot") waits++;
    else break;
    slot += 1n;
  }
  return { pushes, mark, slots: slot - st.currentSlot, waits };
}

test("multi-step: -60 bps = exactly 2 capped ramp-free steps, back to back; +120 bps = 3 steps using the dt rule", () => {
  const a = settle(base({ spot: bpsOf(P0, -60) }));
  assert.equal(a.pushes.length, 2);
  assert.equal(a.pushes[0].reason, "gap-urgent"); assert.equal(a.pushes[0].capped, true);
  // first step is the full ramp-free step at dt >= 2: (floor(mark * 100 / 1e4) >> 1) - 1
  assert.equal(P0 - a.pushes[0].push!, (maxAllowedMove(P0, 100n, 50n) >> 1n) - 1n);
  assert.equal(a.pushes[1].reason, "catch-up"); assert.equal(a.pushes[1].capped, false);
  assert.equal(a.mark, bpsOf(P0, -60));
  assert.ok(a.slots <= 3n, `2 steps done within ${a.slots} slots`);

  const b = settle(base({ spot: bpsOf(P0, 120) }));
  assert.equal(b.pushes.length, 3, "50 + 50 + 20");
  assert.equal(b.mark, bpsOf(P0, 120));
  assert.ok(b.waits >= 1, "waited for dt >= 2 instead of taking a half step");
  assert.ok(b.slots <= 6n, `3 steps done within ${b.slots} slots`);

  // dt rule in isolation: 1 slot after a push a 40 bps gap does not fit the ~25 bps half step -> wait; 20 bps fits -> push
  const w = decidePush(base({ spot: bpsOf(P0, 40), lastOracleSlot: 1_049n }));
  assert.equal(w.push, null); assert.equal(w.reason, "wait-dt"); assert.equal(w.soon, true);
  const f = decidePush(base({ spot: bpsOf(P0, 20), lastOracleSlot: 1_049n, lastPushMs: null }));
  assert.equal(f.push, bpsOf(P0, 20));
  // one slot later the full step is available
  assert.equal(decidePush(base({ spot: bpsOf(P0, 40), lastOracleSlot: 1_048n })).push, bpsOf(P0, 40));
});

test("catch-up: the remainder of a capped move is pushed even below the threshold, down to the release band", () => {
  const rest = (g: number, catchUp: boolean) => decidePush(base({ spot: bpsOf(P0, g), catchUp, lastPushMs: 999_999, lastOracleSlot: 1_048n }));
  assert.equal(rest(7, true).reason, "catch-up"); assert.equal(rest(7, true).push, bpsOf(P0, 7));
  assert.equal(rest(5, true).reason, "catch-up");            // exactly threshold / 2
  assert.equal(rest(4.99, true).push, null);                 // inside the release band: done
  assert.equal(rest(7, false).push, null);                   // without catch-up a 7 bps gap is noise
});

test("same slot: never push in the slot of the previous push (oracleSameSlot 126)", () => {
  const d = decidePush(base({ spot: bpsOf(P0, 30), lastOracleSlot: 1_050n }));
  assert.equal(d.push, null); assert.equal(d.reason, "same-slot"); assert.equal(d.soon, true);
  assert.equal(decidePush(base({ spot: bpsOf(P0, 30), lastOracleSlot: 2_000n })).reason, "same-slot"); // clock behind the account
});

test("liveness: push at age >= fraction * maxStaleness even when the gap is tiny or zero; never earlier", () => {
  assert.equal(heartbeatAgeSlots(9_000n), 3_600n);
  assert.equal(heartbeatAgeSlots(300n), 120n);
  assert.equal(heartbeatAgeSlots(150n), 60n);
  assert.equal(heartbeatAgeSlots(151n), 61n); // ceil
  assert.equal(heartbeatAgeSlots(1n), 1n);
  assert.equal(alarmAgeSlots(150n), 120n);
  assert.throws(() => heartbeatAgeSlots(100n, 1));
  for (const ms of [150n, 300n, 900n, 9_000n]) {
    const due = heartbeatAgeSlots(ms);
    const early = decidePush(base({ maxStalenessSlots: ms, spot: bpsOf(P0, 3), currentSlot: 1_000n + due - 1n }));
    assert.equal(early.push, null); assert.equal(early.livenessDue, false);
    const d = decidePush(base({ maxStalenessSlots: ms, spot: bpsOf(P0, 3), currentSlot: 1_000n + due }));
    assert.equal(d.reason, "liveness"); assert.equal(d.push, bpsOf(P0, 3)); assert.equal(d.livenessDue, true);
    const z = decidePush(base({ maxStalenessSlots: ms, spot: P0, currentSlot: 1_000n + due }));
    assert.equal(z.reason, "liveness"); assert.equal(z.push, P0, "an unchanged price is a valid liveness push");
  }
  // configurable fraction
  assert.equal(decidePush(base({ heartbeatFraction: 0.75, currentSlot: 1_000n + 6_749n })).push, null);
  assert.equal(decidePush(base({ heartbeatFraction: 0.75, currentSlot: 1_000n + 6_750n })).reason, "liveness");
  // already stale: still pushes (that is what revives the market)
  assert.equal(decidePush(base({ currentSlot: 1_000n + 50_000n, spot: bpsOf(P0, 2) })).reason, "liveness");
});

test("no spot: the price never moves; liveness may only HOLD at the caller-approved last good spot", () => {
  const due = 1_000n + 3_600n;
  assert.equal(decidePush(base({ spot: null })).reason, "no-spot");
  assert.equal(decidePush(base({ spot: null, holdTarget: P0 })).push, null, "hold is not due yet");
  const nohold = decidePush(base({ spot: null, currentSlot: due, holdTarget: null }));
  assert.equal(nohold.push, null); assert.equal(nohold.reason, "no-spot"); assert.equal(nohold.livenessDue, true);
  const hold = decidePush(base({ spot: null, currentSlot: due, holdTarget: P0 }));
  assert.equal(hold.reason, "liveness-hold"); assert.equal(hold.push, P0);
  // hold target a little away from mark: steps toward it, clamped and ramp-free
  const h2 = decidePush(base({ spot: null, currentSlot: due, holdTarget: bpsOf(P0, 80) }));
  assert.equal(h2.reason, "liveness-hold");
  assert.equal(h2.push! - P0, (maxAllowedMove(P0, 100n, 3_600n) >> 1n) - 1n);
});

test("minimum interval: delays only small gaps (<= 2 x threshold); urgent gaps, catch-up and liveness are never delayed", () => {
  const recent = { nowMs: 1_000_000, lastPushMs: 1_000_000 - 9_999 };
  const small = decidePush(base({ ...recent, spot: bpsOf(P0, 15) }));
  assert.equal(small.push, null); assert.equal(small.reason, "min-interval");
  assert.equal(decidePush(base({ ...recent, spot: bpsOf(P0, 20) })).reason, "min-interval", "exactly 2 x threshold is still 'small'");
  assert.equal(decidePush(base({ nowMs: 1_000_000, lastPushMs: 1_000_000 - 10_000, spot: bpsOf(P0, 15) })).reason, "gap");
  assert.equal(decidePush(base({ ...recent, spot: bpsOf(P0, 20.01) })).reason, "gap-urgent");
  assert.equal(decidePush(base({ ...recent, spot: bpsOf(P0, -45) })).reason, "gap-urgent");
  assert.equal(decidePush(base({ ...recent, spot: bpsOf(P0, 8), catchUp: true })).reason, "catch-up");
  assert.equal(decidePush(base({ ...recent, spot: bpsOf(P0, 15), currentSlot: 1_000n + 3_600n })).reason, "liveness");
  assert.equal(decidePush(base({ lastPushMs: null, spot: bpsOf(P0, 15) })).reason, "gap", "no previous push: nothing to wait for");
});

test("brake: suppresses every price push but keeps liveness", () => {
  for (const g of [10, 25, 60, -300]) {
    const d = decidePush(base({ brake: true, spot: bpsOf(P0, g) }));
    assert.equal(d.push, null); assert.equal(d.reason, "brake");
  }
  assert.equal(decidePush(base({ brake: true, catchUp: true, spot: bpsOf(P0, 8) })).reason, "brake");
  const l = decidePush(base({ brake: true, spot: bpsOf(P0, 60), currentSlot: 1_000n + 3_600n }));
  assert.equal(l.reason, "liveness"); assert.notEqual(l.push, null);
});

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test("fuzz: every push is accepted on-chain at ANY landing slot >= the read slot, never overshoots, never stamps the ramp", () => {
  const r = rng(20261128);
  let pushes = 0;
  for (let i = 0; i < 60_000; i++) {
    const mark = BigInt(Math.floor(10 ** (r() * 12))) + 1n;
    const spot = r() < 0.1 ? mark : BigInt(Math.max(1, Math.round(Number(mark) * (1 + (r() - 0.5) * (r() < 0.5 ? 0.004 : 0.2)))));
    const maxMoveBps = [1n, 2n, 3n, 50n, 99n, 100n, 101n, 500n, 2500n][Math.floor(r() * 9)];
    const age = [0n, 1n, 2n, 3n, 59n, 60n, 120n, 3_600n, 9_001n][Math.floor(r() * 9)];
    const st = base({ mark, spot, maxMoveBps, lastOracleSlot: 1_000n, currentSlot: 1_000n + age, maxStalenessSlots: [150n, 9_000n][Math.floor(r() * 2)],
      thresholdBps: [2, 5, 10, 20][Math.floor(r() * 4)], catchUp: r() < 0.3, lastPushMs: r() < 0.5 ? null : 999_000, brake: r() < 0.05 });
    const d = decidePush(st);
    if (d.push === null) continue;
    pushes++;
    assert.ok(age >= 1n, "pushed in the same slot");
    assert.ok(d.push >= 1n && d.push <= MAX_PRICE, "price out of the program's range");
    const diff = abs(d.push - mark), gap = abs(spot - mark);
    assert.ok(diff <= gap, `overshoot mark=${mark} spot=${spot} push=${d.push}`);
    if (diff > 0n) assert.equal(d.push > mark, spot > mark, "wrong direction");
    assert.equal(d.capped, diff > 0n && d.push !== (spot > MAX_PRICE ? MAX_PRICE : spot));
    for (const landDt of [age, age + 1n, age + 2n, age + 500n]) {            // lands at or after the slot we read
      const ma = maxAllowedMove(mark, maxMoveBps, landDt);
      assert.ok(diff <= ma, `oracleClamp at landing dt ${landDt}: mark=${mark} push=${d.push} bps=${maxMoveBps}`);
      if (diff > 0n) assert.ok(!stampsRampPending(ma, diff) && !stampsRamp(ma, diff), `stamps ramp at landing dt ${landDt}: mark=${mark} push=${d.push} bps=${maxMoveBps} ma=${ma}`);
    }
    if (diff === 0n) assert.ok(d.reason === "liveness", `a zero move is only ever a liveness push, got ${d.reason}`);
  }
  assert.ok(pushes > 10_000, `fuzz exercised ${pushes} pushes`);
});

test("tiny marks: no ramp-free non-zero step exists (maxAllowed 1..3) -> price pushes refused, liveness holds the price", () => {
  // mark 100..399 at 100 bps => maxAllowed 1..3; keeperStepCap would take a stamping unit step
  for (const mark of [100n, 199n, 200n, 399n]) {
    const ma = maxAllowedMove(mark, 100n, 50n);
    assert.ok(ma >= 1n && ma <= 3n);
    assert.ok(stampsRampPending(ma, keeperStepCap(ma)), "the legacy unit step stamps here");
    assert.equal(rampFreeStep(ma), 0n);
    const d = decidePush(base({ mark, spot: mark + 50n }));
    assert.equal(d.push, null); assert.equal(d.reason, "no-ramp-free-step");
    const l = decidePush(base({ mark, spot: mark + 50n, currentSlot: 1_000n + 3_600n }));
    assert.equal(l.reason, "liveness"); assert.equal(l.push, mark);
    const allow = decidePush(base({ mark, spot: mark + 50n, allowRampStamp: true }));
    assert.equal(allow.push, mark + 1n);
  }
  // maxAllowed == 4 is the first allowance with a ramp-free unit step
  const ok = decidePush(base({ mark: 400n, spot: 450n }));
  assert.equal(ok.push, 401n); assert.equal(ok.capped, true);
  assert.ok(!stampsRampPending(maxAllowedMove(400n, 100n, 50n), 1n));
  // mark too small to move at all (maxAllowed 0): nothing but an unchanged liveness push
  assert.equal(decidePush(base({ mark: 50n, spot: 60n })).reason, "no-ramp-free-step");
  assert.equal(decidePush(base({ mark: 0n, spot: 60n })).reason, "bad-mark");
  assert.equal(gapBpsOf(101n, 100n, 100n), 100);
});

// ================================================================ spot guard
const rd = (price: number, now: number, ts: number | null = now): SourceReading => ({ price, tsMs: ts, fetchedMs: now });
const T0 = 1_800_000_000_000;

test("spot guard: two sources must agree; the spot is their midpoint", () => {
  const g = new SpotGuard();
  const v = g.evaluate({ coinbase: rd(60_000, T0), kraken: rd(60_012, T0) }, P0, T0);
  assert.equal(v.status, "ok"); assert.equal(v.spot, 60_006_000_000n);
  // 30 bps apart is the limit; 31 is a disagreement -> no spot
  assert.equal(g.evaluate({ coinbase: rd(60_000, T0), kraken: rd(60_000 * 1.0029, T0) }, P0, T0).status, "ok");
  const d = new SpotGuard().evaluate({ coinbase: rd(60_000, T0), kraken: rd(60_000 * 1.0031, T0) }, P0, T0);
  assert.equal(d.status, "disagree"); assert.equal(d.spot, null);
  assert.equal(DEFAULT_SPOT_GUARD.agreeBps, 30);
});

test("spot guard: non-finite, out-of-range and stale readings are dropped", () => {
  for (const bad of [NaN, Infinity, -Infinity, 0, -5, 0.5, 2_000_000]) {
    const v = new SpotGuard().evaluate({ coinbase: rd(bad, T0), kraken: rd(bad, T0) }, P0, T0);
    assert.equal(v.spot, null, `price ${bad}`); assert.equal(v.status, "none");
  }
  const custom = new SpotGuard({ minPrice: 10_000, maxPrice: 500_000 });
  assert.equal(custom.evaluate({ a: rd(9_999, T0), b: rd(9_999, T0) }, 9_999_000_000n, T0).spot, null);
  // receipt older than maxAgeMs / venue timestamp older than maxSourceAgeMs
  assert.equal(new SpotGuard().evaluate({ a: { price: 60_000, tsMs: null, fetchedMs: T0 - 10_001 }, b: { price: 60_000, tsMs: null, fetchedMs: T0 - 10_001 } }, P0, T0).status, "none");
  assert.equal(new SpotGuard().evaluate({ a: rd(60_000, T0, T0 - 60_001), b: rd(60_000, T0, T0 - 60_001) }, P0, T0).status, "none");
  // a timestamp-less source frozen for longer than stuckMs is dropped
  const g = new SpotGuard({ stuckMs: 5_000 });
  assert.equal(g.evaluate({ a: rd(60_000, T0, null), b: rd(60_001, T0) }, P0, T0).status, "ok");
  const stuck = g.evaluate({ a: rd(60_000, T0 + 6_000, null), b: rd(60_002, T0 + 6_000) }, P0, T0 + 6_000);
  assert.equal(stuck.status, "single"); assert.deepEqual(stuck.used, ["b"]);
});

test("spot guard: a single live source is used only for small gaps", () => {
  const ok = new SpotGuard().evaluate({ coinbase: rd(60_000 * 1.0015, T0), kraken: null }, P0, T0);
  assert.equal(ok.status, "single"); assert.equal(ok.spot, 60_090_000_000n);
  const far = new SpotGuard().evaluate({ coinbase: rd(60_000 * 1.0031, T0), kraken: null }, P0, T0);
  assert.equal(far.status, "single-gap"); assert.equal(far.spot, null);
  assert.equal(new SpotGuard().evaluate({ coinbase: null, kraken: null }, P0, T0).status, "none");
});

test("spot guard: a wild print needs confirmation on the next poll; an unconfirmed one is dropped", () => {
  const g = new SpotGuard();
  const both = (p: number, t: number) => g.evaluate({ coinbase: rd(p, t), kraken: rd(p + 1, t) }, P0, t);
  assert.equal(both(60_000, T0).status, "ok");
  const wild = both(60_000 * 1.006, T0 + 2_000);               // +60 bps in one poll, both venues
  assert.equal(wild.status, "jump-pending"); assert.equal(wild.spot, null);
  assert.equal(both(60_000, T0 + 4_000).status, "ok", "it was a single wild print: back to normal, nothing pushed");
  // a real jump: confirmed by the following poll
  assert.equal(both(60_000 * 1.006, T0 + 6_000).status, "jump-pending");
  const conf = both(60_000 * 1.0061, T0 + 8_000);
  assert.equal(conf.status, "ok"); assert.ok(conf.spot! > 60_350_000_000n);
  // two different wild values in a row do not confirm each other
  assert.equal(both(60_000 * 1.02, T0 + 10_000).status, "jump-pending");
  assert.equal(both(60_000 * 0.985, T0 + 12_000).status, "jump-pending");
  // a 50 bps move is not a 'jump'
  const g2 = new SpotGuard();
  g2.evaluate({ a: rd(60_000, T0), b: rd(60_000, T0) }, P0, T0);
  assert.equal(g2.evaluate({ a: rd(60_000 * 1.0049, T0), b: rd(60_000 * 1.0049, T0) }, P0, T0).status, "ok");
});

test("spot guard: sanity bound vs the on-chain mark (wrong market / units)", () => {
  const v = new SpotGuard().evaluate({ coinbase: rd(60_000, T0), kraken: rd(60_010, T0) }, 150_000_000n /* a $150 SOL market */, T0);
  assert.equal(v.status, "mark-gap"); assert.equal(v.spot, null); assert.equal(v.hold, null);
});

test("spot guard: outage hold = last good spot, only inside the safe-drift bound and the hold window", () => {
  const mk = () => { const g = new SpotGuard(); g.evaluate({ coinbase: rd(60_000, T0), kraken: rd(60_000, T0) }, P0, T0); return g; };
  // never had a spot -> no hold
  const fresh = new SpotGuard().evaluate({ coinbase: null, kraken: null }, P0, T0);
  assert.equal(fresh.hold, null); assert.match(fresh.holdWhy, /no last good spot/);
  // total outage shortly after a good spot -> hold at it
  const h = mk().evaluate({ coinbase: null, kraken: null }, P0, T0 + 30_000);
  assert.equal(h.spot, null); assert.equal(h.hold, P0);
  // sources disagree but the visible prints are within 100 bps of the last good spot -> hold
  const dis = mk().evaluate({ coinbase: rd(60_000, T0 + 2_000), kraken: rd(60_000 * 1.004, T0 + 2_000) }, P0, T0 + 2_000);
  assert.equal(dis.status, "disagree"); assert.equal(dis.hold, P0);
  // a visible print beyond the drift bound -> FAIL CLOSED (no hold)
  const far = mk().evaluate({ coinbase: rd(60_000, T0 + 2_000), kraken: rd(60_000 * 1.0101, T0 + 2_000) }, P0, T0 + 2_000);
  assert.equal(far.status, "disagree"); assert.equal(far.hold, null); assert.match(far.holdWhy, /kraken/);
  const single = mk().evaluate({ coinbase: rd(60_000 * 0.9899, T0 + 2_000), kraken: null }, P0, T0 + 2_000);
  assert.equal(single.status, "single-gap"); assert.equal(single.hold, null);
  // mark itself has drifted from the last good spot -> no hold
  assert.equal(mk().evaluate({ coinbase: null, kraken: null }, bpsOf(P0, 101), T0 + 2_000).hold, null);
  assert.equal(mk().evaluate({ coinbase: null, kraken: null }, bpsOf(P0, 99), T0 + 2_000).hold, P0);
  // the last good spot expires after maxHoldMs (default 10 min)
  assert.equal(mk().evaluate({ coinbase: null, kraken: null }, P0, T0 + 600_000).hold, P0);
  assert.equal(mk().evaluate({ coinbase: null, kraken: null }, P0, T0 + 600_001).hold, null);
  assert.equal(DEFAULT_SPOT_GUARD.holdDriftBps, 100);
});

test("payload parsers: Coinbase Exchange ticker, Kraken ticker, Coinbase v2 spot", () => {
  const cb = parseCoinbaseTicker({ ask: "59530.8", bid: "59530.79", price: "59530.79", time: "2026-11-28T17:08:47.683665863Z" }, 5);
  assert.equal(cb.price, (59530.8 + 59530.79) / 2); assert.equal(cb.tsMs, Date.parse("2026-11-28T17:08:47.683Z")); assert.equal(cb.fetchedMs, 5);
  assert.throws(() => parseCoinbaseTicker({ ask: "1", bid: "2", time: "2026-11-28T17:08:47Z" }, 0), /crossed/);
  assert.throws(() => parseCoinbaseTicker({ ask: "60500", bid: "60000", time: "2026-11-28T17:08:47Z" }, 0), /wider/);
  assert.throws(() => parseCoinbaseTicker({ ask: "60000", bid: "60000" }, 0), /time/);
  assert.throws(() => parseCoinbaseTicker({ message: "rate limited" }, 0));
  const kr = parseKrakenTicker({ error: [], result: { XXBTZUSD: { a: ["59533.70000", "1", "1.000"], b: ["59533.60000", "1", "1.000"], c: ["59533.6", "0.1"] } } }, 7);
  assert.ok(Math.abs(kr.price - 59533.65) < 1e-6); assert.equal(kr.tsMs, null);
  assert.throws(() => parseKrakenTicker({ error: ["EGeneral:Too many requests"] }, 0), /kraken/);
  assert.throws(() => parseKrakenTicker({ error: [], result: {} }, 0));
  assert.throws(() => parseKrakenTicker({ error: [], result: { X: { a: ["abc"], b: ["1"] } } }, 0));
  assert.equal(parseCoinbaseV2Spot({ data: { amount: "59535.005" } }, 1).price, 59535.005);
  assert.throws(() => parseCoinbaseV2Spot({ data: { amount: "NaN" } }, 1));
});

test("source wrapper: never throws, exponential backoff on errors, reset on success", async () => {
  let calls = 0, fail = true;
  const waits: number[] = [];
  const src = backoffSource("x", async (now) => { calls++; if (fail) throw new Error("boom"); return rd(1, now); }, { baseMs: 1_000, maxMs: 8_000, onError: (_n, _e, w) => waits.push(w) });
  let t = 0;
  assert.equal(await src.read(t), null); assert.equal(calls, 1);
  assert.equal(await src.read(t + 999), null); assert.equal(calls, 1, "backing off: no fetch");
  for (const w of [1_000, 2_000, 4_000, 8_000, 8_000]) { t += w; assert.equal(await src.read(t), null); }
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  fail = false; t += 8_000;
  assert.equal((await src.read(t))!.price, 1);
  fail = true; t += 1;
  assert.equal(await src.read(t), null);
  assert.equal(waits.at(-1), 1_000, "backoff restarts after a success");
});

// ================================================================ keeper loop against a fake RPC (dry mode, no network)
function fakeMarket(o: { mark: bigint; lastOracleSlot: bigint; status?: number; maxStaleness?: bigint; oracleAuth?: PublicKey }): Buffer {
  const b = Buffer.alloc(MARKET_SIZE);
  b.writeUInt32LE(MAGIC.MARKET, 0);
  b.writeUInt8(o.status ?? 0, MktOff.status);
  (o.oracleAuth ?? PublicKey.default).toBuffer().copy(b, MktOff.oracleAuth);
  b.writeBigUInt64LE(o.mark, MktOff.markPrice);
  b.writeBigUInt64LE(o.lastOracleSlot, MktOff.lastOracleSlot);
  b.writeBigUInt64LE(o.maxStaleness ?? 9_000n, MktOff.maxStaleness);
  b.writeBigUInt64LE(100n, MktOff.maxMoveBps);
  return b;
}
function fakeKeeper(o: { maxPushesPerHour?: number; oracle?: Keypair | null } = {}) {
  const w = { slot: 10_000, now: T0, mark: P0, lastOracleSlot: 9_990n, status: 0, maxStaleness: 9_000n, cb: 60_000 as number | null, kr: 60_000 as number | null, rpcDown: false, oracleAuth: PublicKey.default };
  const lines: string[] = [];
  const conn = { getAccountInfoAndContext: async () => { if (w.rpcDown) throw new Error("fetch failed https://x/?api-key=SECRETKEY123"); return { context: { slot: w.slot }, value: { data: fakeMarket(w) } }; } } as unknown as Connection;
  const src = (n: "cb" | "kr", label: string): SpotSource => ({ name: label, read: async (now) => (w[n] === null ? null : { price: w[n] as number, tsMs: now, fetchedMs: now }) });
  const k = new QuoteKeeper({ conn, programId: PublicKey.default, market: PublicKey.default, oracle: o.oracle ?? null, funder: null, sources: [src("cb", "coinbase"), src("kr", "kraken")],
    now: () => w.now, log: (l) => lines.push(l), config: { live: false, maxPushesPerHour: o.maxPushesPerHour ?? 120, minIntervalMs: 0 } });
  const step = async (slots = 5) => { w.slot += slots; w.now += slots * 400; return k.tick(); };
  return { w, k, lines, step };
}

test("keeper loop (dry, fake RPC): pushes on gap, shadows its own dry pushes, survives RPC errors with the key masked", async () => {
  const { w, k, lines, step } = fakeKeeper();
  assert.equal((await step()).kind, "skip");
  w.cb = 60_150; w.kr = 60_150;                                   // +25 bps
  const p = await step();
  assert.equal(p.kind, "push"); assert.equal(p.event!.price, 60_150_000_000n); assert.equal(p.event!.dry, true);
  assert.equal((await step()).reason, "within-threshold", "dry push is shadowed: no re-push while the chain is unchanged");
  assert.equal(k.stats.pushesTotal, 1);
  assert.ok(lines.some((l) => /^DRY push 60000\.00->60150\.00 gap 25\.00 bps reason gap-urgent/.test(l)), lines.join("\n"));
  w.rpcDown = true;
  const e = await step();
  assert.equal(e.kind, "error");
  assert.ok(lines.some((l) => l.includes("api-key=***")) && !lines.some((l) => l.includes("SECRETKEY123")), "RPC key must be masked in logs");
  w.rpcDown = false;
  assert.equal((await step()).kind, "skip", "loop recovers after a transient RPC error");
  assert.equal(maskSecrets("https://rpc/?api-key=abc-123&x=1 and api-key=zzz"), "https://rpc/?api-key=***&x=1 and api-key=***");
});

test("keeper loop: Resolved / WindDown markets and a wrong oracle key never push", async () => {
  for (const status of [1, 2, 3]) {
    const { w, k, lines, step } = fakeKeeper();
    w.status = status; w.cb = 60_150; w.kr = 60_150;
    for (let i = 0; i < 3; i++) assert.equal((await step()).kind, "idle");
    assert.equal(k.stats.pushesTotal, 0);
    assert.equal(lines.filter((l) => /not pushing/.test(l)).length, 1, "logged once, not every tick");
    w.status = 0; await step(); await step();                        // pushes again once Active (exactly once)
    assert.equal(k.stats.pushesTotal, 1);
  }
  const { w, k, step } = fakeKeeper({ oracle: Keypair.generate() });
  w.cb = 60_150; w.kr = 60_150;
  assert.equal((await step()).reason, "wrong-oracle-key");
  assert.equal(k.stats.pushesTotal, 0);
});

test("keeper loop: MAX_PUSHES_PER_HOUR brake stops price pushes, keeps liveness, releases after the hour", async () => {
  const { w, k, lines, step } = fakeKeeper({ maxPushesPerHour: 3 });
  let px = 60_000;
  const move = async (bps: number) => { px = Math.round(px * (1 + bps / 1e4) * 100) / 100; w.cb = px; w.kr = px; return step(); };
  for (let i = 0; i < 3; i++) assert.equal((await move(i % 2 ? -25 : 25)).kind, "push");
  const braked = await move(-25);
  assert.equal(braked.kind, "skip"); assert.equal(braked.reason, "brake");
  assert.equal(lines.filter((l) => /ALARM BRAKE/.test(l)).length, 1);
  for (let i = 0; i < 20; i++) await move(i % 2 ? 30 : -30);
  assert.equal(k.stats.pushesTotal, 3, "no price push while braking");
  // oracle (shadow) ages past 0.4 x maxStaleness -> liveness still pushes through the brake
  const l = await step(3_600);
  assert.equal(l.kind, "push"); assert.equal(l.reason, "liveness");
  // one hour after the first pushes the window clears
  w.now += 3_600_000;
  assert.equal((await move(25)).kind, "push");
  assert.ok(lines.some((x) => /brake released/.test(x)));
});

test("keeper loop: health code 1 above 0.8 x maxStaleness, 2 when stale, unavailable seconds counted; outage outside the drift bound = no push", async () => {
  const { w, k, lines, step } = fakeKeeper();
  w.maxStaleness = 150n;
  await step(5);                                                    // age 15, spot accepted
  assert.equal(k.health().code, 0);
  w.cb = 61_000; w.kr = null;                                       // single source 167 bps away: beyond the 100 bps drift bound
  assert.equal((await step(60)).reason, "no-spot");                 // liveness due (age 75 >= 60) but fail closed
  await step(50);                                                   // age 125 > 120
  assert.equal(k.health().code, 1);
  assert.ok(lines.some((x) => /ALARM oracle age 125 > 0\.8 x maxStaleness 150/.test(x)));
  await step(30); await step(25);                                   // age 155, 180: stale for 25 slots = 10 s
  assert.equal(k.health().code, 2); assert.equal(k.health().worst, 2);
  assert.equal(k.health().unavailableSec, 22, "both stale ticks count their elapsed time (12 s + 10 s)");
  assert.equal(k.stats.pushesTotal, 0);
  w.cb = null;                                                      // total outage, still inside the hold window -> liveness-hold
  const h = await step(5);
  assert.equal(h.kind, "push"); assert.equal(h.reason, "liveness-hold"); assert.equal(h.event!.price, P0);
});

test("keeper loop: liveness heartbeats never consume the brake budget (short-staleness market, > 1 h of heartbeats)", async () => {
  const { w, k, lines, step } = fakeKeeper({ maxPushesPerHour: 120 });
  w.maxStaleness = 150n;
  // 1.5 h at 214 ms slots, polled every 9 slots: ~420 heartbeats, far above 120/h
  let n = 0;
  for (let t = 0; t < 5_400_000; t += 9 * 214) { w.slot += 9; w.now += 9 * 214; const r = await k.tick(); if (r.kind === "push") { assert.equal(r.reason, "liveness"); n++; } }
  assert.ok(n > 300, `${n} heartbeats`);
  w.cb = 60_150; w.kr = 60_150;
  const r = await step(9);
  assert.equal(r.kind, "push"); assert.equal(r.reason, "gap-urgent");
  assert.equal(lines.filter((l) => /ALARM BRAKE/.test(l)).length, 0);
});

test("keeper loop: health goes to 3 (blind) when the Market cannot be read, and recovers", async () => {
  const { w, k, lines, step } = fakeKeeper();
  await step();
  assert.equal(k.health().code, 0);
  w.rpcDown = true;
  for (let i = 0; i < 4; i++) await step();                          // 8 s without a read: not yet
  assert.equal(k.health().code, 0);
  for (let i = 0; i < 2; i++) await step();                          // 12 s
  assert.equal(k.health().code, 3); assert.equal(k.health().worst, 3);
  assert.equal(lines.filter((l) => /ALARM BLIND/.test(l)).length, 1);
  w.rpcDown = false; await step();
  assert.equal(k.health().code, 0);
  assert.ok(lines.some((l) => /market reads are working again/.test(l)));
});

// ================================================================ replay over real 1-minute BTC candles
interface Replay { price: number; liveness: number; maxEndGapBps: number; maxPerHour: number; minutes: number; maxAgeSlots: bigint }
/** slotMs: 400 = the nominal Solana slot; ~214 = measured on mainnet 2026-11-28 (getRecentPerformanceSamples: 281 slots/min) */
function replay(closes: number[], thresholdBps: number, maxStalenessSlots: bigint, slotMs = 400, maxMoveBps = 100n): Replay {
  const SLOTS_PER_MIN = BigInt(Math.round(60_000 / slotMs)), POLL_SLOTS = BigInt(Math.max(1, Math.round(2_000 / slotMs))); // 2 s poll
  const e6 = (p: number) => BigInt(Math.round(p * 1e6));
  let mark = e6(closes[0]), last = SLOTS_PER_MIN - 1n, lastPushMs: number | null = null, catchUp = false;
  let price = 0, liveness = 0, maxEndGapBps = 0, maxPerHour = 0, maxAgeSlots = 0n;
  const times: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const spot = e6(closes[i]);
    const end = BigInt(i + 1) * SLOTS_PER_MIN;
    // the daemon polls every 2 s (5 slots) and re-evaluates every slot while a multi-step move is in progress
    for (let slot = BigInt(i) * SLOTS_PER_MIN; slot < end; ) {
      if (slot - last > maxAgeSlots) maxAgeSlots = slot - last;
      const nowMs = Number(slot) * slotMs;
      const d = decidePush({ mark, spot, maxMoveBps, thresholdBps, lastOracleSlot: last, currentSlot: slot, maxStalenessSlots, nowMs, lastPushMs, catchUp });
      slot += d.push !== null || d.soon ? 1n : POLL_SLOTS;
      if (d.push !== null) {
        const ma = maxAllowedMove(mark, maxMoveBps, slot - last < 2n ? 1n : slot - last);
        assert.ok(abs(d.push - mark) <= ma && !stampsRampPending(ma, abs(d.push - mark)), "replay push violates the clamp / stamps the ramp");
        mark = d.push; last = slot - 1n; lastPushMs = nowMs; catchUp = d.capped;
        if (d.reason === "liveness") liveness++;
        else {
          price++; times.push(nowMs);
          while (times.length && nowMs - times[0] >= 3_600_000) times.shift();
          if (times.length > maxPerHour) maxPerHour = times.length;
        }
      }
    }
    const g = gapBpsOf(spot, mark, mark);
    if (g > maxEndGapBps) maxEndGapBps = g;
  }
  return { price, liveness, maxEndGapBps, maxPerHour, minutes: closes.length - 1, maxAgeSlots };
}

test("REPLAY: ~25 h of real BTC 1-min closes; pushes/day match the measured table and the oracle ends every minute inside the threshold", () => {
  const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/btc-usd-1m-25h.json", import.meta.url), "utf8"));
  const closes: number[] = (fx.candles as [number, number][]).map((c) => c[1]);
  assert.ok(closes.length >= 1_400, `fixture has ${closes.length} minutes`);
  const mv = closes.slice(1).map((c, i) => Math.abs(c / closes[i] - 1) * 1e4).sort((a, b) => a - b);
  console.log(`  fixture: ${closes.length} closes ${new Date(fx.candles[0][0] * 1000).toISOString()} .. ${new Date(fx.candles.at(-1)[0] * 1000).toISOString()}; ` +
    `1-min |move| median ${mv[mv.length >> 1].toFixed(2)} p99 ${mv[Math.floor(mv.length * 0.99)].toFixed(1)} max ${mv.at(-1)!.toFixed(1)} bps (brief: 2.4 / 19 / 57)`);

  // ---- vs the measured table (pushes/day, price-threshold pushes only; staleness effectively off)
  const TABLE: Record<number, number> = { 2: 839, 5: 374, 8: 220, 10: 152, 15: 85, 20: 54, 30: 26, 50: 19 };
  console.log("  thr  pushes  pushes/day  table  delta   max end-of-minute gap   worst hour");
  for (const thr of [2, 5, 8, 10, 15, 20, 30, 50]) {
    const r = replay(closes, thr, 1_000_000_000n);
    const perDay = (r.price * 1440) / r.minutes;
    assert.equal(r.liveness, 0);
    assert.equal(r.minutes, closes.length - 1);
    console.log(`  ${String(thr).padStart(3)}  ${String(r.price).padStart(6)}  ${perDay.toFixed(0).padStart(10)}  ${String(TABLE[thr]).padStart(5)}  ${(((perDay / TABLE[thr]) - 1) * 100).toFixed(1).padStart(5)}%  ${r.maxEndGapBps.toFixed(2).padStart(8)} bps  ${String(r.maxPerHour).padStart(14)}`);
    if (thr === 5 || thr === 10 || thr === 20) {
      assert.ok(Math.abs(perDay / TABLE[thr] - 1) <= 0.15, `thr ${thr}: ${perDay.toFixed(0)} pushes/day vs table ${TABLE[thr]} (outside +-15%)`);
    }
    // multi-step moves are finished inside the minute (2 slots per extra step), so the bound is simply the threshold
    assert.ok(r.maxEndGapBps < thr, `thr ${thr}: oracle ended a minute ${r.maxEndGapBps} bps from spot`);
    if (thr === 10) assert.ok(r.maxPerHour < DEFAULT_MAX_PUSHES_PER_HOUR / 2, `default brake ${DEFAULT_MAX_PUSHES_PER_HOUR}/h must sit well above the worst replay hour (${r.maxPerHour})`);
  }

  // ---- with the liveness heartbeat (0.4 x maxStaleness): total cost per day and the worst oracle age
  for (const slotMs of [400, 214]) {
    const pollSlots = BigInt(Math.round(2_000 / slotMs));
    console.log(`  --- slot time ${slotMs} ms${slotMs === 214 ? " (measured on mainnet 2026-11-28)" : " (nominal)"}; heartbeat at 0.4 x maxStaleness; 2 s poll`);
    console.log("  maxStaleness  ~window  thr  price/day  liveness/day  total/day  SOL/day @5000  SOL/day @10000  heartbeat-only/day  max age (slots)");
    for (const ms of [150n, 300n, 900n, 9_000n]) for (const thr of [5, 10, 20]) {
      const r = replay(closes, thr, ms, slotMs);
      const k = 1440 / r.minutes, total = (r.price + r.liveness) * k;
      const hbOnly = 86_400_000 / (Number(heartbeatAgeSlots(ms)) * slotMs);
      console.log(`  ${String(ms).padStart(12)}  ${((Number(ms) * slotMs) / 1000).toFixed(0).padStart(6)}s  ${String(thr).padStart(3)}  ${(r.price * k).toFixed(0).padStart(9)}  ${(r.liveness * k).toFixed(0).padStart(12)}  ${total.toFixed(0).padStart(9)}  ` +
        `${((total * 5000) / 1e9).toFixed(5).padStart(13)}  ${((total * 10000) / 1e9).toFixed(5).padStart(14)}  ${hbOnly.toFixed(0).padStart(18)}  ${String(r.maxAgeSlots).padStart(15)}`);
      assert.ok(r.maxEndGapBps < thr);
      // the oracle is never older than the heartbeat age + one poll, far from the 0.8 alarm
      assert.ok(r.maxAgeSlots <= heartbeatAgeSlots(ms) + pollSlots, `maxStaleness ${ms}: age ${r.maxAgeSlots}`);
      assert.ok(r.maxAgeSlots < alarmAgeSlots(ms), `maxStaleness ${ms}: age ${r.maxAgeSlots} reached the 0.8 alarm`);
    }
  }
});
