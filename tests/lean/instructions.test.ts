import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { IX, LEAN_DEVNET, refreshLeg, rewardInit, rewardSettleEpoch, rewardSubmitBid } from "../../src/lean/index.js";

const key = (value: number) => new PublicKey(Buffer.alloc(32, value));
const percolator = LEAN_DEVNET.percolator;
const rewardModule = LEAN_DEVNET.rewardModule;

test("refreshLeg adds the owner signer only for a forced haircut", () => {
  const accounts = { dex: key(1), market: key(2), portfolio: key(3) };
  const owner = key(4);
  const regular = refreshLeg(percolator, { ...accounts, owner });
  const haircut = refreshLeg(percolator, { ...accounts, owner, forceHaircut: true });

  assert.deepEqual(regular.data, Buffer.from([IX.RefreshLeg, 0]));
  assert.equal(regular.keys.length, 3);
  assert.deepEqual(haircut.data, Buffer.from([IX.RefreshLeg, 1]));
  assert.deepEqual(haircut.keys, [...regular.keys, { pubkey: owner, isSigner: true, isWritable: false }]);
  assert.throws(() => refreshLeg(percolator, { ...accounts, forceHaircut: true }), /requires the portfolio owner/);
});

const rewardAccounts = { cfg: key(10), epochAcc: key(11), targetEscrow: key(12), targetMint: key(13) };

test("reward builders declare account permissions for bids and each settlement mode", () => {
  const bid = rewardSubmitBid(rewardModule, {
    ...rewardAccounts, bidReceipt: key(14), bidder: key(15), bidderTargetTok: key(16), amount: 1n,
  });
  assert.equal(bid.keys[0].isWritable, false);

  const burn = rewardSettleEpoch(rewardModule, { ...rewardAccounts, burnMode: 0 });
  assert.equal(burn.keys.length, 6);
  assert.deepEqual(burn.keys[4], { pubkey: rewardAccounts.targetMint, isSigner: false, isWritable: true });

  const burnSink = key(17);
  const transfer = rewardSettleEpoch(rewardModule, { ...rewardAccounts, burnMode: 1, burnSink });
  assert.equal(transfer.keys[4].isWritable, false);
  assert.deepEqual(transfer.keys[6], { pubkey: burnSink, isSigner: false, isWritable: true });
});

test("reward dead-sink mode requires a separate token account", () => {
  const init = {
    ...rewardAccounts, mktAdmin: key(18), percolator, dex: key(19), market: key(20),
    quoteMint: key(21), quoteVault: key(22), epochSlots: 32n, minBatchQuote: 1n, reserveRateE6: 1n,
    burnMode: 1 as const,
  };
  const settle = { ...rewardAccounts, burnMode: 1 as const };
  for (const burnSink of [undefined, rewardAccounts.targetEscrow]) {
    assert.throws(() => rewardInit(rewardModule, { ...init, burnSink }), /requires a distinct burnSink/);
    assert.throws(() => rewardSettleEpoch(rewardModule, { ...settle, burnSink }), /requires a distinct burnSink/);
  }
  assert.throws(() => rewardInit(rewardModule, { ...init, burnSink: init.quoteVault }), /requires a distinct burnSink/);
});
