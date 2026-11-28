/** Pure tests for the client-side builder guards in src/lean/instructions.ts (no network). */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createMarket, rewardInit, adapterInit, deriveRewAuth, deriveOracleAuth } from "../../src/lean/instructions.js";
import { IX, REWARD_IX, ADAPTER_IX, TOKEN_PROGRAM_ID } from "../../src/lean/constants.js";

const pk = () => Keypair.generate().publicKey;
const P = pk(), RM = pk(), O = pk();

const mktBase = () => ({
  dex: pk(), market: pk(), mint: pk(), oracleAuth: pk(), creator: pk(), creatorToken: pk(), feeVault: pk(),
  params: {
    initPrice: 100_000_000n, exitWindow: 10n, maxStaleness: 500n,
    imBps: 1000n, mmBps: 500n, liqFeeBps: 100n, tradeFeeBps: 2n,
    maxMoveBps: 75n, maxInsDrawBps: 2500n, maxOi: 1_000_000_000_000n,
  },
});

test("createMarket: rewardBps > 0 requires a non-default rewardRecipient", () => {
  const b = mktBase();
  const withBps = (extra: object) => ({ ...b, params: { ...b.params, rewardBps: 5000n, ...extra } });
  assert.throws(() => createMarket(P, withBps({})), /rewardRecipient/);
  assert.throws(() => createMarket(P, withBps({ rewardRecipient: undefined })), /rewardRecipient/);
  assert.throws(() => createMarket(P, withBps({ rewardRecipient: PublicKey.default })), /rewardRecipient/);
  assert.throws(() => createMarket(P, withBps({ rewardRecipient: new PublicKey(Buffer.alloc(32)) })), /rewardRecipient/);
  assert.throws(() => createMarket(P, { ...b, params: { ...b.params, rewardBps: 1n } }), /rewardRecipient/);
});

test("createMarket: valid inputs keep their exact byte layout (100 B without reward, 140 B with)", () => {
  const b = mktBase();
  // rewardBps absent / 0: no recipient needed, 100-byte layout, a stray recipient is not encoded
  for (const params of [b.params, { ...b.params, rewardBps: 0n }, { ...b.params, rewardBps: 0n, rewardRecipient: pk() }]) {
    const i = createMarket(P, { ...b, params });
    assert.equal(i.data.length, 100);
    assert.equal(i.data[0], IX.CreateMarket);
  }
  const rec = pk();
  const i = createMarket(P, { ...b, params: { ...b.params, rewardBps: 10_000n, rewardRecipient: rec, maxFrontBps: 7n, fundingCfg: 9n, minMm: 11n } });
  assert.equal(i.data.length, 140);
  assert.equal(i.data[0], IX.CreateMarket);
  assert.equal(i.data.readUInt16LE(2), 7);
  const want = [100_000_000n, 10n, 500n, 9n, 1000n, 500n, 100n, 2n, 75n, 2500n, 1_000_000_000_000n, 11n];
  want.forEach((v, k) => assert.equal(i.data.readBigUInt64LE(4 + 8 * k), v, `param ${k}`));
  assert.equal(i.data.readBigUInt64LE(100), 10_000n);
  assert.deepEqual(i.data.subarray(108, 140), rec.toBuffer());
  assert.equal(i.keys.length, 8);
});

const rewBase = () => ({
  cfg: pk(), mktAdmin: pk(), percolator: P, dex: pk(), market: pk(),
  quoteMint: pk(), quoteVault: pk(), targetMint: pk(), targetEscrow: pk(),
  epochSlots: 150n, minBatchQuote: 1_000_000n, reserveRateE6: 500_000n,
});

test("rewardInit: quoteVault / targetEscrow / burnSink must be pairwise distinct", () => {
  const b = rewBase(), sink = pk();
  // quoteVault == targetEscrow is invalid in both burn modes
  assert.throws(() => rewardInit(RM, { ...b, burnMode: 0, targetEscrow: b.quoteVault }), /quoteVault and targetEscrow/);
  assert.throws(() => rewardInit(RM, { ...b, burnMode: 1, burnSink: sink, targetEscrow: b.quoteVault }), /quoteVault and targetEscrow/);
  // burnMode 1: sink required and distinct from both
  assert.throws(() => rewardInit(RM, { ...b, burnMode: 1 }), /burnSink/);
  assert.throws(() => rewardInit(RM, { ...b, burnMode: 1, burnSink: b.targetEscrow }), /distinct from targetEscrow/);
  assert.throws(() => rewardInit(RM, { ...b, burnMode: 1, burnSink: b.quoteVault }), /distinct from quoteVault/);
  // equal by value, not by reference
  assert.throws(() => rewardInit(RM, { ...b, burnMode: 1, burnSink: new PublicKey(b.quoteVault.toBase58()) }), /distinct from quoteVault/);
});

test("rewardInit: valid inputs keep their layout (12 keys burn, 13 keys dead-sink; burnSink ignored in burnMode 0)", () => {
  const b = rewBase(), sink = pk();
  const [rewAuth, bump] = deriveRewAuth(RM, b.cfg);
  const burn = rewardInit(RM, { ...b, burnMode: 0 });
  assert.equal(burn.keys.length, 12);
  // burnMode 0 never uses the sink, so an aliasing sink is not an error there
  assert.equal(rewardInit(RM, { ...b, burnMode: 0, burnSink: b.quoteVault }).keys.length, 12);
  const dead = rewardInit(RM, { ...b, burnMode: 1, burnSink: sink });
  assert.equal(dead.keys.length, 13);
  assert.equal(dead.keys[12].pubkey.equals(sink), true);
  assert.equal(dead.keys[12].isWritable, true);
  for (const i of [burn, dead]) {
    assert.equal(i.data.length, 28);
    assert.equal(i.data[0], REWARD_IX.InitReward);
    assert.equal(i.data[1], bump);
    assert.equal(i.data.readBigUInt64LE(4), 150n);
    assert.equal(i.data.readBigUInt64LE(12), 1_000_000n);
    assert.equal(i.data.readBigUInt64LE(20), 500_000n);
    assert.deepEqual(i.keys.slice(0, 12).map((k) => k.pubkey.toBase58()), [
      b.cfg, b.mktAdmin, b.percolator, b.dex, b.market, rewAuth, b.quoteMint, b.quoteVault, TOKEN_PROGRAM_ID,
      b.targetMint, b.targetEscrow, TOKEN_PROGRAM_ID,
    ].map((k) => k.toBase58()));
  }
  assert.equal(burn.data[2], 0);
  assert.equal(dead.data[2], 1);
});

const adpBase = () => ({
  cfg: pk(), admin: pk(), percolator: P, market: pk(), feed: pk(),
  feedType: 1, maxFeedAge: 600n, maxConfBps: 500n, fundingBpsPerStep: 0n,
});
const id = (fill: number) => Buffer.alloc(32, fill);

test("adapterInit: quoteFeedId needs both feedId and a quoteFeed account; ids must be 32 bytes", () => {
  const b = adpBase(), q = pk();
  assert.throws(() => adapterInit(O, { ...b, feedId: id(1), quoteFeedId: id(2) }), /quoteFeedId requires quoteFeed/);
  assert.throws(() => adapterInit(O, { ...b, feedId: id(1), quoteFeedId: id(2), quoteFeedType: 1 }), /quoteFeedId requires quoteFeed/);
  assert.throws(() => adapterInit(O, { ...b, quoteFeed: q, quoteFeedId: id(2) }), /quoteFeedId requires feedId/);
  assert.throws(() => adapterInit(O, { ...b, quoteFeedId: id(2) }), /quoteFeedId requires/);
  assert.throws(() => adapterInit(O, { ...b, feedId: Buffer.alloc(31) }), /feedId must be 32 bytes/);
  assert.throws(() => adapterInit(O, { ...b, feedId: id(1), quoteFeed: q, quoteFeedId: Buffer.alloc(33) }), /quoteFeedId must be 32 bytes/);
});

test("adapterInit: valid shapes keep their layout (28/60/92 B, 5 or 6 keys)", () => {
  const b = adpBase(), q = pk();
  const [, bump] = deriveOracleAuth(O, b.cfg);
  const plain = adapterInit(O, b);
  assert.equal(plain.data.length, 28);
  assert.equal(plain.keys.length, 5);
  const pinned = adapterInit(O, { ...b, feedId: id(1) });
  assert.equal(pinned.data.length, 60);
  assert.equal(pinned.keys.length, 5);
  assert.deepEqual(pinned.data.subarray(28, 60), id(1));
  // composite without pinned ids, composite with base id only, composite with both ids
  const comp = adapterInit(O, { ...b, quoteFeed: q, quoteFeedType: 1 });
  assert.equal(comp.data.length, 28);
  assert.equal(comp.keys.length, 6);
  const compBase = adapterInit(O, { ...b, feedId: id(1), quoteFeed: q, quoteFeedType: 1 });
  assert.equal(compBase.data.length, 60);
  assert.equal(compBase.keys.length, 6);
  const full = adapterInit(O, { ...b, feedId: id(1), quoteFeed: q, quoteFeedType: 2, quoteFeedId: id(2) });
  assert.equal(full.data.length, 92);
  assert.equal(full.keys.length, 6);
  assert.equal(full.keys[5].pubkey.equals(q), true);
  assert.deepEqual(full.data.subarray(28, 60), id(1));
  assert.deepEqual(full.data.subarray(60, 92), id(2));
  for (const i of [plain, pinned, comp, compBase, full]) {
    assert.equal(i.data[0], ADAPTER_IX.Init);
    assert.equal(i.data[1], bump);
    assert.equal(i.data[2], 1);
    assert.equal(i.data.readBigUInt64LE(4), 600n);
    assert.equal(i.data.readBigUInt64LE(12), 500n);
    assert.equal(i.data.readBigUInt64LE(20), 0n);
  }
  assert.equal(full.data[3], 2);
});
