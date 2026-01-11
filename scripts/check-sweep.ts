import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const market = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const slab = new PublicKey(market.slab);

// RiskEngine layout offsets (from slab.ts)
const ENGINE_OFF = 216;
const ENGINE_LAST_CRANK_SLOT_OFF = 280;
const ENGINE_MAX_CRANK_STALENESS_OFF = 288;

// Need to find these offsets by reading the struct layout
// After the ADL arrays and pending fields...

async function main() {
  const info = await connection.getAccountInfo(slab);
  if (!info) { console.log("Not found"); return; }

  // Get current slot
  const slot = await connection.getSlot();
  console.log("Current slot:", slot);

  // Read last_crank_slot
  const lastCrankSlot = info.data.readBigUInt64LE(ENGINE_OFF + ENGINE_LAST_CRANK_SLOT_OFF);
  console.log("last_crank_slot:", lastCrankSlot);
  console.log("Crank gap:", BigInt(slot) - lastCrankSlot);

  // Read max_crank_staleness_slots
  const maxStaleness = info.data.readBigUInt64LE(ENGINE_OFF + ENGINE_MAX_CRANK_STALENESS_OFF);
  console.log("max_crank_staleness_slots:", maxStaleness);

  // Check require_fresh_crank
  const crankStale = BigInt(slot) - lastCrankSlot > maxStaleness;
  console.log("require_fresh_crank would fail:", crankStale);

  // To find last_full_sweep_start_slot, we need to trace through the struct layout
  // It comes after the large ADL arrays. Let me calculate the offset.
  //
  // After ENGINE_WARMUP_INSURANCE_OFF (344 + 16 = 360):
  // adl_remainder_scratch: [u128; 4096] = 65536 bytes @ 360
  // adl_idx_scratch: [u16; 4096] = 8192 bytes @ 65896
  // adl_exclude_scratch: [u8; 4096] = 4096 bytes @ 74088
  // Total ADL: 65536 + 8192 + 4096 = 77824 bytes
  //
  // After ADL (at 360 + 77824 = 78184):
  // pending_profit_to_fund: u128 @ 78184
  // pending_unpaid_loss: u128 @ 78200
  // pending_epoch: u8 @ 78216
  // padding: 7 bytes
  // pending_exclude_epoch: [u8; 4096] @ 78224
  //
  // After pending_exclude_epoch (at 78224 + 4096 = 82320):
  // liq_cursor: u16 @ 82320
  // gc_cursor: u16 @ 82322
  // Padding to 8-byte align: 4 bytes
  // last_full_sweep_start_slot: u64 @ 82328
  // last_full_sweep_completed_slot: u64 @ 82336
  // crank_step: u8 @ 82344

  // Actually, let me try to find it empirically by scanning for known values
  // The offset is complex due to all the arrays, so let me just search

  // Try several possible offsets for last_full_sweep_start_slot
  const SWEEP_OFFSET_GUESS = ENGINE_OFF + 82328 - 360; // Rough estimate

  console.log("\n--- Scanning for sweep-related fields ---");

  // The Rust struct has these fields after the ADL arrays:
  // These should be near the end of the engine, before accounts

  // From slab.ts: ENGINE_BITMAP_OFF = 82424
  // That means cursors and sweep slots are around 82320-82424

  // Let me read at various offsets before the bitmap
  for (let off = 82320; off < 82400; off += 8) {
    const val = info.data.readBigUInt64LE(ENGINE_OFF + off);
    if (val > 0n && val < 1000000000000n) { // Reasonable slot values
      console.log(`@${off}: ${val} (could be slot)`);
    }
  }

  // Try to find the specific field
  // Based on raw byte analysis, the layout at 82316 is:
  // - 82316: liq_cursor (u16) + gc_cursor (u16) = 4 bytes
  // - 82320: last_full_sweep_start_slot (u64)
  // - 82328: last_full_sweep_completed_slot (u64)
  // - 82336: crank_step (u8)
  const sweepStartOffset = 82320;
  const sweepStart = info.data.readBigUInt64LE(ENGINE_OFF + sweepStartOffset);
  console.log("\nlast_full_sweep_start_slot @", sweepStartOffset, ":", sweepStart);

  // Check require_recent_full_sweep
  const sweepGap = BigInt(slot) - sweepStart;
  console.log("Sweep gap:", sweepGap);
  console.log("require_recent_full_sweep would fail:", sweepGap > maxStaleness);

  // Check last_full_sweep_completed_slot
  const sweepCompletedOffset = 82328;
  const sweepCompleted = info.data.readBigUInt64LE(ENGINE_OFF + sweepCompletedOffset);
  console.log("last_full_sweep_completed_slot @", sweepCompletedOffset, ":", sweepCompleted);

  // Check crank_step
  const crankStepOffset = 82336;
  const crankStep = info.data.readUInt8(ENGINE_OFF + crankStepOffset);
  console.log("crank_step @", crankStepOffset, ":", crankStep);

  // Dump raw bytes around sweep area to understand the layout
  console.log("\n--- Raw bytes around sweep area (ENGINE_OFF + 82300-82400) ---");
  for (let off = 82300; off < 82400; off += 8) {
    const bytes = info.data.subarray(ENGINE_OFF + off, ENGINE_OFF + off + 8);
    const hex = Buffer.from(bytes).toString("hex");
    const u64 = info.data.readBigUInt64LE(ENGINE_OFF + off);
    console.log(`@${off}: ${hex} (u64=${u64})`);
  }
}

main().catch(console.error);
