import { diff, type Snapshot } from "../scripts/mainnet-bounty3-tick.js";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    iso: "2026-05-13T00:00:00.000Z",
    slot: 1_000,
    marketSlot: 950n,
    marketSlotLag: 50,
    numUsed: 1,
    vault: 1_000_000n,
    cTot: 900_000n,
    insurance: 100_000n,
    spl: 1_000_000n,
    lastOraclePrice: 100_000_000n,
    sideModeLong: 0,
    sideModeShort: 0,
    rrCursor: 0n,
    sweepGen: 0n,
    priceMoveConsumed: 0n,
    conservationOk: true,
    accountingOk: true,
    ...overrides,
  };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const SCALE = 1_000_000_000n;
const pre = snapshot();
const post = snapshot({ priceMoveConsumed: 401n * SCALE });

const result = diff(pre, post);

assert(
  result.flags.includes("PRICE_MOVE_SAT(consumed=401bps)"),
  "PRICE_MOVE_SAT fires when consumed price move exceeds threshold"
);
assert(
  result.deltas.priceMoveConsumedBps === "401",
  "price move consumed delta is reported in bps"
);

console.log("✓ mainnet bounty3 PRICE_MOVE_SAT alert");
