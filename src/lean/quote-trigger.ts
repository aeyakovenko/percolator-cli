/**
 * Quote-keeper push trigger — PURE (no I/O, no clock): decides whether the operator oracle should be
 * pushed right now, and to which price. Built on the exact on-chain clamp mirror in ./oracle-clamp.ts
 * (handleUpdateOracle, percolator-lean 887ba02).
 *
 * Rule set (in priority order):
 *  0. SAME-SLOT   the program accepts one push per slot (oracleSameSlot, 126): never push unless
 *                 currentSlot > lastOracleSlot.
 *  1. NO SPOT     without a trusted spot the PRICE is never moved. Only a liveness push that holds the
 *                 oracle at `holdTarget` (the last good spot, supplied by the caller iff its safe-drift
 *                 bound still holds) is allowed; without a hold target nothing is pushed and the market
 *                 goes stale = the AMM fails closed.
 *  2. CATCH-UP    the previous push was cap-limited (a move larger than one step): keep stepping back to
 *                 back until the gap is inside the release band (threshold * RELEASE), ignoring the
 *                 minimum interval.
 *  3. GAP         |spot - mark| >= threshold: snap to spot (land at gap 0, so the next trigger needs a
 *                 fresh full-threshold move: hysteresis, no ping-pong, no dribbling).
 *                 Gaps in [threshold, URGENT_MULT * threshold] respect `minIntervalMs` since the last
 *                 push; gaps above URGENT_MULT * threshold are NEVER delayed.
 *  4. LIVENESS    oracle age >= heartbeatFraction * maxStaleness: push toward spot even if the gap is
 *                 tiny (diff 0 is a valid push). Independent of threshold, interval and the brake.
 *  5. BRAKE       `brake` (hourly PRICE-push budget exhausted) suppresses everything except liveness.
 *
 * Step sizing (every push):
 *  - `dt = currentSlot - lastOracleSlot` is a LOWER bound of the landing dt. dt == 1 selects the program's
 *    half allowance, which is valid at any later landing slot too.
 *  - a push is never larger than the ramp-free step `(maxAllowed >> 1) - 1`, so it never stamps
 *    lastRampSlot (887ba02: diff >= maxAllowed >> 1 pauses I_m fronting for 150 slots) and never overshoots.
 *  - dt RULE: two half steps (dt == 1 each) cover the distance of one full step one slot later, at twice
 *    the cost. So when the gap does not fit the half step and dt < 2 the trigger WAITS one slot ("wait-dt").
 *  - tiny marks (maxAllowed 1..3): no non-zero ramp-free step exists. Price pushes are refused
 *    ("no-ramp-free-step") unless `allowRampStamp`; a liveness push degrades to an unchanged-price push.
 */
import { BPS_DEN, MAX_PRICE } from "./constants.js";
import { clampPush, maxAllowedMove, stampsRampPending } from "./oracle-clamp.js";

// ---------------------------------------------------------------- rule-set constants
/** Default push threshold (bps of mark). Sweet spot is 0.5-0.75 x the AMM half-spread. */
export const DEFAULT_THRESHOLD_BPS = 10;
/** Gaps above URGENT_MULT x threshold are never delayed by the minimum interval. */
export const URGENT_MULT = 2n;
/** Catch-up release band = threshold * RELEASE_NUM / RELEASE_DEN (keep stepping until inside it). */
export const RELEASE_NUM = 1n;
export const RELEASE_DEN = 2n;
/** Default liveness heartbeat: push when oracle age >= 0.4 * maxStaleness. */
export const DEFAULT_HEARTBEAT_FRACTION = 0.4;
/** Health alarm: oracle age above 0.8 * maxStaleness = the AMM is about to become unavailable. */
export const AGE_ALARM_FRACTION = 0.8;
/** Default minimum interval between pushes for small gaps (<= URGENT_MULT x threshold). */
export const DEFAULT_MIN_INTERVAL_MS = 10_000;
export const DEFAULT_POLL_MS = 2_000;
/** Default hard brake on PRICE pushes per rolling hour (liveness heartbeats are exempt and not counted).
 *  25 h replay worst hour: 25 at 10 bps, 36 at 5 bps, 54 at 2 bps; 120/h = 2 per minute sustained. */
export const DEFAULT_MAX_PUSHES_PER_HOUR = 120;
/** Thresholds are compared in 1/100 bps so fractional bps configs are exact. */
const E2 = 100n;

export type PushReason =
  | "gap" | "gap-urgent" | "catch-up" | "liveness" | "liveness-hold";
export type SkipReason =
  | "bad-mark" | "same-slot" | "no-spot" | "within-threshold" | "min-interval" | "brake" | "wait-dt" | "no-ramp-free-step";

export interface TriggerState {
  /** on-chain Market.markPrice (E6) */
  mark: bigint;
  /** trusted spot (E6) or null when the feed is down / rejected */
  spot: bigint | null;
  /** Market.maxMoveBps (read from the account) */
  maxMoveBps: bigint;
  /** push threshold in bps of mark (fractions down to 0.01 allowed) */
  thresholdBps: number;
  lastOracleSlot: bigint;
  /** slot the market was read at (a lower bound of the landing slot) */
  currentSlot: bigint;
  /** Market.maxStaleness */
  maxStalenessSlots: bigint;
  nowMs: number;
  /** wall-clock time of the keeper's last landed push (null = none yet) */
  lastPushMs: number | null;
  minIntervalMs?: number;
  /** liveness trigger as a fraction of maxStaleness (default 0.4) */
  heartbeatFraction?: number;
  /** the previous push was cap-limited (`Decision.capped` of the last landed push) */
  catchUp?: boolean;
  /** hourly push budget exhausted: liveness pushes only */
  brake?: boolean;
  /** price to hold the oracle at when `spot` is null (last good spot); null/undefined = fail closed */
  holdTarget?: bigint | null;
  /** permit the 1-unit step that stamps the ramp on degenerate tiny marks (default false) */
  allowRampStamp?: boolean;
}

export interface Decision {
  /** price to push (E6), or null = do nothing */
  push: bigint | null;
  reason: PushReason | SkipReason;
  /** |spot - mark| in bps of mark (NaN without a spot) */
  gapBps: number;
  /** the push stops short of the target: the caller must set `catchUp` for the next call */
  capped: boolean;
  /** true when the caller should re-evaluate within about one slot rather than a full poll interval */
  soon: boolean;
  /** oracle age in slots at `currentSlot` */
  ageSlots: bigint;
  livenessDue: boolean;
}

const abs = (x: bigint) => (x < 0n ? -x : x);
/** gap >= bpsE2/100 bps of mark, exact */
const gapAtLeast = (gap: bigint, mark: bigint, bpsE2: bigint) => gap * BPS_DEN * E2 >= bpsE2 * mark;
const gapAbove = (gap: bigint, mark: bigint, bpsE2: bigint) => gap * BPS_DEN * E2 > bpsE2 * mark;

/** threshold in 1/100 bps (validated) */
export function thresholdE2(thresholdBps: number): bigint {
  if (!Number.isFinite(thresholdBps) || thresholdBps <= 0 || thresholdBps > 10_000) throw new RangeError(`thresholdBps must be in (0, 10000], got ${thresholdBps}`);
  const v = BigInt(Math.round(thresholdBps * 100));
  if (v <= 0n) throw new RangeError(`thresholdBps too small: ${thresholdBps}`);
  return v;
}

/** Oracle age (slots) at which the liveness heartbeat fires: ceil(fraction * maxStaleness), at least 1. */
export function heartbeatAgeSlots(maxStalenessSlots: bigint, fraction: number = DEFAULT_HEARTBEAT_FRACTION): bigint {
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) throw new RangeError(`heartbeatFraction must be in (0, 1), got ${fraction}`);
  if (maxStalenessSlots <= 0n) return 1n;
  const ppm = BigInt(Math.round(fraction * 1_000_000));
  const a = (maxStalenessSlots * ppm + 999_999n) / 1_000_000n;
  return a < 1n ? 1n : a;
}
/** Oracle age (slots) above which the health alarm fires: floor(0.8 * maxStaleness). */
export function alarmAgeSlots(maxStalenessSlots: bigint): bigint {
  return (maxStalenessSlots * 8n) / 10n;
}

/** Largest move that does NOT stamp lastRampSlot for this allowance: (maxAllowed >> 1) - 1, floored at 0. */
export function rampFreeStep(maxAllowed: bigint): bigint {
  const s = (maxAllowed >> 1n) - 1n;
  return s > 0n ? s : 0n;
}

/** |a - b| in bps of `base` as a float (display / stats only; decisions use exact BigInt). */
export function gapBpsOf(a: bigint, b: bigint, base: bigint): number {
  if (base <= 0n) return NaN;
  return Number((abs(a - b) * 1_000_000n) / base) / 100;
}

export function decidePush(s: TriggerState): Decision {
  const age = s.currentSlot > s.lastOracleSlot ? s.currentSlot - s.lastOracleSlot : 0n;
  const livenessDue = age >= heartbeatAgeSlots(s.maxStalenessSlots, s.heartbeatFraction ?? DEFAULT_HEARTBEAT_FRACTION);
  const out = (push: bigint | null, reason: Decision["reason"], gapBps: number, capped = false, soon = false): Decision =>
    ({ push, reason, gapBps, capped, soon, ageSlots: age, livenessDue });

  if (s.mark <= 0n || s.mark > MAX_PRICE) return out(null, "bad-mark", NaN);
  const thr = thresholdE2(s.thresholdBps);
  if (s.spot !== null && s.spot <= 0n) throw new RangeError(`decidePush: spot must be > 0, got ${s.spot}`);

  // ---- what do we want to do (target + reason), before step sizing
  let target: bigint;
  let reason: PushReason;
  let gapBps = NaN;
  if (s.spot === null) {
    if (!livenessDue || s.holdTarget == null || s.holdTarget <= 0n) return out(null, "no-spot", NaN);
    target = s.holdTarget; reason = "liveness-hold";
  } else {
    target = s.spot > MAX_PRICE ? MAX_PRICE : s.spot;
    const gap = abs(target - s.mark);
    gapBps = gapBpsOf(target, s.mark, s.mark);
    const minInt = s.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    let want: PushReason | null = null, skip: SkipReason = "within-threshold";
    if (s.catchUp && gap > 0n && gapAtLeast(gap, s.mark, (thr * RELEASE_NUM) / RELEASE_DEN)) want = "catch-up";
    else if (gapAtLeast(gap, s.mark, thr)) {
      if (gapAbove(gap, s.mark, thr * URGENT_MULT)) want = "gap-urgent";
      else if (s.lastPushMs !== null && s.nowMs - s.lastPushMs < minInt) skip = "min-interval";
      else want = "gap";
    }
    if (want !== null && s.brake) { want = null; skip = "brake"; }
    if (want === null) {
      if (!livenessDue) return out(null, skip, gapBps);
      want = "liveness";
    }
    reason = want;
  }

  // ---- step sizing against the exact on-chain allowance
  if (age < 1n) return out(null, "same-slot", gapBps, false, true);
  const dt = age < 2n ? 1n : age;
  const maxAllowed = maxAllowedMove(s.mark, s.maxMoveBps, dt);
  const gap = abs(target - s.mark);
  const isLiveness = reason === "liveness" || reason === "liveness-hold";
  // dt rule: the gap does not fit the half step and a full step is one slot away -> wait (liveness never waits here:
  // it can only be due at age < 2 on a degenerate maxStaleness, and then a half step is still progress).
  if (dt === 1n && gap > rampFreeStep(maxAllowed) && !isLiveness) return out(null, "wait-dt", gapBps, false, true);

  let push = clampPush(s.mark, target, s.maxMoveBps, dt);
  let diff = abs(push - s.mark);
  if (diff > 0n && stampsRampPending(maxAllowed, diff) && !s.allowRampStamp) {
    // only reachable on degenerate tiny marks (maxAllowed 1..3), where keeperStepCap falls back to a stamping unit step
    diff = rampFreeStep(maxAllowed);
    push = target >= s.mark ? s.mark + diff : s.mark - diff;
  }
  if (diff === 0n && !isLiveness) {
    if (!livenessDue) return out(null, "no-ramp-free-step", gapBps);
    return out(s.mark, "liveness", gapBps); // the price cannot move ramp-free, but the oracle must stay alive
  }
  const capped = push !== target && diff > 0n;
  return out(push, reason, gapBps, capped, capped);
}
