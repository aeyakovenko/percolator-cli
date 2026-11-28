/** percolator-lean 55c167f (Issue #117): InsReceipt bytes 4..7 = lastDepositBucket (u32, slot >> 4) and the
 *  160-slot anti-JIT cooldown of WithdrawInsurance while the market has open interest. */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { parseInsReceipt, insWithdrawReadyAt } from "../../src/lean/parsers.js";
import { InsOff, INS_RECEIPT_SIZE, MAGIC, INS_WITHDRAW_COOLDOWN_BUCKETS } from "../../src/lean/constants.js";

function receipt(bucket: number, shares = 23_000_000n): Buffer {
  const b = Buffer.alloc(INS_RECEIPT_SIZE);
  b.writeUInt32LE(MAGIC.INSURANCE, 0);
  b.writeUInt32LE(bucket, 4);
  b.writeBigUInt64LE(1n, 8);
  Keypair.generate().publicKey.toBuffer().copy(b, 16);
  Keypair.generate().publicKey.toBuffer().copy(b, 48);
  b.writeBigUInt64LE(shares, 80);
  return b;
}

test("InsOff / parseInsReceipt: lastDepositBucket is the u32 at offset 4; other fields unchanged", () => {
  assert.deepEqual(InsOff, { magic: 0, lastDepositBucket: 4, marketId: 8, owner: 16, market: 48, shares: 80 });
  assert.equal(INS_WITHDRAW_COOLDOWN_BUCKETS, 10n);
  const r = parseInsReceipt(receipt(0x01f6e2a3));
  assert.equal(r.lastDepositBucket, 0x01f6e2a3);
  assert.deepEqual([r.marketId, r.shares], [1n, 23_000_000n]);
  // a receipt written by a pre-55c167f program has zero padding there
  assert.equal(parseInsReceipt(receipt(0)).lastDepositBucket, 0);
  // the high bit must not turn negative
  assert.equal(parseInsReceipt(receipt(0xffffffff)).lastDepositBucket, 0xffffffff);
});

test("insWithdrawReadyAt mirrors the program: (slot >> 4) - lastDepositBucket >= 10", () => {
  const depositSlot = 527_340_007n;                    // bucket = slot >> 4
  const bucket = Number(depositSlot >> 4n);
  const r = { lastDepositBucket: bucket };
  const readySlot = (BigInt(bucket) + 10n) << 4n;      // first slot of bucket + 10
  assert.equal(insWithdrawReadyAt(r, depositSlot).readySlot, readySlot);
  assert.ok(readySlot - depositSlot > 144n && readySlot - depositSlot <= 160n, "between 145 and 160 slots after the deposit");
  assert.deepEqual(insWithdrawReadyAt(r, depositSlot), { ready: false, readySlot, slotsLeft: readySlot - depositSlot });
  assert.deepEqual(insWithdrawReadyAt(r, readySlot - 1n), { ready: false, readySlot, slotsLeft: 1n });
  assert.deepEqual(insWithdrawReadyAt(r, readySlot), { ready: true, readySlot, slotsLeft: 0n });
  assert.deepEqual(insWithdrawReadyAt(r, Number(readySlot) + 5000), { ready: true, readySlot, slotsLeft: 0n });
  // exhaustive agreement with the on-chain predicate around the boundary
  for (let s = depositSlot - 40n; s < readySlot + 40n; s++) {
    const cur = (s >> 4n) & 0xffffffffn;
    const onChain = cur >= BigInt(bucket) && cur - BigInt(bucket) >= 10n;
    assert.equal(insWithdrawReadyAt(r, s).ready, onChain, `slot ${s}`);
  }
});

test("insWithdrawReadyAt: a pre-upgrade receipt (bucket 0) is immediately ready", () => {
  const r = parseInsReceipt(receipt(0));
  assert.deepEqual(insWithdrawReadyAt(r, 475_000_000n), { ready: true, readySlot: 160n, slotsLeft: 0n });
});
