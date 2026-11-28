import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  IX, PROP_AMM_IX, REWARD_IX, TRADE_MODE, MAGIC, LEAN_MAINNET, LEAN_DEVNET,
  LEAN_SOURCE_COMMIT, RAMP_FRONT_COOLDOWN, MAX_PRICE,
  DEX_SIZE, PORTFOLIO_SIZE, MARKET_SIZE, PROP_AMM_SIZE, REWARD_CFG_SIZE, EPOCH_SIZE, BIDDER_SIZE,
  DexOff, MktOff, PflOff, LegOff, PropOff, RewOff, EpochOff, BidOff, SIDE, STATUS, BPS_DEN,
  deriveDexVault,
  createMarket, adapterInit, rewardInit, sweepSurplus, claimReward,
  setPortfolioMatcher, tradeWithMatcher, propAmmInit, propAmmUpdate,
  liquidate, withdrawCollateral,
  accountKind, parseMarket, parsePropAmmCtx, parseRewardCfg, parseEpochState, parseBidReceipt,
  withLegRefresh, realizeFlatLegs, leanErrorName,
} from "../../src/lean/index.js";
import { computeClampedPush, crankOracleOnce } from "../../scripts/_lean-r3-crank.js";
import {
  isRewardEpochActive, computeOptimalBid, shouldSubmitBid, sendIdempotent,
  isReceiptFinalizedClosed, reconcileSavedState, withStateLock, saveStateAtomic,
  readInitialTokenBalance, isDirectEntrypoint, MIN_NET_USD, EPOCH_RENT_SOL,
} from "../../scripts/_lean-r3-reward-bid.js";
import { portfolioTotalCollateral, fetchMonitorSnapshot } from "../../scripts/_lean-oi-monitor.js";

const pk = () => Keypair.generate().publicKey;

function mockPortfolioBuf(
  dex: PublicKey, owner: PublicKey,
  legs: Array<{ market: PublicKey; side: number; posPnl?: bigint; lockedMm?: bigint }>,
  capital = 0n,
): Buffer {
  const b = Buffer.alloc(PORTFOLIO_SIZE);
  b.writeUInt32LE(MAGIC.PORTFOLIO, 0);
  b.writeUInt8(legs.length, PflOff.legCount);
  const totalLockedMm = legs.reduce((a, l) => a + (l.lockedMm ?? 0n), 0n);
  b.writeBigUInt64LE(totalLockedMm, PflOff.totalLockedMm);
  dex.toBuffer().copy(b, PflOff.dex);
  owner.toBuffer().copy(b, PflOff.owner);
  b.writeBigUInt64LE(capital, PflOff.capital);
  legs.forEach((leg, i) => {
    const o = PflOff.headerSize + i * PflOff.legStride;
    b.writeUInt8(1, o + LegOff.active);
    b.writeUInt8(leg.side, o + LegOff.side);
    b.writeBigUInt64LE(BigInt(i + 1), o + LegOff.marketId);
    leg.market.toBuffer().copy(b, o + LegOff.market);
    b.writeBigUInt64LE(leg.side === SIDE.FLAT ? 0n : 1_000_000n, o + LegOff.rawBasis);
    b.writeBigUInt64LE(leg.posPnl ?? 0n, o + LegOff.posPnl);
    b.writeBigUInt64LE(leg.lockedMm ?? 0n, o + LegOff.lockedMm);
  });
  return b;
}

function mockMarketBuf(status: number, dex?: PublicKey, lastRampSlot = 0n): Buffer {
  const b = Buffer.alloc(MARKET_SIZE);
  b.writeUInt32LE(MAGIC.MARKET, MktOff.magic);
  b.writeUInt8(status, MktOff.status);
  if (dex) dex.toBuffer().copy(b, MktOff.dex);
  b.writeBigUInt64LE(lastRampSlot, MktOff.lastRampSlot);
  return b;
}

test("r3 oracle crank downward clamp and 71d38f0 dt==1 half-step pacing never exceed on-chain maxAllowed", () => {
  // Previously (markPrice * 99n) / 100n exceeded maxAllowed by 1 whenever markPrice % 100n !== 0n.
  for (const markPrice of [90_000_000_001n, 90_000_000_099n, 67_432_154_321n, 100_000_000n]) {
    const maxMoveBps = 100n;
    const maxAllowed = (markPrice * maxMoveBps) / BPS_DEN;

    const down = computeClampedPush(markPrice, 1n, maxMoveBps, { slotGap: 2n, hasOpenState: true });
    assert.equal(markPrice - down <= maxAllowed, true);
    assert.equal(down, markPrice - maxAllowed);

    const up = computeClampedPush(markPrice, markPrice * 2n, maxMoveBps, { slotGap: 2n, hasOpenState: true });
    assert.equal(up - markPrice <= maxAllowed, true);
    assert.equal(up, markPrice + maxAllowed);

    // 71d38f0: loaded market with dt <= 1 halves maxMoveBps (100 >> 1 = 50 bps)
    const halfAllowed = (markPrice * (maxMoveBps >> 1n)) / BPS_DEN;
    assert.equal(computeClampedPush(markPrice, markPrice * 2n, maxMoveBps, { slotGap: 1n, hasOpenState: true }), markPrice + halfAllowed);
    assert.equal(computeClampedPush(markPrice, 1n, maxMoveBps, { slotGap: 0n, hasOpenState: true }), markPrice - halfAllowed);
  }
  // 71d38f0 empty market (OI == 0 && rawBasis == 0) fast-snaps directly to spot within [1, MAX_PRICE]
  assert.equal(computeClampedPush(100_000_000n, 200_000_000n, 100n, { slotGap: 1n, hasOpenState: false }), 200_000_000n);
  assert.equal(computeClampedPush(100_000_000n, 0n, 100n, { slotGap: 1n, hasOpenState: false }), 1n);
  assert.equal(computeClampedPush(100_000_000n, MAX_PRICE + 999n, 100n, { slotGap: 1n, hasOpenState: false }), MAX_PRICE);
  // Loaded market with maxMoveBps=1n does not halve to 0n
  assert.equal(computeClampedPush(100_000_000n, 200_000_000n, 1n, { slotGap: 1n, hasOpenState: true }), 100_010_000n);
  // Honors non-1% maxMoveBps and floors at >= 1n
  assert.equal(computeClampedPush(1_000_000n, 1n, 50n), 995_000n);
  assert.equal(computeClampedPush(1_000_000n, 999_000n, 100n), 999_000n);
  assert.equal(computeClampedPush(10n, 0n, 10_000n), 1n);
});

test("crankOracleOnce reuses signed tx through expiry, respects dt==1 half-step, and re-reads market on post-expiry replacement", async () => {
  const perc = LEAN_MAINNET.percolator;
  const market = pk();
  const funder = Keypair.generate();
  const oracle = Keypair.generate();
  const bh1 = Keypair.generate().publicKey.toBase58();
  const bh2 = Keypair.generate().publicKey.toBase58();

  const makeMkt = (markPrice: bigint, lastOracleSlot: bigint, oiLong: bigint) => {
    const b = Buffer.alloc(MARKET_SIZE);
    b.writeUInt32LE(MAGIC.MARKET, MktOff.magic);
    b.writeUInt8(STATUS.ACTIVE, MktOff.status);
    b.writeBigUInt64LE(markPrice, MktOff.markPrice);
    b.writeBigUInt64LE(lastOracleSlot, MktOff.lastOracleSlot);
    b.writeBigUInt64LE(9000n, MktOff.maxStaleness);
    b.writeBigUInt64LE(100n, MktOff.maxMoveBps);
    b.writeBigUInt64LE(oiLong, MktOff.oiLong);
    return b;
  };

  // Case 1: dt==1 loaded market + ambiguous timeout while blockhash valid -> half-step push & EXACT same tx rebroadcast
  const sent1: Buffer[] = [];
  let priceReads = 0;
  const connSameBh = {
    getAccountInfoAndContext: async () => ({
      context: { slot: 101 },
      value: { data: makeMkt(100_000_000n, 100n, 1_000_000n), owner: perc, lamports: 1, executable: false },
    }),
    getAccountInfo: async () => ({
      data: makeMkt(100_000_000n, 100n, 1_000_000n), owner: perc, lamports: 1, executable: false,
    }),
    getLatestBlockhash: async () => ({ blockhash: bh1, lastValidBlockHeight: 200 }),
    getBlockHeight: async () => 150,
    sendRawTransaction: async (raw: Buffer) => { sent1.push(Buffer.from(raw)); return "s1"; },
    confirmTransaction: async () => {
      if (sent1.length === 1) throw new Error("timed out waiting for confirmation");
      return { value: { err: null } };
    },
    getSignatureStatuses: async () => ({ value: [null] }),
  } as unknown as Connection;

  const r1 = await crankOracleOnce(connSameBh, {
    percolator: perc, market, funder, oracle, lazy: false,
    fetchPrice: async () => { priceReads++; return 110_000_000n; },
    retryDelayMs: 1,
  });
  assert.equal(r1.status, "pushed");
  assert.equal(r1.push, 100_500_000n); // half-step (50 bps) on dt==1 with OI > 0
  assert.equal(priceReads, 1);
  assert.equal(sent1.length, 2);
  assert.deepEqual(sent1[0], sent1[1]);

  // Case 2: blockhash expires without landing -> re-reads market + fresh price before signing replacement
  const sent2: Buffer[] = [];
  priceReads = 0;
  let bhCalls = 0;
  let ctxSlot = 101;
  const connExpired = {
    getAccountInfoAndContext: async () => {
      const s = ctxSlot;
      ctxSlot += 5; // by post-expiry replacement, slot gap is now >= 2
      return {
        context: { slot: s },
        value: { data: makeMkt(100_000_000n, 100n, 1_000_000n), owner: perc, lamports: 1, executable: false },
      };
    },
    getAccountInfo: async () => ({
      data: makeMkt(100_000_000n, 100n, 1_000_000n), owner: perc, lamports: 1, executable: false,
    }),
    getLatestBlockhash: async () => { bhCalls++; return { blockhash: bhCalls === 1 ? bh1 : bh2, lastValidBlockHeight: 200 }; },
    getBlockHeight: async () => 201, // expired
    sendRawTransaction: async (raw: Buffer) => { sent2.push(Buffer.from(raw)); return `s-${sent2.length}`; },
    confirmTransaction: async () => {
      if (sent2.length === 1) throw new Error("block height exceeded");
      return { value: { err: null } };
    },
    getSignatureStatuses: async () => ({ value: [null] }),
  } as unknown as Connection;

  const r2 = await crankOracleOnce(connExpired, {
    percolator: perc, market, funder, oracle, lazy: false,
    fetchPrice: async () => { priceReads++; return priceReads === 1 ? 110_000_000n : 100_750_000n; },
    retryDelayMs: 1,
  });
  assert.equal(r2.status, "pushed");
  assert.equal(priceReads, 2); // re-fetched fresh price after expiry
  assert.equal(r2.push, 100_750_000n); // fresh price clamped with updated dt >= 2
  assert.equal(sent2.length, 2);
  assert.notDeepEqual(sent2[0], sent2[1]);

  // Case 3: empty market (OI == 0 && rawBasis == 0) fast-snaps directly from 100 to 200 in 1 update
  const connEmpty = {
    getAccountInfoAndContext: async () => ({
      context: { slot: 101 },
      value: { data: makeMkt(100_000_000n, 100n, 0n), owner: perc, lamports: 1, executable: false },
    }),
    getAccountInfo: async () => ({
      data: makeMkt(100_000_000n, 100n, 0n), owner: perc, lamports: 1, executable: false,
    }),
    getLatestBlockhash: async () => ({ blockhash: bh1, lastValidBlockHeight: 200 }),
    getBlockHeight: async () => 150,
    sendRawTransaction: async () => "s-empty-snap",
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async () => ({ value: [null] }),
  } as unknown as Connection;
  const r3 = await crankOracleOnce(connEmpty, {
    percolator: perc, market, funder, oracle, lazy: false,
    fetchPrice: async () => 200_000_000n,
    retryDelayMs: 1,
  });
  assert.equal(r3.status, "pushed");
  assert.equal(r3.push, 200_000_000n);
});

test("r3 reward bidder detects active epoch via activeQuote (not stale activeEpochAcc) and accounts for existingBids", () => {
  // After SettleEpoch, activeEpochAcc remains non-zero while activeQuote == 0.
  assert.equal(isRewardEpochActive({ activeQuote: 0n }), false);
  assert.equal(isRewardEpochActive({ activeQuote: 1_000_000n }), true);

  // Sole bidder vs front-run epoch: existingBids strictly lowers optimal bid and returns 0n when unprofitable
  const Q = 50_000_000n; // $50 USDC
  const bVirt = 10_000_000n; // 0.01 SOL
  const sole = computeOptimalBid(Q, bVirt, 0n, 150, 0);
  assert.equal(sole.bStar > 0n, true);
  assert.equal(sole.netUsd > 0, true);

  const contested = computeOptimalBid(Q, bVirt, 250_000_000n, 150, 0);
  assert.equal(contested.bStar > 0n && contested.bStar < sole.bStar, true);
  assert.equal(contested.netUsd < sole.netUsd, true);

  const blownOut = computeOptimalBid(Q, bVirt, 500_000_000n, 150, 0);
  assert.equal(blownOut.bStar, 0n);
  assert.equal(blownOut.burnUsd, 0);

  // Live-epoch decision must include epoch rent and enforce MIN_NET_USD ($0.20)
  const marginal = computeOptimalBid(1_000_000n, 1_000_000n, 0n, 150, EPOCH_RENT_SOL);
  assert.equal(marginal.payoutUsd - marginal.burnUsd > 0, true);
  assert.equal(marginal.netUsd < MIN_NET_USD, true);
  assert.equal(shouldSubmitBid(marginal), false);
  assert.equal(shouldSubmitBid(sole), true);
});

test("sendIdempotent rebroadcasts same signed bytes until blockhash expiry and checks sig/receipt before replacing", async () => {
  const funder = Keypair.generate();
  const bh1 = Keypair.generate().publicKey.toBase58();
  const bh2 = Keypair.generate().publicKey.toBase58();
  const ix = SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: pk(), lamports: 1 });

  // Case 1: confirmation times out, but signature status shows confirmed -> must NOT re-send
  let sendCount = 0;
  const connBySig = {
    getLatestBlockhash: async () => ({ blockhash: bh1, lastValidBlockHeight: 100 }),
    getBlockHeight: async () => 50,
    sendRawTransaction: async () => { sendCount++; return "sig-1"; },
    confirmTransaction: async () => { throw new Error("timed out waiting for confirmation"); },
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
  } as unknown as Connection;
  const sig1 = await sendIdempotent(connBySig, [ix], [funder], { retryDelayMs: 1 });
  assert.equal(typeof sig1, "string");
  assert.equal(sendCount, 1);

  // Case 2: confirmation times out and sig status is null, but on-chain receipt already landed -> must NOT re-send
  sendCount = 0;
  let receiptLanded = false;
  const connByReceipt = {
    getLatestBlockhash: async () => ({ blockhash: bh1, lastValidBlockHeight: 100 }),
    getBlockHeight: async () => 50,
    sendRawTransaction: async () => { sendCount++; receiptLanded = true; return "sig-2"; },
    confirmTransaction: async () => { throw new Error("block height exceeded"); },
    getSignatureStatuses: async () => ({ value: [null] }),
  } as unknown as Connection;
  await sendIdempotent(connByReceipt, [ix], [funder], {
    alreadyLanded: async () => receiptLanded,
    retryDelayMs: 1,
  });
  assert.equal(sendCount, 1);

  // Case 3: still within valid blockhash window -> rebroadcasts EXACT SAME raw tx bytes (never signs a 2nd sig)
  const sentRaws: Buffer[] = [];
  let bhCalls = 0;
  const connRebroadcast = {
    getLatestBlockhash: async () => { bhCalls++; return { blockhash: bhCalls === 1 ? bh1 : bh2, lastValidBlockHeight: 100 }; },
    getBlockHeight: async () => 50, // still <= 100
    sendRawTransaction: async (raw: Buffer) => { sentRaws.push(Buffer.from(raw)); return "same"; },
    confirmTransaction: async () => {
      if (sentRaws.length === 1) throw new Error("timed out");
      return { value: { err: null } };
    },
    getSignatureStatuses: async () => ({ value: [null] }),
  } as unknown as Connection;
  await sendIdempotent(connRebroadcast, [ix], [funder], { alreadyLanded: async () => false, retryDelayMs: 1 });
  assert.equal(bhCalls, 1);
  assert.equal(sentRaws.length, 2);
  assert.deepEqual(sentRaws[0], sentRaws[1]);

  // Case 4: blockhash expired without landing -> calls onSigned BEFORE broadcast for both initial and replacement
  const expiredRaws: Buffer[] = [];
  const signedOrder: string[] = [];
  bhCalls = 0;
  const connExpired = {
    getLatestBlockhash: async () => { bhCalls++; return { blockhash: bhCalls === 1 ? bh1 : bh2, lastValidBlockHeight: 100 + bhCalls }; },
    getBlockHeight: async () => 150, // expired > 101
    sendRawTransaction: async (raw: Buffer) => { signedOrder.push("send"); expiredRaws.push(Buffer.from(raw)); return `s-${expiredRaws.length}`; },
    confirmTransaction: async () => {
      if (expiredRaws.length === 1) throw new Error("block height exceeded");
      return { value: { err: null } };
    },
    getSignatureStatuses: async () => ({ value: [null] }),
  } as unknown as Connection;
  await sendIdempotent(connExpired, [ix], [funder], {
    alreadyLanded: async () => false,
    onSigned: ({ lastValidBlockHeight }) => signedOrder.push(`signed:${lastValidBlockHeight}`),
    retryDelayMs: 1,
  });
  assert.equal(bhCalls, 2);
  assert.equal(expiredRaws.length, 2);
  assert.notDeepEqual(expiredRaws[0], expiredRaws[1]);
  assert.deepEqual(signedOrder, ["signed:101", "send", "signed:102", "send"]);

  // Case 5: confirmed tx error (e.g. another keeper settled first) rechecks alreadyLanded before failing
  let settledByOther = false;
  const connExternalSettler = {
    getLatestBlockhash: async () => ({ blockhash: bh1, lastValidBlockHeight: 100 }),
    getBlockHeight: async () => 50,
    sendRawTransaction: async () => { settledByOther = true; return "sig-race"; },
    confirmTransaction: async () => ({ value: { err: { InstructionError: [0, { Custom: 405 }] } } }),
    getSignatureStatuses: async () => ({ value: [{ err: { InstructionError: [0, { Custom: 405 }] }, confirmationStatus: "confirmed" }] }),
  } as unknown as Connection;
  const raceSig = await sendIdempotent(connExternalSettler, [ix], [funder], {
    alreadyLanded: async () => settledByOther,
    retryDelayMs: 1,
  });
  assert.equal(typeof raceSig, "string");

  // Case 6: confirmed tx error when intended state did NOT land must still reject
  await assert.rejects(() => sendIdempotent(connExternalSettler, [ix], [funder], {
    alreadyLanded: async () => false,
    retryDelayMs: 1,
  }), /failed/);

  // Case 7: 429 bursts on sendRawTransaction AND alreadyLanded() / getBlockHeight() back off and succeed on retry
  let send429Calls = 0;
  let alreadyLandedCalls = 0;
  let heightCalls = 0;
  const conn429Burst = {
    getLatestBlockhash: async () => ({ blockhash: bh1, lastValidBlockHeight: 100 }),
    getBlockHeight: async () => {
      heightCalls++;
      if (heightCalls === 1) throw new Error("429 Too Many Requests (getBlockHeight)");
      return 50;
    },
    sendRawTransaction: async () => {
      send429Calls++;
      if (send429Calls === 1) throw new Error("429 Too Many Requests (sendRawTransaction)");
      return "sig-after-429";
    },
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async () => ({ value: [null] }),
  } as unknown as Connection;
  const sigAfter429 = await sendIdempotent(conn429Burst, [ix], [funder], {
    alreadyLanded: async () => {
      alreadyLandedCalls++;
      // Fail attempt-0 pre-check, catch-block check after sendRawTransaction 429, and retry pre-check
      if (alreadyLandedCalls === 1 || alreadyLandedCalls === 3 || alreadyLandedCalls === 4) {
        throw new Error("429 Too Many Requests (alreadyLanded)");
      }
      return false;
    },
    maxRetries: 6,
    retryDelayMs: 1,
  });
  assert.equal(typeof sigAfter429, "string");
  assert.equal(send429Calls, 2);
  assert.equal(heightCalls, 2);
  assert.equal(alreadyLandedCalls >= 5, true);

  // Case 8 (P2): failed journal write in onSigned MUST NOT set `pending` or allow retry to skip persistence and broadcast
  let persistCalls = 0;
  let broadcastCalls = 0;
  const events: string[] = [];
  const connPersistFail = {
    getLatestBlockhash: async () => ({ blockhash: persistCalls === 0 ? bh1 : bh2, lastValidBlockHeight: 100 }),
    getBlockHeight: async () => 50,
    sendRawTransaction: async () => { broadcastCalls++; events.push("send"); return "sig-after-persist"; },
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async () => ({ value: [null] }),
  } as unknown as Connection;
  await sendIdempotent(connPersistFail, [ix], [funder], {
    onSigned: () => {
      persistCalls++;
      events.push(`persist:${persistCalls}`);
      if (persistCalls === 1) throw new Error("journal write timed out");
    },
    maxRetries: 3,
    retryDelayMs: 1,
  });
  assert.equal(persistCalls, 2);
  assert.equal(broadcastCalls, 1);
  assert.deepEqual(events, ["persist:1", "persist:2", "send"]);

  // If onSigned always fails, ZERO broadcasts may occur
  let neverSend = 0;
  const connAlwaysFailPersist = {
    ...connPersistFail,
    sendRawTransaction: async () => { neverSend++; return "never"; },
  } as unknown as Connection;
  await assert.rejects(() => sendIdempotent(connAlwaysFailPersist, [ix], [funder], {
    onSigned: () => { throw new Error("journal write timed out"); },
    maxRetries: 2,
    retryDelayMs: 1,
  }), /timed out/);
  assert.equal(neverSend, 0);
});

test("reconcileSavedState keeps dry runs read-only, validates cluster/wallet binding, creates USDC ATA on claim, and locks overlaps", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "perc-rbid-"));
  const stateFile = path.join(tmpDir, "state.json");
  const funder = Keypair.generate();
  const rm = LEAN_MAINNET.rewardModule, cfg = pk(), epPk = pk(), recPk = pk();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const mainnetGenesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

  const makeCfg = () => {
    const b = Buffer.alloc(REWARD_CFG_SIZE);
    b.writeUInt32LE(MAGIC.REWARD, RewOff.magic);
    return b;
  };
  const makeEp = (settled: boolean) => {
    const b = Buffer.alloc(EPOCH_SIZE);
    b.writeUInt32LE(MAGIC.EPOCH, EpochOff.magic);
    b.writeUInt8(settled ? 1 : 0, EpochOff.settled);
    cfg.toBuffer().copy(b, EpochOff.cfg);
    b.writeBigUInt64LE(10n, EpochOff.endSlot);
    return b;
  };
  const makeRec = () => {
    const b = Buffer.alloc(BIDDER_SIZE);
    b.writeUInt32LE(MAGIC.BID, BidOff.magic);
    cfg.toBuffer().copy(b, BidOff.cfg);
    epPk.toBuffer().copy(b, BidOff.epochAcc);
    funder.publicKey.toBuffer().copy(b, BidOff.bidder);
    b.writeBigUInt64LE(100n, BidOff.amount);
    return b;
  };

  const baseParams = {
    rm, cfg, targetEscrow: pk(), burnSink: pk(), quoteVault: pk(),
    usdc: pk(), usdcAta: pk(), funder, pollIntervalMs: 1,
  };

  // 1) Atomic journal write + dry run on wrong/empty RPC MUST NOT delete the recovery record!
  saveStateAtomic(stateFile, {
    genesisHash: mainnetGenesis, cfg: cfg.toBase58(), bidder: funder.publicKey.toBase58(),
    epoch: epPk.toBase58(), bidReceipt: recPk.toBase58(), stage: "bid",
  });
  const emptyConn = {
    getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", // devnet
    getAccountInfo: async () => null,
  } as unknown as Connection;
  assert.equal(await reconcileSavedState(emptyConn, stateFile, { ...baseParams, live: false }), "pending_dry");
  assert.equal(fs.existsSync(stateFile), true);

  // 2) Live run on wrong cluster (or missing RewardCfg / missing funded epoch) MUST reject and retain journal!
  await assert.rejects(() => reconcileSavedState(emptyConn, stateFile, { ...baseParams, live: true }), /not found on current RPC/);
  assert.equal(fs.existsSync(stateFile), true);

  const wrongGenesisConn = {
    getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    getAccountInfo: async (address: PublicKey) =>
      address.equals(cfg) ? { data: makeCfg(), owner: rm, lamports: 1, executable: false } : null,
  } as unknown as Connection;
  await assert.rejects(() => reconcileSavedState(wrongGenesisConn, stateFile, { ...baseParams, live: true }), /journal genesis/);
  assert.equal(fs.existsSync(stateFile), true);

  const missingBidEpochConn = {
    getGenesisHash: async () => mainnetGenesis,
    getAccountInfo: async (address: PublicKey) =>
      address.equals(cfg) ? { data: makeCfg(), owner: rm, lamports: 1, executable: false } : null,
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((address) => (address.equals(cfg) ? { data: makeCfg(), owner: rm, lamports: 1, executable: false } : null)),
  } as unknown as Connection;
  await assert.rejects(() => reconcileSavedState(missingBidEpochConn, stateFile, { ...baseParams, live: true }), /missing on RPC despite stage=bid/);
  assert.equal(fs.existsSync(stateFile), true);

  // 3) Live run on matching cluster settles unsettled epoch, prepends idempotent USDC ATA create to ClaimQuote, and clears journal
  let epSettled = false;
  let recClosed = false;
  const sentTxs: Transaction[] = [];
  const confirmCommitments: string[] = [];
  const lookup = (address: PublicKey) => {
    if (address.equals(cfg)) return { data: makeCfg(), owner: rm, lamports: 1, executable: false };
    if (address.equals(epPk)) return { data: makeEp(epSettled), owner: rm, lamports: 1, executable: false };
    if (address.equals(recPk)) return recClosed ? null : { data: makeRec(), owner: rm, lamports: 1, executable: false };
    return null;
  };
  const conn = {
    getGenesisHash: async () => mainnetGenesis,
    getSlot: async () => 20,
    getBlockHeight: async () => 50,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    getAccountInfo: async (address: PublicKey) => lookup(address),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => lookup(k)),
    sendRawTransaction: async (raw: Buffer) => {
      const tx = Transaction.from(raw);
      sentTxs.push(tx);
      const lastIx = tx.instructions[tx.instructions.length - 1];
      if (lastIx.data[0] === REWARD_IX.SettleEpoch) epSettled = true;
      if (lastIx.data[0] === REWARD_IX.ClaimQuote) recClosed = true;
      return `sig-${sentTxs.length}`;
    },
    confirmTransaction: async (_s: unknown, commitment?: string) => {
      confirmCommitments.push(commitment ?? "default");
      // Journal MUST remain on disk until finalized claim confirmation completes
      assert.equal(fs.existsSync(stateFile), true);
      return { value: { err: null } };
    },
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "finalized" }] }),
  } as unknown as Connection;

  // 4) Exclusive OS flock blocks overlapping runs and releases cleanly afterward
  await withStateLock(stateFile, async () => {
    await assert.rejects(() => withStateLock(stateFile, async () => {}), /lock already held/);
    assert.equal(await reconcileSavedState(conn, stateFile, { ...baseParams, live: true }), "reconciled");
  });
  await withStateLock(stateFile, async () => {}); // immediately re-acquirable after release
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(sentTxs.length, 2);
  assert.equal(sentTxs[0].instructions[0].data[0], REWARD_IX.SettleEpoch);
  // Claim tx must idempotently create the USDC ATA right before ClaimQuote and wait for finalized commitment
  assert.equal(sentTxs[1].instructions.length, 2);
  assert.equal(sentTxs[1].instructions[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID), true);
  assert.equal(sentTxs[1].instructions[0].data[0], 1); // CreateIdempotent
  assert.equal(sentTxs[1].instructions[1].data[0], REWARD_IX.ClaimQuote);
  assert.deepEqual(confirmCommitments, ["confirmed", "finalized"]);

  // 5a) P2 commitment-lag: confirmed shows settled + absent receipt while finalized lags for 2 polls before catching up
  //     -> MUST send 0 ClaimQuote txs and clear stateFile ONLY after finalized confirms closure
  saveStateAtomic(stateFile, {
    genesisHash: mainnetGenesis, cfg: cfg.toBase58(), bidder: funder.publicKey.toBase58(),
    epoch: epPk.toBase58(), bidReceipt: recPk.toBase58(), stage: "bid",
  });
  let lagFinalizedPolls = 0;
  let lagSendCount = 0;
  const lagConn = {
    getGenesisHash: async () => mainnetGenesis,
    getSlot: async () => 20,
    getBlockHeight: async () => 50,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(cfg)) return { data: makeCfg(), owner: rm, lamports: 1, executable: false };
      if (address.equals(epPk)) return { data: makeEp(true), owner: rm, lamports: 1, executable: false };
      return null;
    },
    getMultipleAccountsInfo: async (keys: PublicKey[], commitment?: string) => {
      if (commitment === "finalized") {
        lagFinalizedPolls++;
        // While finalized still lags, stateFile MUST still be on disk
        assert.equal(fs.existsSync(stateFile), true);
        const finalizedSettled = lagFinalizedPolls >= 3;
        return keys.map((k) => (k.equals(epPk) ? { data: makeEp(finalizedSettled), owner: rm, lamports: 1, executable: false } : null));
      }
      return keys.map((k) => (k.equals(epPk) ? { data: makeEp(true), owner: rm, lamports: 1, executable: false } : null));
    },
    sendRawTransaction: async () => { lagSendCount++; return "unexpected"; },
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
  } as unknown as Connection;
  assert.equal(
    await reconcileSavedState(lagConn, stateFile, { ...baseParams, live: true, finalizeWaitMs: 500, pollIntervalMs: 1 }),
    "reconciled",
  );
  assert.equal(lagFinalizedPolls, 3);
  assert.equal(lagSendCount, 0);
  assert.equal(fs.existsSync(stateFile), false);

  // 5b) P1/P2 reorg revival: confirmed initially shows settled + absent receipt while finalized lags,
  //     then a reorg revives bidReceipt at confirmed -> falls back to submitting ClaimQuote and clears journal
  saveStateAtomic(stateFile, {
    genesisHash: mainnetGenesis, cfg: cfg.toBase58(), bidder: funder.publicKey.toBase58(),
    epoch: epPk.toBase58(), bidReceipt: recPk.toBase58(), stage: "bid",
  });
  let claimSubmitted = false;
  let reviveConfirmedReads = 0;
  let reviveConfirmCommitment: string | undefined;
  const reviveConn = {
    getGenesisHash: async () => mainnetGenesis,
    getSlot: async () => 20,
    getBlockHeight: async () => 50,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(cfg)) return { data: makeCfg(), owner: rm, lamports: 1, executable: false };
      if (address.equals(epPk)) return { data: makeEp(true), owner: rm, lamports: 1, executable: false };
      return null;
    },
    getMultipleAccountsInfo: async (keys: PublicKey[], commitment?: string) => {
      if (commitment === "finalized") {
        // Before claim finalizes, finalized snapshot is still unsettled; after claim confirms at finalized, closed
        return keys.map((k) => (k.equals(epPk) ? { data: makeEp(claimSubmitted), owner: rm, lamports: 1, executable: false } : null));
      }
      reviveConfirmedReads++;
      // Initial read + post-settle check show null receipt; poll recheck sees receipt revived at confirmed
      const showRec = reviveConfirmedReads >= 3;
      return keys.map((k) => {
        if (k.equals(epPk)) return { data: makeEp(true), owner: rm, lamports: 1, executable: false };
        if (k.equals(recPk) && showRec) return { data: makeRec(), owner: rm, lamports: 1, executable: false };
        return null;
      });
    },
    sendRawTransaction: async (raw: Buffer) => {
      const tx = Transaction.from(raw);
      assert.equal(tx.instructions[tx.instructions.length - 1].data[0], REWARD_IX.ClaimQuote);
      claimSubmitted = true;
      return "sig-claim-after-revive";
    },
    confirmTransaction: async (_s: unknown, commitment?: string) => {
      reviveConfirmCommitment = commitment;
      assert.equal(fs.existsSync(stateFile), true);
      return { value: { err: null } };
    },
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "finalized" }] }),
  } as unknown as Connection;
  assert.equal(
    await reconcileSavedState(reviveConn, stateFile, { ...baseParams, live: true, finalizeWaitMs: 500, pollIntervalMs: 1 }),
    "reconciled",
  );
  assert.equal(claimSubmitted, true);
  assert.equal(reviveConfirmCommitment, "finalized");
  assert.equal(fs.existsSync(stateFile), false);

  // 5b-ii) P1: Claim confirmed ONLY at `confirmed` (never reaches `finalized`) MUST NOT delete stateFile
  saveStateAtomic(stateFile, {
    genesisHash: mainnetGenesis, cfg: cfg.toBase58(), bidder: funder.publicKey.toBase58(),
    epoch: epPk.toBase58(), bidReceipt: recPk.toBase58(), stage: "bid",
  });
  let nonFinalClaimSends = 0;
  const confirmedOnlyClaimConn = {
    getGenesisHash: async () => mainnetGenesis,
    getSlot: async () => 20,
    getBlockHeight: async () => 50,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(cfg)) return { data: makeCfg(), owner: rm, lamports: 1, executable: false };
      if (address.equals(epPk)) return { data: makeEp(true), owner: rm, lamports: 1, executable: false };
      if (address.equals(recPk)) return { data: makeRec(), owner: rm, lamports: 1, executable: false };
      return null;
    },
    getMultipleAccountsInfo: async (keys: PublicKey[], commitment?: string) => {
      if (commitment === "finalized") {
        return keys.map((k) => (k.equals(epPk) ? { data: makeEp(false), owner: rm, lamports: 1, executable: false } : null));
      }
      return keys.map((k) => {
        if (k.equals(epPk)) return { data: makeEp(true), owner: rm, lamports: 1, executable: false };
        if (k.equals(recPk)) return { data: makeRec(), owner: rm, lamports: 1, executable: false };
        return null;
      });
    },
    sendRawTransaction: async () => { nonFinalClaimSends++; return "sig-confirmed-only"; },
    confirmTransaction: async (_s: unknown, commitment?: string) => {
      assert.equal(commitment, "finalized");
      throw new Error("finalization error (not finalized)");
    },
    // Transaction reached `confirmed` only, NOT `finalized`!
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
  } as unknown as Connection;
  await assert.rejects(
    () => reconcileSavedState(confirmedOnlyClaimConn, stateFile, { ...baseParams, live: true, pollIntervalMs: 1 }),
    /not finalized/,
  );
  assert.equal(nonFinalClaimSends, 1);
  assert.equal(fs.existsSync(stateFile), true);

  // 5c) P1/P2 finalization timeout: confirmed shows settled + absent receipt while finalized NEVER confirms
  //     -> MUST send 0 ClaimQuote txs, throw on timeout, and preserve stateFile on disk
  saveStateAtomic(stateFile, {
    genesisHash: mainnetGenesis, cfg: cfg.toBase58(), bidder: funder.publicKey.toBase58(),
    epoch: epPk.toBase58(), bidReceipt: recPk.toBase58(), stage: "bid",
  });
  let timeoutSendCount = 0;
  const staleReceiptConn = {
    getGenesisHash: async () => mainnetGenesis,
    getSlot: async () => 20,
    getBlockHeight: async () => 50,
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(cfg)) return { data: makeCfg(), owner: rm, lamports: 1, executable: false };
      if (address.equals(epPk)) return { data: makeEp(true), owner: rm, lamports: 1, executable: false };
      return null;
    },
    getMultipleAccountsInfo: async (keys: PublicKey[], commitment?: string) => {
      if (commitment === "finalized") {
        // Stale finalized snapshot: epoch NOT settled yet, receipt returns null (pre-bid stale)
        return keys.map((k) => (k.equals(epPk) ? { data: makeEp(false), owner: rm, lamports: 1, executable: false } : null));
      }
      // Confirmed snapshot shows settled epoch, absent receipt
      return keys.map((k) => (k.equals(epPk) ? { data: makeEp(true), owner: rm, lamports: 1, executable: false } : null));
    },
    sendRawTransaction: async () => { timeoutSendCount++; return "unexpected"; },
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
  } as unknown as Connection;
  assert.equal(await isReceiptFinalizedClosed(staleReceiptConn, rm, cfg, epPk, recPk), false);
  await assert.rejects(
    () => reconcileSavedState(staleReceiptConn, stateFile, { ...baseParams, live: true, finalizeWaitMs: 20, pollIntervalMs: 5 }),
    /not confirmed at finalized/,
  );
  assert.equal(timeoutSendCount, 0);
  assert.equal(fs.existsSync(stateFile), true);

  // Finalized snapshot with ep.settled === true AND receipt absent proves closure (0 txs)
  saveStateAtomic(stateFile, {
    genesisHash: mainnetGenesis, cfg: cfg.toBase58(), bidder: funder.publicKey.toBase58(),
    epoch: epPk.toBase58(), bidReceipt: recPk.toBase58(), stage: "bid",
  });
  let finalizedSendCount = 0;
  const finalizedClosedConn = {
    ...staleReceiptConn,
    getMultipleAccountsInfo: async (keys: PublicKey[], commitment?: string) => {
      assert.ok(commitment === "confirmed" || commitment === "finalized");
      return keys.map((k) => (k.equals(epPk) ? { data: makeEp(true), owner: rm, lamports: 1, executable: false } : null));
    },
    sendRawTransaction: async () => { finalizedSendCount++; return "unexpected"; },
  } as unknown as Connection;
  assert.equal(await isReceiptFinalizedClosed(finalizedClosedConn, rm, cfg, epPk, recPk), true);
  assert.equal(await reconcileSavedState(finalizedClosedConn, stateFile, { ...baseParams, live: true }), "reconciled");
  assert.equal(finalizedSendCount, 0);
  assert.equal(fs.existsSync(stateFile), false);

  // 6) P2: In-flight stage="started" journal MUST NOT be deleted while startSig is valid, processing, or account snapshot lags expiry slot
  saveStateAtomic(stateFile, {
    genesisHash: mainnetGenesis, cfg: cfg.toBase58(), bidder: funder.publicKey.toBase58(),
    epoch: epPk.toBase58(), startSig: "start-sig-1", startLastValidBlockHeight: 500, stage: "started",
  });
  let finalizedHeight = 450;
  let finalizedSlot = 1000;
  let snapshotSlot = 1000;
  let observedMinContextSlot: number | undefined;
  let startSigStatus: { err: unknown; confirmationStatus?: string; slot?: number } | null = null;
  const startConn = {
    getGenesisHash: async () => mainnetGenesis,
    getEpochInfo: async () => ({ absoluteSlot: finalizedSlot, blockHeight: finalizedHeight, epoch: 1, slotIndex: 0, slotsInEpoch: 1000 }),
    getSignatureStatuses: async () => ({ value: [startSigStatus] }),
    getAccountInfo: async (address: PublicKey) =>
      address.equals(cfg) ? { data: makeCfg(), owner: rm, lamports: 1, executable: false } : null,
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[], opts?: { commitment?: string; minContextSlot?: number }) => {
      observedMinContextSlot = opts?.minContextSlot;
      return {
        context: { slot: snapshotSlot },
        value: keys.map((k) => (k.equals(cfg) ? { data: makeCfg(), owner: rm, lamports: 1, executable: false } : null)),
      };
    },
  } as unknown as Connection;

  // Still within valid blockhash window -> MUST reject & keep journal
  await assert.rejects(() => reconcileSavedState(startConn, stateFile, { ...baseParams, live: true }), /still valid/);
  assert.equal(fs.existsSync(stateFile), true);

  // Signature is confirmed/processing (even past expiry) -> MUST reject & keep journal
  startSigStatus = { err: null, confirmationStatus: "confirmed" };
  await assert.rejects(() => reconcileSavedState(startConn, stateFile, { ...baseParams, live: true }), /confirmed\/processing/);
  assert.equal(fs.existsSync(stateFile), true);

  // Past expiry height, but lagging replica returns account snapshot from BEFORE finalized expiry slot -> MUST reject & keep journal
  startSigStatus = null;
  finalizedHeight = 501;
  finalizedSlot = 1200;
  snapshotSlot = 1150;
  await assert.rejects(() => reconcileSavedState(startConn, stateFile, { ...baseParams, live: true }), /snapshot slot 1150 < required minSlot 1200/);
  assert.equal(observedMinContextSlot, 1200);
  assert.equal(fs.existsSync(stateFile), true);

  // Snapshot slot >= finalized expiry slot AND [cfg, epoch] confirms absence -> clears journal
  snapshotSlot = 1200;
  assert.equal(await reconcileSavedState(startConn, stateFile, { ...baseParams, live: true }), "reconciled");
  assert.equal(fs.existsSync(stateFile), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("readInitialTokenBalance returns 0n only for confirmed missing token account and null on transient RPC error", async () => {
  const ata = pk();
  const missingConn = { getAccountInfo: async () => null } as unknown as Connection;
  assert.equal(await readInitialTokenBalance(missingConn, ata), 0n);

  const wrongOwnerConn = {
    getAccountInfo: async () => ({ owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 1, executable: false }),
  } as unknown as Connection;
  assert.equal(await readInitialTokenBalance(wrongOwnerConn, ata), 0n);

  const rpcErrConn = {
    getAccountInfo: async () => { throw new Error("429 Too Many Requests"); },
  } as unknown as Connection;
  assert.equal(await readInitialTokenBalance(rpcErrConn, ata), null);

  const tokBuf = Buffer.alloc(165);
  pk().toBuffer().copy(tokBuf, 0);
  pk().toBuffer().copy(tokBuf, 32);
  tokBuf.writeBigUInt64LE(12_345_678n, 64);
  tokBuf.writeUInt8(1, 108); // AccountState.Initialized
  const okConn = {
    getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data: tokBuf, lamports: 1, executable: false }),
  } as unknown as Connection;
  assert.equal(await readInitialTokenBalance(okConn, ata), 12_345_678n);
});

test("withStateLock uses OS flock: ignores 0-byte crash files, releases automatically on SIGKILL, and admits only 1 concurrent winner", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "perc-flock-"));
  const stateFile = path.join(tmpDir, "state.json");
  const lockFile = `${stateFile}.lock`;

  // 1) Pre-existing 0-byte file (e.g. crash during legacy file creation) must NOT block acquisition
  fs.writeFileSync(lockFile, "");
  let ran = false;
  await withStateLock(stateFile, async () => { ran = true; });
  assert.equal(ran, true);

  // 2) Spawn a separate Node process that directly owns the OS flock (no background helper child), verify exclusion, then SIGKILL it
  const holderScript = `
    import { withStateLock } from "./scripts/_lean-r3-reward-bid.js";
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await withStateLock(process.argv[1], async () => {
        console.log("LOCKED");
        await new Promise(() => {});
      });
    } finally {
      clearInterval(keepAlive);
    }
  `;
  const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", holderScript, stateFile], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let out = "";
      holder.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        if (out.includes("LOCKED")) resolve();
      });
      holder.once("exit", (code) => reject(new Error(`holder exited early with ${code}`)));
    });

    // Holder is still alive and owns the flock directly with ZERO flock helper child processes
    assert.equal(holder.exitCode, null);
    const childCheck = spawnSync("pgrep", ["-P", String(holder.pid), "-f", "flock|Fcntl|fcntl"], { encoding: "utf8" });
    if (!childCheck.error) {
      assert.equal((childCheck.stdout ?? "").trim(), "");
    }

    // While live holder runs, our process MUST be refused
    await assert.rejects(() => withStateLock(stateFile, async () => {}), /lock already held/);

    // Hard SIGKILL the holder -> kernel immediately closes holder's fd and releases flock (no helper wait!)
    const exited = new Promise<void>((resolve) => holder.once("close", () => resolve()));
    holder.kill("SIGKILL");
    await exited;
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill("SIGKILL");
    }
  }

  // Immediately race 5 concurrent contenders: EXACTLY 1 wins!
  let active = 0;
  let maxActive = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      withStateLock(stateFile, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 80));
        active--;
        return "won";
      }),
    ),
  );
  const winners = outcomes.filter((o) => o.status === "fulfilled");
  const losers = outcomes.filter((o) => o.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 4);
  assert.equal(maxActive, 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("r3 OI monitor tracks free capital + totalLockedMm and reads DEX + SPL vault in one RPC snapshot", async () => {
  const dex = pk();
  const [vault] = deriveDexVault(LEAN_MAINNET.percolator, dex);
  const market = pk(), vaultPfl = pk(), userLong = pk();

  const dexBuf = Buffer.alloc(DEX_SIZE);
  dexBuf.writeUInt32LE(MAGIC.DEX, DexOff.magic);
  vault.toBuffer().copy(dexBuf, DexOff.vaultPda);
  dexBuf.writeBigUInt64LE(46_000_000n, DexOff.vaultBalance);
  dexBuf.writeBigUInt64LE(23_000_000n, DexOff.totalCapital);
  dexBuf.writeBigUInt64LE(23_000_000n, DexOff.totalInsurance);

  const vaultBuf = Buffer.alloc(165);
  vaultBuf.writeBigUInt64LE(46_000_000n, 64);

  const mktBuf = mockMarketBuf(STATUS.ACTIVE);
  const vPflBuf = mockPortfolioBuf(dex, pk(), [], 23_000_000n);
  const uPflBuf = mockPortfolioBuf(dex, pk(), [{ market, side: SIDE.LONG, lockedMm: 16_000_000n }], 7_000_000n);
  assert.equal(portfolioTotalCollateral(uPflBuf), 23_000_000n);

  let multiCalls = 0;
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      multiCalls++;
      assert.equal(keys.length, 5);
      return [dexBuf, vaultBuf, mktBuf, vPflBuf, uPflBuf].map((data) => ({
        data, owner: LEAN_MAINNET.percolator, lamports: 1, executable: false,
      }));
    },
    getAccountInfo: async () => { throw new Error("must not make split getAccountInfo calls"); },
    getTokenAccountBalance: async () => { throw new Error("must not make split getTokenAccountBalance calls"); },
  } as unknown as Connection;

  const snap = await fetchMonitorSnapshot(conn, { dex, vault, market, vaultPfl, userLong });
  assert.equal(multiCalls, 1);
  assert.equal(snap?.consOk, true);
  assert.equal(snap?.consTag, "OK");
  assert.equal(snap?.spl, 46_000_000n);
  assert.equal(snap?.uCap, 23_000_000n);

  // Closed prize portfolios: 1-lamport SystemProgram 0-byte dust and MAGIC.CLOSED ("DEAD") return -1n without throwing
  const deadPflBuf = Buffer.alloc(PORTFOLIO_SIZE);
  deadPflBuf.writeUInt32LE(MAGIC.CLOSED, 0);
  assert.equal(portfolioTotalCollateral(Buffer.alloc(0)), -1n);
  assert.equal(portfolioTotalCollateral(Buffer.alloc(16)), -1n);
  assert.equal(portfolioTotalCollateral(deadPflBuf), -1n);

  const closedConn = {
    getMultipleAccountsInfo: async () => [
      { data: dexBuf, owner: LEAN_MAINNET.percolator, lamports: 1, executable: false },
      { data: vaultBuf, owner: LEAN_MAINNET.percolator, lamports: 1, executable: false },
      { data: mktBuf, owner: LEAN_MAINNET.percolator, lamports: 1, executable: false },
      { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 1, executable: false },
      { data: deadPflBuf, owner: LEAN_MAINNET.percolator, lamports: 1, executable: false },
    ],
  } as unknown as Connection;
  const closedSnap = await fetchMonitorSnapshot(closedConn, { dex, vault, market, vaultPfl, userLong });
  assert.equal(closedSnap?.vCap, -1n);
  assert.equal(closedSnap?.uCap, -1n);
  assert.equal(closedSnap?.consOk, true);

  // Spoofed valid "PFLO" owned by a foreign program is also treated as -1n (CLOSED)
  const spoofConn = {
    getMultipleAccountsInfo: async () => [
      { data: dexBuf, owner: LEAN_MAINNET.percolator, lamports: 1, executable: false },
      { data: vaultBuf, owner: LEAN_MAINNET.percolator, lamports: 1, executable: false },
      { data: mktBuf, owner: LEAN_MAINNET.percolator, lamports: 1, executable: false },
      { data: vPflBuf, owner: pk(), lamports: 1, executable: false },
      { data: uPflBuf, owner: LEAN_MAINNET.percolator, lamports: 1, executable: false },
    ],
  } as unknown as Connection;
  const spoofSnap = await fetchMonitorSnapshot(spoofConn, { dex, vault, market, vaultPfl, userLong });
  assert.equal(spoofSnap?.vCap, -1n);
  assert.equal(spoofSnap?.uCap, 23_000_000n);
});

test("core ops 20-23 builders match e189ef2 layout and accounts", () => {
  const prog = LEAN_MAINNET.percolator;
  const v = { dex: pk(), mint: pk(), vault: pk() };
  const admin = pk(), feeVault = pk(), mkt1 = pk(), mkt2 = pk(), rewAuth = pk(), dest = pk();

  const sw = sweepSurplus(prog, v, { admin, feeVault, amount: 42n });
  assert.equal(sw.data.length, 9);
  assert.equal(sw.data[0], IX.SweepSurplus);
  assert.equal(sw.data.readBigUInt64LE(1), 42n);
  assert.equal(sw.keys.length, 6);
  assert.equal(sw.keys[1].isSigner, true);
  assert.equal(sw.keys[4].isWritable, true);

  const cr = claimReward(prog, v, { market: mkt1, rewardRecipient: rewAuth, destToken: dest, amount: 99n });
  assert.equal(cr.data.length, 9);
  assert.equal(cr.data[0], IX.ClaimReward);
  assert.equal(cr.data.readBigUInt64LE(1), 99n);
  assert.equal(cr.keys.length, 7);
  assert.equal(cr.keys[2].isSigner, true);

  const pfl = pk(), owner = pk(), ctx = pk();
  const bind = setPortfolioMatcher(prog, { portfolio: pfl, owner, matcherCtx: ctx });
  assert.deepEqual(bind.data, Buffer.from([IX.SetPortfolioMatcher]));
  assert.equal(bind.keys.length, 3);
  const unbind = setPortfolioMatcher(prog, { portfolio: pfl, owner });
  assert.equal(unbind.keys.length, 2);

  const lpPfl = pk(), matcherProg = LEAN_DEVNET.matcher, extra = pk();
  const twm = tradeWithMatcher(prog, {
    dex: v.dex, takerPortfolio: pfl, takerOwner: owner, lpPortfolio: lpPfl,
    matcherProg, matcherCtx: ctx, extraAcc: extra,
    offers: [
      { market: mkt1, mode: TRADE_MODE.OPEN, takerIsLong: true, maxQty: 100n, limitPrice: 500n },
      { market: mkt2, mode: TRADE_MODE.FLIP, takerIsLong: false, maxQty: 200n, limitPrice: 0n },
    ],
  });
  assert.equal(twm.data.length, 2 + 2 * 18);
  assert.equal(twm.data[0], IX.TradeWithMatcher);
  assert.equal(twm.data[1], 2);
  assert.equal(twm.data[2], TRADE_MODE.OPEN);
  assert.equal(twm.data[3], 1);
  assert.equal(twm.data.readBigUInt64LE(4), 100n);
  assert.equal(twm.data.readBigUInt64LE(12), 500n);
  assert.equal(twm.data[20], TRADE_MODE.FLIP);
  assert.equal(twm.data[21], 0);
  assert.equal(twm.keys.length, 6 + 2 + 1);
  assert.equal(twm.keys[6].pubkey.equals(mkt1), true);
  assert.equal(twm.keys[7].pubkey.equals(mkt2), true);
  assert.equal(twm.keys[8].pubkey.equals(extra), true);
  assert.equal(twm.keys[8].isWritable, false);

  assert.throws(() => tradeWithMatcher(prog, {
    dex: v.dex, takerPortfolio: pfl, takerOwner: owner, lpPortfolio: lpPfl, matcherProg, matcherCtx: ctx, offers: [],
  }), RangeError);
  assert.throws(() => tradeWithMatcher(prog, {
    dex: v.dex, takerPortfolio: pfl, takerOwner: owner, lpPortfolio: lpPfl, matcherProg, matcherCtx: ctx,
    offers: [{ market: mkt1, mode: TRADE_MODE.HANDOFF_LONG, takerIsLong: true, maxQty: 1n, limitPrice: 0n }],
  }), RangeError);
});

test("PropAMM builders and parsers match e189ef2 Matcher.lean (272B MRET)", () => {
  const mProg = LEAN_DEVNET.matcher, ctx = pk(), owner = pk();
  const initIx = propAmmInit(mProg, {
    ctx, owner, paused: false, halfSpreadBps: 25n, impactBps: 10n, maxFillQty: 5_000_000n, allowedMarkets: [1n, 3n],
  });
  assert.equal(initIx.data.length, 28 + 16);
  assert.equal(initIx.data[0], PROP_AMM_IX.Init);
  assert.equal(initIx.data[2], 2);
  assert.equal(initIx.data.readBigUInt64LE(28), 1n);
  assert.equal(initIx.data.readBigUInt64LE(36), 3n);
  assert.equal(initIx.keys.length, 2);

  const updIx = propAmmUpdate(mProg, {
    ctx, owner, paused: true, halfSpreadBps: 50n, impactBps: 20n, maxFillQty: 1_000_000n,
  });
  assert.equal(updIx.data.length, 28);
  assert.equal(updIx.data[0], PROP_AMM_IX.Update);
  assert.equal(updIx.data[1], 1);

  assert.throws(() => propAmmInit(mProg, {
    ctx, owner, halfSpreadBps: 25n, impactBps: 0n, maxFillQty: 1n, allowedMarkets: [],
  }), RangeError);
  assert.throws(() => propAmmInit(mProg, {
    ctx, owner, halfSpreadBps: 25n, impactBps: 0n, maxFillQty: 1n, allowedMarkets: [0n],
  }), RangeError);

  const buf = Buffer.alloc(PROP_AMM_SIZE);
  buf.writeUInt32LE(MAGIC.MRET, PropOff.magic);
  buf.writeUInt32LE(0, PropOff.status);
  buf.writeBigUInt64LE(7n, PropOff.seq);
  buf.writeBigUInt64LE(100_000_000n, PropOff.quotesBase);
  buf.writeBigUInt64LE(500_000n, PropOff.quotesBase + 8);
  owner.toBuffer().copy(buf, PropOff.owner);
  buf.writeBigUInt64LE(25n, PropOff.halfSpreadBps);
  buf.writeBigUInt64LE(10n, PropOff.impactBps);
  buf.writeBigUInt64LE(5_000_000n, PropOff.maxFillQty);
  buf.writeUInt8(1, PropOff.paused);
  buf.writeUInt8(2, PropOff.allowedCount);
  buf.writeBigUInt64LE(1n, PropOff.allowedMarkets);
  buf.writeBigUInt64LE(3n, PropOff.allowedMarkets + 8);

  assert.equal(accountKind(buf), "propAmmCtx");
  const parsed = parsePropAmmCtx(buf);
  assert.equal(parsed.seq, 7n);
  assert.equal(parsed.owner.equals(owner), true);
  assert.equal(parsed.paused, true);
  assert.deepEqual(parsed.allowedMarkets, [1n, 3n]);
  assert.deepEqual(parsed.quotes[0], { execPrice: 100_000_000n, fillQty: 500_000n });
});

test("RewardModule account parsers parse RewardCfg, EpochState, and BidReceipt", () => {
  const cfgKey = pk(), epKey = pk(), bidder = pk(), sink = pk();
  const cfgBuf = Buffer.alloc(REWARD_CFG_SIZE);
  cfgBuf.writeUInt32LE(MAGIC.REWARD, RewOff.magic);
  cfgBuf.writeUInt8(1, RewOff.burnMode);
  cfgBuf.writeUInt8(6, RewOff.quoteDecimals);
  cfgBuf.writeUInt8(9, RewOff.targetDecimals);
  sink.toBuffer().copy(cfgBuf, RewOff.burnSinkTok);
  epKey.toBuffer().copy(cfgBuf, RewOff.activeEpochAcc);
  cfgBuf.writeBigUInt64LE(32n, RewOff.epochSlots);
  cfgBuf.writeBigUInt64LE(1_000_000n, RewOff.minBatchQuote);
  cfgBuf.writeBigUInt64LE(500_000n, RewOff.reserveRateE6);
  cfgBuf.writeBigUInt64LE(0n, RewOff.activeQuote);
  cfgBuf.writeBigUInt64LE(2_500_000n, RewOff.rolloverQuote);

  assert.equal(accountKind(cfgBuf), "rewardCfg");
  const cfg = parseRewardCfg(cfgBuf);
  assert.equal(cfg.burnMode, 1);
  assert.equal(cfg.burnSinkTok?.equals(sink), true);
  assert.equal(cfg.activeEpochAcc?.equals(epKey), true);
  assert.equal(cfg.activeQuote, 0n);
  assert.equal(cfg.rolloverQuote, 2_500_000n);
  assert.equal(isRewardEpochActive(cfg), false);

  const epBuf = Buffer.alloc(EPOCH_SIZE);
  epBuf.writeUInt32LE(MAGIC.EPOCH, EpochOff.magic);
  epBuf.writeUInt8(0, EpochOff.settled);
  cfgKey.toBuffer().copy(epBuf, EpochOff.cfg);
  epBuf.writeBigUInt64LE(4n, EpochOff.epochId);
  epBuf.writeBigUInt64LE(10_000_000n, EpochOff.quotePot);
  epBuf.writeBigUInt64LE(2_000_000n, EpochOff.virtBids);
  epBuf.writeBigUInt64LE(3_000_000n, EpochOff.totalBids);
  epBuf.writeBigUInt64LE(12345n, EpochOff.endSlot);

  assert.equal(accountKind(epBuf), "epochState");
  const ep = parseEpochState(epBuf);
  assert.equal(ep.settled, false);
  assert.equal(ep.totalBids, 3_000_000n);
  assert.equal(ep.endSlot, 12345n);

  const bidBuf = Buffer.alloc(BIDDER_SIZE);
  bidBuf.writeUInt32LE(MAGIC.BID, BidOff.magic);
  cfgKey.toBuffer().copy(bidBuf, BidOff.cfg);
  epKey.toBuffer().copy(bidBuf, BidOff.epochAcc);
  bidder.toBuffer().copy(bidBuf, BidOff.bidder);
  bidBuf.writeBigUInt64LE(4n, BidOff.epochId);
  bidBuf.writeBigUInt64LE(777n, BidOff.amount);

  assert.equal(accountKind(bidBuf), "bidReceipt");
  const bid = parseBidReceipt(bidBuf);
  assert.equal(bid.bidder.equals(bidder), true);
  assert.equal(bid.amount, 777n);
});

test("createMarket, adapterInit, and rewardInit reject silent invalid configurations", () => {
  const baseMkt = {
    dex: pk(), market: pk(), mint: pk(), oracleAuth: pk(),
    creator: pk(), creatorToken: pk(), feeVault: pk(),
    params: {
      initPrice: 100_000_000n, exitWindow: 10n, maxStaleness: 500n, warmupSlots: 0n,
      imBps: 1000n, mmBps: 600n, liqFeeBps: 50n, tradeFeeBps: 2n,
      maxMoveBps: 100n, maxInsDrawBps: 2500n, maxOi: 1_000_000n,
    },
  };
  assert.throws(() => createMarket(LEAN_MAINNET.percolator, { ...baseMkt, params: { ...baseMkt.params, rewardBps: 100n } }), /non-zero rewardRecipient/);
  assert.throws(() => createMarket(LEAN_MAINNET.percolator, { ...baseMkt, params: { ...baseMkt.params, rewardBps: 100n, rewardRecipient: PublicKey.default } }), /non-zero rewardRecipient/);
  assert.throws(() => createMarket(LEAN_MAINNET.percolator, { ...baseMkt, params: { ...baseMkt.params, rewardBps: -1n } }), RangeError);
  assert.throws(() => createMarket(LEAN_MAINNET.percolator, { ...baseMkt, params: { ...baseMkt.params, rewardBps: 10_001n } }), RangeError);

  assert.throws(() => adapterInit(LEAN_MAINNET.oracleAdapter, {
    cfg: pk(), admin: pk(), percolator: LEAN_MAINNET.percolator, market: pk(), feed: pk(),
    feedType: 1, maxFeedAge: 60n, maxConfBps: 100n, fundingBpsPerStep: 0n,
    feedId: Buffer.alloc(32, 1), quoteFeedId: Buffer.alloc(32, 2),
  }), /requires quoteFeed/);

  const qv = pk(), esc = pk(), sink = pk();
  const rwBase = {
    cfg: pk(), mktAdmin: pk(), percolator: LEAN_MAINNET.percolator, dex: pk(), market: pk(),
    quoteMint: pk(), quoteVault: qv, targetMint: pk(), targetEscrow: esc,
    burnMode: 1 as const, epochSlots: 32n, minBatchQuote: 1n, reserveRateE6: 1_000n,
  };
  assert.throws(() => rewardInit(LEAN_MAINNET.rewardModule, { ...rwBase, burnSink: qv }), /distinct from targetEscrow and quoteVault/);
  assert.throws(() => rewardInit(LEAN_MAINNET.rewardModule, { ...rwBase, targetEscrow: qv, burnSink: sink }), /quoteVault and targetEscrow must be distinct/);
  const okInit = rewardInit(LEAN_MAINNET.rewardModule, { ...rwBase, burnSink: sink });
  assert.equal(okInit.keys[7].isWritable, false);
  assert.equal(okInit.keys[10].isWritable, false);
  assert.equal(okInit.keys[12].isWritable, false);
});

test("withLegRefresh chunks >100 accounts, skips RPC on mode=0 Liquidate, and supports solvent victim otherLegs", async () => {
  const perc = LEAN_MAINNET.percolator;
  const dex = pk(), mint = pk(), vault = pk(), mkt1 = pk(), mkt2 = pk(), victim = pk();
  const batches: number[] = [];
  const victimBuf = mockPortfolioBuf(dex, pk(), [{ market: mkt1, side: SIDE.LONG }, { market: mkt2, side: SIDE.SHORT }]);
  const map = new Map<string, { owner: PublicKey; data: Buffer }>([[victim.toBase58(), { owner: perc, data: victimBuf }]]);
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      batches.push(keys.length);
      return keys.map((k) => map.get(k.toBase58()) ?? null);
    },
  } as unknown as Connection;

  // Mode=0 Liquidate makes 0 RPC calls by default
  const liq = liquidate(perc, { dex, mint, vault }, { market: mkt1, portfolio: victim, liquidatorToken: pk() });
  const rSkip = await withLegRefresh(conn, [liq], { percolator: perc });
  assert.equal(rSkip.added, 0);
  assert.deepEqual(batches, []);

  // Opt-in solvent victim refreshes ONLY victim's non-target open leg (mkt2)
  const rOther = await withLegRefresh(conn, [liq], { percolator: perc, liquidationVictim: "otherLegs" });
  assert.equal(rOther.added, 1);
  assert.equal(rOther.instructions[0].keys[1].pubkey.equals(mkt2), true);
  assert.equal(rOther.instructions[0].keys[2].pubkey.equals(victim), true);
  assert.deepEqual(batches, [1]);

  // >100 candidate keys are chunked into <=100 per RPC call
  batches.length = 0;
  const manyWithdraws = Array.from({ length: 40 }, () =>
    withdrawCollateral(perc, { dex, mint, vault }, { portfolio: pk(), owner: pk(), destToken: pk(), amount: 1n }),
  );
  await withLegRefresh(conn, manyWithdraws, { percolator: perc });
  assert.equal(batches.length, 2);
  assert.equal(batches.every((n) => n <= 100), true);
});

test("withLegRefresh marks settledMarket seen after Liquidate for multi-market and takeover bundles", async () => {
  const perc = LEAN_MAINNET.percolator;
  const dex = pk(), mint = pk(), vault = pk(), m1 = pk(), m2 = pk();
  const victim = pk(), victim2 = pk(), liqPfl = pk(), liqOwner = pk(), liqTok = pk();

  const victimBuf = mockPortfolioBuf(dex, pk(), [{ market: m1, side: SIDE.LONG }, { market: m2, side: SIDE.SHORT }]);
  const liqBuf = mockPortfolioBuf(dex, liqOwner, [{ market: m1, side: SIDE.LONG }, { market: m2, side: SIDE.SHORT }]);
  const map = new Map<string, { owner: PublicKey; data: Buffer }>([
    [victim.toBase58(), { owner: perc, data: victimBuf }],
    [liqPfl.toBase58(), { owner: perc, data: liqBuf }],
  ]);
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => map.get(k.toBase58()) ?? null),
  } as unknown as Connection;

  // (a) Multi-market liquidation on same victim with otherLegs: must NOT emit post-close RefreshLeg(m1, victim)
  const liqM1 = liquidate(perc, { dex, mint, vault }, { market: m1, portfolio: victim, liquidatorToken: liqTok });
  const liqM2 = liquidate(perc, { dex, mint, vault }, { market: m2, portfolio: victim, liquidatorToken: liqTok });
  const rMulti = await withLegRefresh(conn, [liqM1, liqM2], { percolator: perc, liquidationVictim: "otherLegs" });
  assert.equal(rMulti.added, 1);
  assert.equal(rMulti.instructions.length, 3);
  assert.equal(rMulti.instructions[0].data[0], IX.RefreshLeg);
  assert.equal(rMulti.instructions[0].keys[1].pubkey.equals(m2), true);
  assert.equal(rMulti.instructions[0].keys[2].pubkey.equals(victim), true);
  assert.equal(rMulti.instructions[1].data[0], IX.Liquidate);
  assert.equal(rMulti.instructions[2].data[0], IX.Liquidate);

  // (b) Two mode=1 takeover liquidations sharing liqPortfolio across m1/m2: must NOT emit post-takeover RefreshLeg(m1, liqPfl)
  const takeM1 = liquidate(perc, { dex, mint, vault }, {
    market: m1, portfolio: victim, liquidatorToken: liqTok, mode: 1, reqQty: 0n, liqPortfolio: liqPfl, liqOwner,
  });
  const takeM2 = liquidate(perc, { dex, mint, vault }, {
    market: m2, portfolio: victim2, liquidatorToken: liqTok, mode: 1, reqQty: 0n, liqPortfolio: liqPfl, liqOwner,
  });
  const rTake = await withLegRefresh(conn, [takeM1, takeM2], { percolator: perc });
  assert.equal(rTake.added, 1);
  assert.equal(rTake.instructions.length, 3);
  assert.equal(rTake.instructions[0].data[0], IX.RefreshLeg);
  assert.equal(rTake.instructions[0].keys[1].pubkey.equals(m2), true);
  assert.equal(rTake.instructions[0].keys[2].pubkey.equals(liqPfl), true);
  assert.equal(rTake.instructions[1].data[0], IX.Liquidate);
  assert.equal(rTake.instructions[2].data[0], IX.Liquidate);

  // (c) Even when liquidationVictim === "skip", Liquidate(m1, victim) still marks m1:victim seen for subsequent ixs
  const wd = withdrawCollateral(perc, { dex, mint, vault }, { portfolio: victim, owner: pk(), destToken: pk(), amount: 1n });
  const rSkipThenWd = await withLegRefresh(conn, [liqM1, wd], { percolator: perc });
  assert.equal(rSkipThenWd.added, 1);
  assert.equal(rSkipThenWd.instructions.length, 3);
  assert.equal(rSkipThenWd.instructions[0].data[0], IX.Liquidate);
  assert.equal(rSkipThenWd.instructions[1].data[0], IX.RefreshLeg);
  assert.equal(rSkipThenWd.instructions[1].keys[1].pubkey.equals(m2), true);
  assert.equal(rSkipThenWd.instructions[1].keys[2].pubkey.equals(victim), true);
  assert.equal(rSkipThenWd.instructions[2].data[0], IX.WithdrawCollateral);
});

test("realizeFlatLegs validates program owner, rejects spoofed default owner, and skips closed/foreign-DEX markets", async () => {
  const perc = LEAN_MAINNET.percolator;
  const wrongProg = pk();
  const dex = pk(), otherDex = pk();
  const mktGood = pk(), mktWrongOwner = pk(), mktClosed = pk(), mktForeignDex = pk(), pfl = pk();
  const pflBuf = mockPortfolioBuf(dex, pk(), [
    { market: mktGood, side: SIDE.FLAT, posPnl: 10n },
    { market: mktWrongOwner, side: SIDE.FLAT, posPnl: 10n },
    { market: mktClosed, side: SIDE.FLAT, posPnl: 10n },
    { market: mktForeignDex, side: SIDE.FLAT, posPnl: 10n },
  ]);
  const mktGoodBuf = mockMarketBuf(STATUS.ACTIVE, dex);
  const mktForeignDexBuf = mockMarketBuf(STATUS.ACTIVE, otherDex);
  const mktClosedBuf = Buffer.alloc(MARKET_SIZE);
  mktClosedBuf.writeUInt32LE(MAGIC.CLOSED, 0);

  const conn = {
    getAccountInfo: async () => ({ owner: perc, data: pflBuf }),
    getMultipleAccountsInfo: async () => [
      { owner: perc, data: mktGoodBuf },
      { owner: wrongProg, data: mktGoodBuf },
      { owner: perc, data: mktClosedBuf },
      { owner: perc, data: mktForeignDexBuf },
    ],
  } as unknown as Connection;

  await assert.rejects(() => realizeFlatLegs(conn, pfl, { percolator: wrongProg }), /owned by/);
  const ixs = await realizeFlatLegs(conn, pfl, { percolator: perc });
  assert.equal(ixs.length, 1);
  assert.equal(ixs[0].keys[1].pubkey.equals(mktGood), true);

  // When opts.percolator is omitted, spoofed unknown-program "PFLO" portfolio must be rejected
  const spoofConn = {
    getAccountInfo: async () => ({ owner: wrongProg, data: pflBuf }),
    getMultipleAccountsInfo: async () => { throw new Error("must reject before fetching markets"); },
  } as unknown as Connection;
  await assert.rejects(() => realizeFlatLegs(spoofConn, pfl), /unrecognized program.*opts\.percolator/);
});

test("constants and parseMarket align with percolator-lean a31a1f8 (lastRampSlot + RAMP_FRONT_COOLDOWN + zero warmupSlots)", () => {
  assert.equal(LEAN_SOURCE_COMMIT, "a31a1f8");
  assert.equal(RAMP_FRONT_COOLDOWN, 2n);
  assert.equal(MktOff.lastRampSlot, 152);
  assert.equal(MktOff.warmupSlots, 152);
  const mktBuf = mockMarketBuf(STATUS.ACTIVE, pk(), 987_654n);
  mktBuf.writeBigUInt64LE(100_000_000n, MktOff.markPrice);
  mktBuf.writeBigUInt64LE(10n, MktOff.exitWindow);
  mktBuf.writeBigUInt64LE(500n, MktOff.maxStaleness);
  mktBuf.writeBigUInt64LE(1000n, MktOff.imBps);
  mktBuf.writeBigUInt64LE(600n, MktOff.mmBps);
  mktBuf.writeBigUInt64LE(50n, MktOff.liqFeeBps);
  mktBuf.writeBigUInt64LE(2n, MktOff.tradeFeeBps);
  mktBuf.writeBigUInt64LE(100n, MktOff.maxMoveBps);
  mktBuf.writeBigUInt64LE(2500n, MktOff.maxInsDrawBps);
  mktBuf.writeBigUInt64LE(1_000_000n, MktOff.maxOi);

  const mkt = parseMarket(mktBuf);
  assert.equal(mkt.lastRampSlot, 987_654n);
  // Retired legacy field stays 0n so cloning a parsed Market into CreateMarket satisfies `reservedPad == 0`
  assert.equal(mkt.warmupSlots, 0n);

  const clonedIx = createMarket(LEAN_MAINNET.percolator, {
    dex: pk(), market: pk(), mint: pk(), oracleAuth: pk(), creator: pk(), creatorToken: pk(), feeVault: pk(),
    params: { ...mkt, initPrice: mkt.markPrice },
  });
  assert.equal(clonedIx.data.readBigUInt64LE(4 + 3 * 8), 0n);
});

test("symlink-safe ESM entrypoint guard matches symlinked script invocations and skips module imports", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "perc-sym-"));
  const repoLink = path.join(tmpDir, "repo-link");
  const emptyHome = path.join(tmpDir, "empty-home");
  fs.mkdirSync(emptyHome, { recursive: true });
  fs.symlinkSync(process.cwd(), repoLink);

  const realBid = path.join(process.cwd(), "scripts", "_lean-r3-reward-bid.ts");
  const symDirBid = path.join(repoLink, "scripts", "_lean-r3-reward-bid.ts");
  const directFileLink = path.join(tmpDir, "bid-link.ts");
  fs.symlinkSync(realBid, directFileLink);

  const bidUrl = pathToFileURL(realBid).href;
  assert.equal(isDirectEntrypoint(bidUrl, realBid), true);
  assert.equal(isDirectEntrypoint(bidUrl, symDirBid), true);
  assert.equal(isDirectEntrypoint(bidUrl, directFileLink), true);
  assert.equal(isDirectEntrypoint(bidUrl, path.join(process.cwd(), "scripts", "_lean-r3-crank.ts")), false);
  assert.equal(isDirectEntrypoint(bidUrl, undefined), false);

  const runNode = (args: string[], envOverrides: Record<string, string>) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        env: { ...process.env, ...envOverrides },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      child.once("close", (code) => resolve({ code, stderr }));
    });

  // Direct execution through a symlinked repo path MUST enter main() (matching each script's main() error, NOT silent exit 0)
  const expected: Array<[string, RegExp]> = [
    ["_lean-r3-reward-bid.ts", /\[reward-bid\] ERR/],
    ["_lean-r3-crank.ts", /lean-mainnet-r3\.json/],
    ["_lean-oi-monitor.ts", /\.helius/],
  ];
  for (const [script, pattern] of expected) {
    const res = await runNode(
      ["--import", "tsx", path.join(repoLink, "scripts", script)],
      { HOME: emptyHome, SOLANA_RPC_URL: "" },
    );
    assert.equal(res.code, 1, `${script} invoked via symlink must enter main() and exit 1 (stderr: ${res.stderr})`);
    assert.match(res.stderr, pattern, `${script} invoked via symlink must reach main() body`);
  }

  // Importing all 3 scripts as modules must NOT execute main()
  const modRes = await runNode(
    [
      "--import", "tsx", "--input-type=module", "-e",
      `await import(${JSON.stringify(pathToFileURL(path.join(repoLink, "scripts", "_lean-r3-reward-bid.ts")).href)});
       await import(${JSON.stringify(pathToFileURL(path.join(repoLink, "scripts", "_lean-r3-crank.ts")).href)});
       await import(${JSON.stringify(pathToFileURL(path.join(repoLink, "scripts", "_lean-oi-monitor.ts")).href)});`,
    ],
    { HOME: emptyHome, SOLANA_RPC_URL: "" },
  );
  assert.equal(modRes.code, 0, `module imports must not run main(): ${modRes.stderr}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("leanErrorName resolves e189ef2 core, matcher, adapter, and reward error codes", () => {
  assert.equal(leanErrorName(131), "invalidMatcher");
  assert.equal(leanErrorName(201), "matcher.marketNotAllowed");
  assert.equal(leanErrorName(304), "adapter.badFeedFormat");
  assert.equal(leanErrorName(308), "adapter.ewmaSameSlot");
  assert.equal(leanErrorName(400), "reward.progMismatch");
  assert.equal(leanErrorName(408), "reward.belowMinBatch");
  assert.equal(leanErrorName(413), "reward.vaultMismatch");
});
