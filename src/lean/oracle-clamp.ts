/**
 * Oracle-keeper price clamp — a pure mirror of `handleUpdateOracle` (percolator-lean 9b45ad1,
 * Percolator/Program.lean) for a LOADED market (any OI / raw basis):
 *
 *   effMaxMove = (curSlot == lastSlot + 1 && maxMoveBps > 1) ? maxMoveBps >> 1 : maxMoveBps
 *   maxAllowed = floor(oldPrice * effMaxMove / BPS_DEN)            (mulDiv64)
 *   require |newPrice - oldPrice| <= maxAllowed                    (else oracleClamp, 0x68)
 *   built-in funding is then charged strictly inside remBudget = maxAllowed - diff
 *   a "saturated ramp" stamps lastRampSlot = curSlot and pauses new I_m fronting for RAMP_FRONT_COOLDOWN slots:
 *     - percolator-lean <= 9b45ad1: diff >= maxAllowed - (maxAllowed >> 2)  (>= 75%), cooldown 2 slots   -> stampsRamp()
 *     - percolator-lean >= 887ba02: diff >= (maxAllowed >> 1)               (>= 50%, inclusive), cooldown 150 slots
 *                                                                           -> stampsRampPending()  (the rule live on mainnet round 4)
 * The keeper step below stays strictly under the 50% line, so it is ramp-free under BOTH rules.
 *
 * (An EMPTY market — OI == 0 and rawBasis == 0 on both sides — skips the clamp entirely; the
 * keeper still uses the clamped step there because a trade can land between read and push.)
 *
 * No I/O, BigInt only: safe to unit-test and to reuse from any keeper.
 */
import { BPS_DEN, MAX_PRICE } from "./constants.js";

/** Slots of paused I_m fronting after a saturated ramp tick (Layout.lean RAMP_FRONT_COOLDOWN): 2 on <= 9b45ad1, 150 on >= 887ba02. */
export const RAMP_FRONT_COOLDOWN = 150n;

/** The bps the program actually applies: halved (floor) when the push lands exactly 1 slot after the last one.
 *  `dtSlots` = landingSlot - lastOracleSlot; anything <= 1 is treated as the half-step case (conservative). */
export function effMaxMoveBps(maxMoveBps: bigint, dtSlots: bigint): bigint {
  if (maxMoveBps < 0n) throw new RangeError(`effMaxMoveBps: maxMoveBps must be >= 0, got ${maxMoveBps}`);
  return dtSlots <= 1n && maxMoveBps > 1n ? maxMoveBps >> 1n : maxMoveBps;
}

/** Exact largest |newPrice - mark| the program accepts (before the [1, MAX_PRICE] price bound). */
export function maxAllowedMove(mark: bigint, maxMoveBps: bigint, dtSlots: bigint): bigint {
  if (mark <= 0n) throw new RangeError(`maxAllowedMove: mark must be > 0, got ${mark}`);
  return (mark * effMaxMoveBps(maxMoveBps, dtSlots)) / BPS_DEN; // BigInt division floors (operands >= 0)
}

/** True iff a move of `diff` stamps lastRampSlot on the DEPLOYED program (9b45ad1): diff >= 75% of maxAllowed. */
export function stampsRamp(maxAllowed: bigint, diff: bigint): boolean {
  return maxAllowed > 0n && diff >= maxAllowed - (maxAllowed >> 2n);
}
/** Same predicate under the stricter PENDING rule (unreleased working tree): diff >= maxAllowed >> 1 (50%, inclusive). */
export function stampsRampPending(maxAllowed: bigint, diff: bigint): boolean {
  return maxAllowed > 0n && diff >= maxAllowed >> 1n;
}

/**
 * Largest step the keeper takes per push: the biggest move STRICTLY below half the allowance,
 * i.e. (maxAllowed >> 1) - 1. That never stamps lastRampSlot (deployed 75% rule or pending 50% rule)
 * and always leaves > 50% of maxAllowed as built-in funding budget.
 * Degenerate tiny marks (maxAllowed 1..3) would get a zero step from that formula; there the keeper
 * takes the minimal 1-unit step so the oracle can still track. That unit step stamps the ramp only at
 * maxAllowed == 1 on the deployed rule (maxAllowed 1..3 on the pending rule) — i.e. marks below
 * ~$0.0004 at 100 bps. maxAllowed == 0 -> 0 (the price cannot move at all).
 */
export function keeperStepCap(maxAllowed: bigint): bigint {
  if (maxAllowed <= 0n) return 0n;
  const rampFree = (maxAllowed >> 1n) - 1n;
  return rampFree >= 1n ? rampFree : 1n;
}

/**
 * Price the keeper should push: move `mark` toward `target` by at most `keeperStepCap(maxAllowed)`,
 * never overshooting the target and staying inside the program's [1, MAX_PRICE] price range.
 *
 * @param mark        current on-chain markPrice (E6), > 0
 * @param target      desired price (E6), > 0 (values above MAX_PRICE are capped to MAX_PRICE)
 * @param maxMoveBps  Market.maxMoveBps (read from the account — do not hard-code)
 * @param dtSlots     expected landingSlot - lastOracleSlot. Pass a LOWER bound (e.g. confirmedSlot -
 *                    lastOracleSlot): <= 1 selects the half step, which is valid at any larger dt too.
 */
export function clampPush(mark: bigint, target: bigint, maxMoveBps: bigint, dtSlots: bigint): bigint {
  if (target <= 0n) throw new RangeError(`clampPush: target must be > 0, got ${target}`);
  const cap = keeperStepCap(maxAllowedMove(mark, maxMoveBps, dtSlots));
  const tgt = target > MAX_PRICE ? MAX_PRICE : target;
  if (tgt >= mark) {
    const gap = tgt - mark;
    return mark + (gap < cap ? gap : cap);
  }
  const gap = mark - tgt;
  return mark - (gap < cap ? gap : cap);
}
