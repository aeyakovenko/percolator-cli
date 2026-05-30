/**
 * asset_slot_capacity guard — regression test for the formerly-latent capacity bug.
 *
 * BEFORE: parseMarketGroup inferred its slot count purely from the account byte
 * length: floor((len - asset_slots) / ASSET_SLOT_LEN). If a future program rev
 * changed the header size or per-slot stride WITHOUT constants.ts being updated in
 * lockstep, that arithmetic silently yields a wrong slot count and the loop decodes
 * misaligned / uninitialized bytes as if they were a live asset slot.
 *
 * AFTER: the parser reads the program's own authoritative `asset_slot_capacity`
 * (u32 @ MG.asset_slot_capacity), surfaces it as `MarketGroup.assetSlotCapacity`,
 * and clamps iteration to what the buffer can actually hold (never overruns). A
 * mismatch between the stored capacity and the length-derived capacity is now an
 * observable, assertable signal of drift instead of a silent mis-decode.
 *
 * These checks are fully synthetic byte-surgery on a real fixture — clearly labeled.
 */
import { parseMarketGroup } from "../../src/v16/parsers.js";
import {
  MARKET_GROUP_OFF, ASSET_SLOT_LEN, MG, V16_MAX_MARKET_SLOTS,
} from "../../src/v16/constants.js";
import { loadFixture } from "./fixtures.js";
import { Suite, TestResult } from "./harness.js";

const CAP_OFF = MARKET_GROUP_OFF + MG.asset_slot_capacity;

export function runCapacityGuardTests(): TestResult {
  const s = new Suite("v16 parser — asset_slot_capacity guard");

  const { data: real } = loadFixture("market-bhkmic5g.json");

  // 1. Well-formed real account: stored capacity is authoritative AND agrees with
  //    the length-derivation. This is the invariant a healthy account upholds.
  s.run("real account: stored == derived == 64", () => {
    const g = parseMarketGroup(real);
    const derived = Math.floor((real.length - MARKET_GROUP_OFF - MG.asset_slots) / ASSET_SLOT_LEN);
    s.eq(g.assetSlotCapacity, V16_MAX_MARKET_SLOTS, "assetSlotCapacity == 64");
    s.eq(g.assetSlotCapacity, derived, "stored capacity == length-derived capacity");
  });

  // 2. Drift detection (SYNTHETIC): corrupt the stored u32 to a value LARGER than the
  //    buffer can hold (as a header/stride shrink would make it look). The parser must
  //    NOT overrun — it clamps iteration to slotsThatFit — and the stored≠derived
  //    divergence is detectable by a caller, turning a silent mis-decode into a guard.
  s.run("synthetic drift: stored capacity > buffer → no overrun, divergence visible", () => {
    const drifted = Buffer.from(real);
    drifted.writeUInt32LE(255, CAP_OFF); // claim 255 slots in a 64-slot account
    const derived = Math.floor((drifted.length - MARKET_GROUP_OFF - MG.asset_slots) / ASSET_SLOT_LEN);

    let threw = false;
    let g: ReturnType<typeof parseMarketGroup> | undefined;
    try {
      g = parseMarketGroup(drifted);
    } catch {
      threw = true; // any throw is also acceptable — the point is "no garbage, no OOB read"
    }
    s.check(!threw, "parser does not crash on an over-large stored capacity (clamps instead)");
    if (g) {
      s.eq(g.assetSlotCapacity, 255, "parser surfaces the (drifted) stored capacity verbatim");
      s.check(g.assetSlotCapacity !== derived,
        `divergence is observable: stored(255) != derived(${derived})`);
      // It must not have read past the buffer: parsed assets can't exceed the slots
      // that physically fit, regardless of the inflated stored claim.
      const maxThatFit = Math.min(255, derived);
      s.check(g.assets.length <= maxThatFit,
        `parsed asset count (${g.assets.length}) <= slots that fit (${maxThatFit})`);
    }
  });

  // 3. Smaller-but-consistent account (SYNTHETIC): a legitimately grown/shrunk account
  //    where BOTH the stored capacity and the byte length say N<64. Truncate to 4 slots
  //    and set the stored u32 to 4 — the parser honours the authoritative count.
  s.run("synthetic shrink: stored == derived == 4 honoured", () => {
    const fourSlotLen = MARKET_GROUP_OFF + MG.asset_slots + 4 * ASSET_SLOT_LEN;
    const small = Buffer.from(real.subarray(0, fourSlotLen));
    small.writeUInt32LE(4, CAP_OFF);
    const g = parseMarketGroup(small);
    const derived = Math.floor((small.length - MARKET_GROUP_OFF - MG.asset_slots) / ASSET_SLOT_LEN);
    s.eq(g.assetSlotCapacity, 4, "stored capacity == 4");
    s.eq(derived, 4, "length-derived capacity == 4");
    // assets[0..2] are Active/Retired (non-placeholder) → all 4 considered.
    s.check(g.assets.length <= 4, "decoded at most 4 slots (no overrun past the smaller account)");
  });

  return s.report();
}
