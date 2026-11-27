import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createMarket, refreshLeg, liquidate, rewardInit, rewardSubmitBid, rewardSettleEpoch,
} from "../../src/lean/instructions.js";
import { withLegRefresh, realizeFlatLegs } from "../../src/lean/refresh.js";
import {
  IX, LEAN_MAINNET, PORTFOLIO_SIZE, MARKET_SIZE, MAGIC, SIDE, STATUS,
} from "../../src/lean/constants.js";

const pk = () => Keypair.generate().publicKey;

function mockPortfolioBuf(dex: PublicKey, owner: PublicKey, legs: Array<{ market: PublicKey; side: number; posPnl?: bigint }>): Buffer {
  const b = Buffer.alloc(PORTFOLIO_SIZE);
  b.writeUInt32LE(MAGIC.PORTFOLIO, 0);
  b.writeUInt8(legs.length, 4);
  dex.toBuffer().copy(b, 24);
  owner.toBuffer().copy(b, 56);
  legs.forEach((leg, i) => {
    const o = 144 + i * 104;
    b.writeUInt8(1, o); // active
    b.writeUInt8(leg.side, o + 1);
    b.writeBigUInt64LE(BigInt(i + 1), o + 8);
    leg.market.toBuffer().copy(b, o + 16);
    b.writeBigUInt64LE(leg.side === SIDE.FLAT ? 0n : 1_000_000n, o + 48);
    b.writeBigUInt64LE(leg.posPnl ?? 0n, o + 64);
  });
  return b;
}

function mockMarketBuf(status: number): Buffer {
  const b = Buffer.alloc(MARKET_SIZE);
  b.writeUInt32LE(MAGIC.MARKET, 0);
  b.writeUInt8(status, 4);
  return b;
}

test("createMarket rejects liqFeeBps > mmBps and negative liqFeeBps", () => {
  const base = {
    dex: pk(), market: pk(), mint: pk(), oracleAuth: pk(),
    creator: pk(), creatorToken: pk(), feeVault: pk(),
    params: {
      initPrice: 100_000_000n, exitWindow: 10n, maxStaleness: 500n, warmupSlots: 0n,
      imBps: 1000n, mmBps: 500n, liqFeeBps: 100n, tradeFeeBps: 0n,
      maxMoveBps: 75n, maxInsDrawBps: 2500n, maxOi: 1_000_000_000_000n,
    },
  };
  assert.doesNotThrow(() => createMarket(LEAN_MAINNET.percolator, base));
  assert.throws(() => createMarket(LEAN_MAINNET.percolator, { ...base, params: { ...base.params, liqFeeBps: 501n } }), RangeError);
  assert.throws(() => createMarket(LEAN_MAINNET.percolator, { ...base, params: { ...base.params, liqFeeBps: -1n } }), RangeError);
});

test("refreshLeg requires owner signer iff forceHaircut is true", () => {
  const dex = pk(), market = pk(), portfolio = pk(), owner = pk();
  const normal = refreshLeg(LEAN_MAINNET.percolator, { dex, market, portfolio });
  assert.equal(normal.keys.length, 3);
  assert.throws(() => refreshLeg(LEAN_MAINNET.percolator, { dex, market, portfolio, forceHaircut: true }));
  const forced = refreshLeg(LEAN_MAINNET.percolator, { dex, market, portfolio, forceHaircut: true, owner });
  assert.equal(forced.keys.length, 4);
  assert.equal(forced.keys[3].pubkey.equals(owner), true);
  assert.equal(forced.keys[3].isSigner, true);
  assert.equal(forced.data[1], 1);
});

test("reward builders: SubmitBid cfg readonly, SettleEpoch mint writable for burn, distinct burnSink for dead-sink", () => {
  const rm = pk(), cfg = pk(), ep = pk(), rec = pk(), bidder = pk(), bTok = pk(), esc = pk(), mint = pk(), sink = pk();
  const bid = rewardSubmitBid(rm, { cfg, epochAcc: ep, bidReceipt: rec, bidder, bidderTargetTok: bTok, targetEscrow: esc, targetMint: mint, amount: 10n });
  assert.equal(bid.keys[0].isWritable, false);

  const burnSettle = rewardSettleEpoch(rm, { cfg, epochAcc: ep, targetEscrow: esc, targetMint: mint, burnMode: 0 });
  assert.equal(burnSettle.keys[4].isWritable, true);

  assert.throws(() => rewardSettleEpoch(rm, { cfg, epochAcc: ep, targetEscrow: esc, targetMint: mint, burnMode: 1 }));
  assert.throws(() => rewardSettleEpoch(rm, { cfg, epochAcc: ep, targetEscrow: esc, targetMint: mint, burnMode: 1, burnSink: esc }));
  const sinkSettle = rewardSettleEpoch(rm, { cfg, epochAcc: ep, targetEscrow: esc, targetMint: mint, burnMode: 1, burnSink: sink });
  assert.equal(sinkSettle.keys[4].isWritable, false);
  assert.equal(sinkSettle.keys[6].pubkey.equals(sink), true);

  const initBase = {
    cfg, mktAdmin: pk(), percolator: LEAN_MAINNET.percolator, dex: pk(), market: pk(),
    quoteMint: pk(), quoteVault: pk(), targetMint: mint, targetEscrow: esc,
    burnMode: 1 as const, epochSlots: 150n, minBatchQuote: 1_000_000n, reserveRateE6: 500_000n,
  };
  assert.throws(() => rewardInit(rm, initBase));
  assert.throws(() => rewardInit(rm, { ...initBase, burnSink: esc }));
  assert.doesNotThrow(() => rewardInit(rm, { ...initBase, burnSink: sink }));
});

test("withLegRefresh skips victim portfolio on Liquidate and refreshes only takeover liquidator's other legs", async () => {
  const perc = LEAN_MAINNET.percolator;
  const dex = pk(), mkt1 = pk(), mkt2 = pk(), victim = pk(), liqPfl = pk(), liqOwner = pk(), mint = pk(), vault = pk(), liqTok = pk();
  const victimBuf = mockPortfolioBuf(dex, pk(), [{ market: mkt1, side: SIDE.LONG }, { market: mkt2, side: SIDE.SHORT }]);
  const liqBuf = mockPortfolioBuf(dex, liqOwner, [{ market: mkt1, side: SIDE.LONG }, { market: mkt2, side: SIDE.SHORT }]);
  const acctMap = new Map<string, { owner: PublicKey; data: Buffer }>([
    [victim.toBase58(), { owner: perc, data: victimBuf }],
    [liqPfl.toBase58(), { owner: perc, data: liqBuf }],
  ]);
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => acctMap.get(k.toBase58()) ?? null),
  } as unknown as Connection;

  // Mode 0 fallback liquidate: 0 refreshes auto-inserted for victim
  const liq0 = liquidate(perc, { dex, mint, vault }, { market: mkt1, portfolio: victim, liquidatorToken: liqTok });
  const r0 = await withLegRefresh(conn, [liq0], { percolator: perc });
  assert.equal(r0.added, 0);
  assert.equal(r0.instructions.length, 1);

  // Mode 1 takeover liquidate: refreshes ONLY liqPfl's non-target leg (mkt2), NOT victim and NOT liqPfl's mkt1!
  const liq1 = liquidate(perc, { dex, mint, vault }, {
    market: mkt1, portfolio: victim, liquidatorToken: liqTok, mode: 1, reqQty: 0n, liqPortfolio: liqPfl, liqOwner,
  });
  const r1 = await withLegRefresh(conn, [liq1], { percolator: perc });
  assert.equal(r1.added, 1);
  assert.equal(r1.instructions[0].data[0], IX.RefreshLeg);
  assert.equal(r1.instructions[0].keys[1].pubkey.equals(mkt2), true);
  assert.equal(r1.instructions[0].keys[2].pubkey.equals(liqPfl), true);
});

test("realizeFlatLegs infers mainnet program ID from portfolio account owner", async () => {
  const dex = pk(), mkt = pk(), pfl = pk();
  const pflBuf = mockPortfolioBuf(dex, pk(), [{ market: mkt, side: SIDE.FLAT, posPnl: 500n }]);
  const mktBuf = mockMarketBuf(STATUS.ACTIVE);
  const conn = {
    getAccountInfo: async () => ({ owner: LEAN_MAINNET.percolator, data: pflBuf }),
    getMultipleAccountsInfo: async () => [{ owner: LEAN_MAINNET.percolator, data: mktBuf }],
  } as unknown as Connection;

  const ixs = await realizeFlatLegs(conn, pfl);
  assert.equal(ixs.length, 1);
  assert.equal(ixs[0].programId.equals(LEAN_MAINNET.percolator), true);
});
