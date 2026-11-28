/**
 * Pure tests (no network) for the PropAMM / core-op-20..23 builders and parsers.
 *
 * Every layout below was derived clean-room from percolator-lean @ 887ba02 and is cross-checked against the
 * COMMITTED source (`git show 887ba02:Percolator/<file>` — line numbers refer to those files, which is what is
 * deployed) and proven with real transactions by scripts/_lean-propamm-devnet.ts.
 *
 *   npx -y tsx --test tests/lean/propamm-builders.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  sweepSurplus, claimReward, setPortfolioMatcher, tradeWithMatcher, propAmmInit, propAmmUpdate, propAmmQuoteIx,
  matcherLegIsBuy, type VaultAccounts,
} from "../../src/lean/instructions.js";
import {
  parsePropAmmCtx, propAmmQuote, PropAmmQuoteError, parseRewardCfg, parseEpochState, parseBidReceipt, accountKind,
} from "../../src/lean/parsers.js";
import {
  IX, PROP_AMM_IX, PROP_CTX_SIZE, PropOff, MAGIC, TRADE_MODE, TOKEN_PROGRAM_ID, POS_SCALE, LEAN_ERRORS, leanErrorName,
  RewOff, EpochOff, BidOff, REWARD_CFG_SIZE, EPOCH_SIZE, BIDDER_SIZE, MAGIC_REWARD, MAGIC_EPOCH, MAGIC_BID, MAGIC_CLOSED,
} from "../../src/lean/constants.js";

const pk = () => Keypair.generate().publicKey;
const P = pk(), M = pk();
const U64_MAX = (1n << 64n) - 1n;
/** [pubkey, isSigner, isWritable] triples of an instruction, for exact account-meta assertions. */
const metas = (ix: TransactionInstruction) => ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
const m = (k: PublicKey, s: boolean, w: boolean) => [k.toBase58(), s, w];
const hex = (b: Buffer) => b.toString("hex");
const u64le = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return hex(b); };

// ============================================================ opcodes / error table
test("opcodes and error names match Layout.lean / Matcher.lean", () => {
  // Layout.lean IxOp: sweepSurplus 20, claimReward 21, setPortfolioMatcher 22, tradeWithMatcher 23
  assert.deepEqual([IX.SweepSurplus, IX.ClaimReward, IX.SetPortfolioMatcher, IX.TradeWithMatcher], [20, 21, 22, 23]);
  // Matcher.lean:339-346 dispatch: 0 Init, 1 Update, 2 Quote
  assert.deepEqual(PROP_AMM_IX, { Init: 0, Update: 1, Quote: 2 });
  // Matcher.lean:26-29 MErr; Layout.lean PErr.execPriceClamp 130 / invalidMatcher 131
  assert.equal(leanErrorName(200), "matcher.paused");
  assert.equal(leanErrorName(201), "matcher.marketNotAllowed");
  assert.equal(leanErrorName(130), "execPriceClamp");
  assert.equal(leanErrorName(131), "invalidMatcher");
  assert.equal(LEAN_ERRORS[202], undefined); // legacy matcher.slippage no longer exists
  // Layout.lean:50 MAGIC_MRET = 0x5445524D = "MRET"; Matcher.lean:38 PropOff.size = 272
  assert.equal(MAGIC.MRET, 0x5445524d);
  assert.equal(Buffer.from([0x4d, 0x52, 0x45, 0x54]).readUInt32LE(0), MAGIC.MRET);
  assert.equal(PROP_CTX_SIZE, 272);
  // Matcher.lean:39-49
  assert.deepEqual(PropOff, { magic: 0, status: 4, seq: 8, quotesBase: 16, quoteStride: 16, owner: 144, halfSpreadBps: 176,
    impactBps: 184, maxFillQty: 192, paused: 200, allowedCount: 201, allowedMarkets: 208 });
});

// ============================================================ op 20 SweepSurplus
test("sweepSurplus: [20, amount:u64], accounts dex(W) admin(S) mint vault(W) feeVault(W) tokenProgram", () => {
  // Program.lean:2065-2067 parseStrict6 (dex, admin, mint, vaultPda, feeVaultTok, tokProg), ix.len >= 9
  // Program.lean:2068 requireSigner admin; requireWritable dex/vaultPda/feeVaultTok; 2076-2078 reqAmt = u64 @1 (0 = all)
  const v: VaultAccounts = { dex: pk(), mint: pk(), vault: pk() };
  const admin = pk(), feeVault = pk();
  const ix = sweepSurplus(P, v, { admin, feeVault, amount: 0x0102030405060708n });
  assert.ok(ix.programId.equals(P));
  assert.equal(hex(ix.data), "14" + "0807060504030201");
  assert.deepEqual(metas(ix), [m(v.dex, false, true), m(admin, true, false), m(v.mint, false, false), m(v.vault, false, true), m(feeVault, false, true), m(TOKEN_PROGRAM_ID, false, false)]);
  assert.equal(hex(sweepSurplus(P, v, { admin, feeVault }).data), "14" + "00".repeat(8)); // default = sweep all
  const tokenProgram = pk();
  assert.ok(sweepSurplus(P, { ...v, tokenProgram }, { admin, feeVault }).keys[5].pubkey.equals(tokenProgram));
  assert.throws(() => sweepSurplus(P, v, { admin, feeVault, amount: -1n }), /amount must be a u64/);
  assert.throws(() => sweepSurplus(P, v, { admin, feeVault, amount: U64_MAX + 1n }), /amount must be a u64/);
  assert.throws(() => sweepSurplus(P, v, { admin, feeVault, amount: 5 as unknown as bigint }), /amount must be a u64/);
  assert.throws(() => sweepSurplus(P, v, { admin, feeVault: v.vault }), /feeVault must be distinct from vault/); // Program.lean:2074
});

// ============================================================ op 21 ClaimReward
test("claimReward: [21, amount:u64], accounts dex(W) market(W) rewardAuth(S) mint vault(W) destToken(W) tokenProgram", () => {
  // Program.lean:2093-2095 parseStrict7 (dex, mkt, rewAuth, mint, vaultPda, destTok, tokProg), ix.len >= 9,
  // 2096-2097 requireSigner rewAuth; requireWritable dex/mkt/vaultPda/destTok; 2108-2110 reqAmt = u64 @1 (0 = all)
  const v: VaultAccounts = { dex: pk(), mint: pk(), vault: pk() };
  const market = pk(), rewardAuth = pk(), destToken = pk();
  const ix = claimReward(P, v, { market, rewardAuth, destToken, amount: 1_000_000n });
  assert.equal(hex(ix.data), "15" + u64le(1_000_000n));
  assert.deepEqual(metas(ix), [m(v.dex, false, true), m(market, false, true), m(rewardAuth, true, false), m(v.mint, false, false), m(v.vault, false, true), m(destToken, false, true), m(TOKEN_PROGRAM_ID, false, false)]);
  assert.equal(hex(claimReward(P, v, { market, rewardAuth, destToken }).data), "15" + "00".repeat(8));
  assert.throws(() => claimReward(P, v, { market, rewardAuth, destToken, amount: U64_MAX + 1n }), /amount must be a u64/);
  assert.throws(() => claimReward(P, v, { market, rewardAuth, destToken: v.vault }), /destToken must be distinct from vault/); // Program.lean:2104
  assert.throws(() => claimReward(P, v, { market: v.dex, rewardAuth, destToken }), /market must be distinct from dex/);
});

// ============================================================ op 22 SetPortfolioMatcher
test("setPortfolioMatcher: [22], accounts portfolio(W) owner(S) [matcherCtx]; null unbinds", () => {
  // Program.lean:2126-2143: n >= 2; pfl writable, owner signer; n >= 3 -> copy key of account 2, else zero matcherCtx
  const portfolio = pk(), owner = pk(), ctx = pk();
  const bind = setPortfolioMatcher(P, { portfolio, owner, matcherCtx: ctx });
  assert.equal(hex(bind.data), "16");
  assert.deepEqual(metas(bind), [m(portfolio, false, true), m(owner, true, false), m(ctx, false, false)]);
  const unbind = setPortfolioMatcher(P, { portfolio, owner, matcherCtx: null });
  assert.equal(hex(unbind.data), "16");
  assert.deepEqual(metas(unbind), [m(portfolio, false, true), m(owner, true, false)]);
  // an accidentally-missing ctx must not silently UNBIND
  assert.throws(() => setPortfolioMatcher(P, { portfolio, owner } as any), /pass null explicitly to unbind/);
  assert.throws(() => setPortfolioMatcher(P, { portfolio, owner, matcherCtx: PublicKey.default }), /zero key/);
  assert.throws(() => setPortfolioMatcher(P, { portfolio, owner, matcherCtx: portfolio }), /matcherCtx must be distinct from portfolio/);
  assert.throws(() => setPortfolioMatcher(P, { portfolio, owner, matcherCtx: owner }), /matcherCtx must be distinct from owner/);
  assert.throws(() => setPortfolioMatcher(P, { portfolio, owner: portfolio, matcherCtx: null }), /owner must be distinct from portfolio/);
});

// ============================================================ op 23 TradeWithMatcher
const twmBase = () => ({ dex: pk(), takerPortfolio: pk(), taker: pk(), lpPortfolio: pk(), matcherProgram: M, matcherCtx: pk() });

test("tradeWithMatcher k=1: [23, 1, mode, takerIsLong, maxQty:u64, limitPrice:u64] (20 B), single signer = taker", () => {
  // Program.lean:2310-2321 doc + 2324 (n >= 7, ix.len >= 20), 2231-2235 per-leg offsets 2 + 18 i,
  // 2340-2342 requireSigner takerOwner; writable dex/takerPfl/lpPfl/matcherCtx; 2223 markets writable
  const a = twmBase(), market = pk();
  const ix = tradeWithMatcher(P, { ...a, legs: [{ market, mode: TRADE_MODE.OPEN, takerIsLong: true, maxQty: 1_500_000n, limitPrice: 101_000_000n }] });
  assert.ok(ix.programId.equals(P));
  assert.equal(ix.data.length, 20);
  assert.equal(hex(ix.data), "17" + "01" + "00" + "01" + u64le(1_500_000n) + u64le(101_000_000n));
  assert.deepEqual(metas(ix), [
    m(a.dex, false, true), m(a.takerPortfolio, false, true), m(a.taker, true, false), m(a.lpPortfolio, false, true),
    m(M, false, false), m(a.matcherCtx, false, true), m(market, false, true),
  ]);
  assert.equal(ix.keys.filter((k) => k.isSigner).length, 1, "the LP never signs");
  // limitPrice omitted = 0 = no limit (Program.lean:2166 `if limitPrice != 0`)
  const noLim = tradeWithMatcher(P, { ...a, legs: [{ market, mode: TRADE_MODE.CLOSE, takerIsLong: false, maxQty: 1n }] });
  assert.equal(hex(noLim.data), "17" + "01" + "01" + "00" + u64le(1n) + u64le(0n));
});

test("tradeWithMatcher basket: 2 + 18k bytes, markets at 6..6+k-1 (W), extra accounts trailing read-only", () => {
  const a = twmBase();
  for (const k of [2, 8]) {
    const legs = Array.from({ length: k }, (_, i) => ({ market: pk(), mode: i % 2 ? TRADE_MODE.NETTED : TRADE_MODE.OPEN, takerIsLong: i % 3 === 0, maxQty: BigInt(i + 1) * POS_SCALE, limitPrice: BigInt(i) * 7n }));
    const extra = [pk(), pk()];
    const ix = tradeWithMatcher(P, { ...a, legs, extraAccounts: extra });
    assert.equal(ix.data.length, 2 + 18 * k);
    assert.equal(ix.data[0], 23);
    assert.equal(ix.data[1], k);
    legs.forEach((l, i) => {
      const o = 2 + 18 * i;
      assert.equal(ix.data[o], l.mode);
      assert.equal(ix.data[o + 1], l.takerIsLong ? 1 : 0);
      assert.equal(ix.data.readBigUInt64LE(o + 2), l.maxQty);
      assert.equal(ix.data.readBigUInt64LE(o + 10), l.limitPrice);
      assert.deepEqual(metas(ix)[6 + i], m(l.market, false, true));
    });
    assert.equal(ix.keys.length, 6 + k + 2);
    // Program.lean:2386-2389: account 6+k is forwarded to the matcher as read-only extraAcc
    assert.deepEqual(metas(ix).slice(6 + k), extra.map((e) => m(e, false, false)));
  }
});

test("tradeWithMatcher rejects bad input before encoding", () => {
  const a = twmBase(), market = pk();
  const leg = (o: object = {}) => ({ market, mode: TRADE_MODE.NETTED, takerIsLong: true, maxQty: 1n, ...o });
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: [] }), /needs 1\.\.8 legs, got 0/); // Program.lean:2327 k in 1..8
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: Array.from({ length: 9 }, () => leg({ market: pk() })) }), /needs 1\.\.8 legs, got 9/);
  for (const mode of [2, 3, 5, -1, 256]) // Program.lean:2236 only modes 0 / 1 / 4
    assert.throws(() => tradeWithMatcher(P, { ...a, legs: [leg({ mode })] }), /mode must be 0 \(open\), 1 \(close\) or 4 \(netted\)/);
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: [leg({ maxQty: 0n })] }), /maxQty must be > 0/); // Program.lean:2236
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: [leg({ maxQty: U64_MAX + 1n })] }), /maxQty must be a u64/);
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: [leg({ maxQty: 1 })] }), /maxQty must be a u64/);
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: [leg({ limitPrice: -5n })] }), /limitPrice must be a u64/);
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: [leg({ takerIsLong: 1 })] }), /takerIsLong must be a boolean/);
  // Program.lean:2222-2228 distinct markets; 2338-2343 no aliasing among the fixed accounts
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: [leg(), leg()] }), /legs\[1\]\.market must be distinct from legs\[0\]\.market/);
  assert.throws(() => tradeWithMatcher(P, { ...a, lpPortfolio: a.takerPortfolio, legs: [leg()] }), /lpPortfolio must be distinct from takerPortfolio/);
  assert.throws(() => tradeWithMatcher(P, { ...a, matcherCtx: a.lpPortfolio, legs: [leg()] }), /matcherCtx must be distinct from lpPortfolio/);
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: [leg({ market: a.dex })] }), /legs\[0\]\.market must be distinct from dex/);
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: [leg()], extraAccounts: [a.taker] }), /extraAccounts\[0\] must be distinct from taker/); // Program.lean:2387-2388
  assert.throws(() => tradeWithMatcher(P, { ...a, legs: [leg()], extraAccounts: [market] }), /extraAccounts\[0\] must be distinct from legs\[0\]\.market/);
  assert.throws(() => tradeWithMatcher(P, { ...a, matcherProgram: P, legs: [leg()] }), /must not be the percolator program/); // Program.lean:2359
});

test("matcherLegIsBuy mirrors the program's economic direction (Program.lean:2282-2283, Matcher.lean:290)", () => {
  assert.equal(matcherLegIsBuy({ mode: TRADE_MODE.OPEN, takerIsLong: true }), true);    // open long = buy
  assert.equal(matcherLegIsBuy({ mode: TRADE_MODE.OPEN, takerIsLong: false }), false);  // open short = sell
  assert.equal(matcherLegIsBuy({ mode: TRADE_MODE.CLOSE, takerIsLong: true }), false);  // reduce long = sell
  assert.equal(matcherLegIsBuy({ mode: TRADE_MODE.CLOSE, takerIsLong: false }), true);  // reduce short = buy
  assert.equal(matcherLegIsBuy({ mode: TRADE_MODE.NETTED, takerIsLong: true }), true);
  assert.equal(matcherLegIsBuy({ mode: TRADE_MODE.NETTED, takerIsLong: false }), false);
});

// ============================================================ PropAMM op 0 / 1 / 2
const params = { halfSpreadBps: 25n, impactBps: 3n, maxFillQty: 5_000_000n };

test("propAmmInit: [0, paused, n, pad, half:u64@4, impact:u64@12, maxFill:u64@20, ids:u64@28..] accounts ctx(W) owner(S)", () => {
  // Matcher.lean:190-194 doc, 195-196 parseStrict2 (ctx, owner), 197 ix.len >= 36, 198-199 owner signer / ctx writable,
  // 203-208 paused@1 nAllowed@2 half@4 impact@12 maxFill@20, 209 n in 1..8 && len >= 28 + 8n, 221 ids from @28
  const ctx = pk(), owner = pk();
  const ix = propAmmInit(M, { ctx, owner, ...params, allowedMarketIds: [1n, 7n, 0x1122334455667788n] });
  assert.ok(ix.programId.equals(M));
  assert.equal(ix.data.length, 28 + 8 * 3);
  assert.equal(hex(ix.data), "00" + "00" + "03" + "00" + u64le(25n) + u64le(3n) + u64le(5_000_000n) + u64le(1n) + u64le(7n) + "8877665544332211");
  assert.deepEqual(metas(ix), [m(ctx, false, true), m(owner, true, false)]);
  const one = propAmmInit(M, { ctx, owner, ...params, paused: true, allowedMarketIds: [9n] });
  assert.equal(one.data.length, 36); // the minimum the program accepts (Matcher.lean:197)
  assert.equal(one.data[1], 1);
  assert.equal(one.data[2], 1);
  assert.equal(propAmmInit(M, { ctx, owner, ...params, allowedMarketIds: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n] }).data.length, 92);
});

test("propAmmInit / propAmmUpdate reject bad input before encoding", () => {
  const ctx = pk(), owner = pk();
  const init = (o: object) => propAmmInit(M, { ctx, owner, ...params, allowedMarketIds: [1n], ...o } as any);
  assert.throws(() => init({ allowedMarketIds: [] }), /needs 1\.\.8 market ids, got 0/);                         // Matcher.lean:209
  assert.throws(() => init({ allowedMarketIds: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n] }), /needs 1\.\.8 market ids, got 9/);
  assert.throws(() => init({ allowedMarketIds: [0n] }), /must be > 0/);                                          // Matcher.lean:161 mid > 0
  assert.throws(() => init({ allowedMarketIds: [3n, 3n] }), /duplicate market id 3/);
  assert.throws(() => init({ allowedMarketIds: [U64_MAX + 1n] }), /must be a u64/);
  assert.throws(() => init({ allowedMarketIds: [1] }), /must be a u64/);
  assert.throws(() => init({ ctx: owner }), /owner must be distinct from ctx/);
  for (const f of [init, (o: object) => propAmmUpdate(M, { ctx, owner, ...params, ...o } as any)]) {
    assert.throws(() => f({ halfSpreadBps: 10_001n }), /halfSpreadBps must be <= 10000/);                         // Matcher.lean:210 / 240
    assert.throws(() => f({ maxFillQty: 0n }), /maxFillQty must be > 0/);                                         // Matcher.lean:210 / 240
    assert.throws(() => f({ impactBps: -1n }), /impactBps must be a u64/);
    assert.throws(() => f({ maxFillQty: U64_MAX + 1n }), /maxFillQty must be a u64/);
    assert.throws(() => f({ halfSpreadBps: 25 }), /halfSpreadBps must be a u64/);
    assert.throws(() => f({ paused: 1 }), /paused must be a boolean/);
    assert.doesNotThrow(() => f({ halfSpreadBps: 10_000n, impactBps: U64_MAX, maxFillQty: U64_MAX }));
  }
});

test("propAmmUpdate: [1, paused, pad2, half:u64@4, impact:u64@12, maxFill:u64@20] (28 B) accounts ctx(W) owner(S)", () => {
  // Matcher.lean:223-225 doc, 226-227 parseStrict2 (ctx, owner), 228 ix.len >= 28, 229-230 owner signer / ctx writable,
  // 236-239 paused@1 half@4 impact@12 maxFill@20
  const ctx = pk(), owner = pk();
  const ix = propAmmUpdate(M, { ctx, owner, halfSpreadBps: 40n, impactBps: 10n, maxFillQty: 500_000n, paused: true });
  assert.equal(hex(ix.data), "01" + "01" + "0000" + u64le(40n) + u64le(10n) + u64le(500_000n));
  assert.deepEqual(metas(ix), [m(ctx, false, true), m(owner, true, false)]);
  assert.equal(propAmmUpdate(M, { ctx, owner, ...params }).data[1], 0, "paused defaults to false (unpaused)");
});

test("propAmmQuoteIx: raw 0-signer quote request = what core serializes (32 + 48k B), accounts ctx(W)", () => {
  // Program.lean:2371-2375 header [2, k, lpCapital@8, slot@16, seq@24]; 2238 + 2243-2250 offer @32+48i:
  //   mode@0 takerIsLong@1 isRamping@2 mid@8 maxQty@16 limitPrice@24 markPrice@32 maxMoveBps@40
  // Matcher.lean:313-315 parseIxOnly, n >= 1, ix.len >= 80; 324 k@1; 328 seq@24; 271-278 offer fields
  const ctx = pk();
  const ix = propAmmQuoteIx(M, { ctx, seq: 9n, lpCapital: 11n, slot: 12n, offers: [
    { mode: TRADE_MODE.NETTED, takerIsLong: true, marketId: 2n, maxQty: 3n, limitPrice: 4n, markPrice: 100_000_000n, maxMoveBps: 100n },
    { mode: TRADE_MODE.CLOSE, takerIsLong: false, marketId: 5n, maxQty: 6n, markPrice: 7n, maxMoveBps: 8n, isRamping: true },
  ] });
  assert.equal(ix.data.length, 32 + 96);
  assert.equal(hex(ix.data),
    "02" + "02" + "00".repeat(6) + u64le(11n) + u64le(12n) + u64le(9n)
    + "04" + "01" + "00" + "00".repeat(5) + u64le(2n) + u64le(3n) + u64le(4n) + u64le(100_000_000n) + u64le(100n)
    + "01" + "00" + "01" + "00".repeat(5) + u64le(5n) + u64le(6n) + u64le(0n) + u64le(7n) + u64le(8n));
  assert.deepEqual(metas(ix), [m(ctx, false, true)]);
  assert.equal(ix.keys.filter((k) => k.isSigner).length, 0);
  const o = { mode: 0, takerIsLong: true, marketId: 1n, maxQty: 1n, markPrice: 1n, maxMoveBps: 1n };
  assert.equal(propAmmQuoteIx(M, { ctx, seq: 1n, offers: [o] }).data.length, 80); // Matcher.lean:315 minimum
  assert.throws(() => propAmmQuoteIx(M, { ctx, seq: 1n, offers: [] }), /needs 1\.\.8 offers/);
  assert.throws(() => propAmmQuoteIx(M, { ctx, seq: 1n, offers: Array(9).fill(o) }), /needs 1\.\.8 offers/);
  assert.throws(() => propAmmQuoteIx(M, { ctx, seq: 1n, offers: [{ ...o, mode: 2 }] }), /mode must be 0, 1 or 4/);
  assert.throws(() => propAmmQuoteIx(M, { ctx, seq: 1n, offers: [{ ...o, maxQty: 0n }] }), /maxQty must be > 0/);
  assert.throws(() => propAmmQuoteIx(M, { ctx, seq: 1n, offers: [{ ...o, markPrice: 0n }] }), /markPrice must be > 0/);
  assert.throws(() => propAmmQuoteIx(M, { ctx, seq: -1n, offers: [o] }), /seq must be a u64/);
});

// ============================================================ parsePropAmmCtx
/** Build a ctx exactly as handleInitPropAmm (Matcher.lean:211-221) + a quote (Matcher.lean:296-298, 335-337) would leave it. */
function buildCtx(o: { owner: PublicKey; half: bigint; impact: bigint; maxFill: bigint; paused: number; ids: bigint[]; seq?: bigint; quotes?: [bigint, bigint][] }): Buffer {
  const b = Buffer.alloc(272);
  b.writeUInt32LE(0x5445524d, 0);          // magic "MRET" @0
  b.writeUInt32LE(0, 4);                   // status @4
  b.writeBigUInt64LE(o.seq ?? 0n, 8);      // seq @8
  (o.quotes ?? []).forEach(([px, q], i) => { b.writeBigUInt64LE(px, 16 + 16 * i); b.writeBigUInt64LE(q, 24 + 16 * i); }); // quotes @16
  o.owner.toBuffer().copy(b, 144);         // owner @144
  b.writeBigUInt64LE(o.half, 176); b.writeBigUInt64LE(o.impact, 184); b.writeBigUInt64LE(o.maxFill, 192);
  b.writeUInt8(o.paused, 200); b.writeUInt8(o.ids.length, 201);
  o.ids.forEach((id, i) => b.writeBigUInt64LE(id, 208 + 8 * i)); // allowlist @208
  return b;
}

test("parsePropAmmCtx decodes the 272-byte ctx: MRET header, 8 quote slots, params, allowlist", () => {
  const owner = pk();
  const quotes: [bigint, bigint][] = Array.from({ length: 8 }, (_, i) => [100_000_000n + BigInt(i), BigInt(i + 1) * 1_000n]);
  const b = buildCtx({ owner, half: 20n, impact: 2n, maxFill: 5_000_000n, paused: 1, ids: [1n, 2n, 0xffffffffffffffffn], seq: 42n, quotes });
  const c = parsePropAmmCtx(b);
  assert.equal(c.status, 0);
  assert.equal(c.seq, 42n);
  assert.equal(c.quotes.length, 8);
  c.quotes.forEach((q, i) => assert.deepEqual([q.execPrice, q.fillQty], quotes[i]));
  assert.ok(c.owner.equals(owner));
  assert.deepEqual([c.halfSpreadBps, c.impactBps, c.maxFillQty, c.paused, c.allowedCount], [20n, 2n, 5_000_000n, true, 3]);
  assert.deepEqual(c.allowedMarkets, [1n, 2n, U64_MAX]);
  assert.equal(accountKind(b), "propAmmCtx");
  // the last quote slot ends exactly where owner starts, and the allowlist ends at the account size (Matcher.lean:52-55)
  assert.equal(PropOff.quotesBase + 8 * PropOff.quoteStride, PropOff.owner);
  assert.equal(PropOff.allowedMarkets + 8 * 8, PROP_CTX_SIZE);
  assert.throws(() => parsePropAmmCtx(b.subarray(0, 271)), /bad size/);
  assert.throws(() => parsePropAmmCtx(Buffer.alloc(272)), /bad magic/);          // uninitialized ctx
  const legacy = Buffer.alloc(160); legacy.writeUInt32LE(MAGIC.MATCHER, 0);
  assert.throws(() => parsePropAmmCtx(legacy), /bad size/);                       // legacy 160-byte config is not a ctx
  const bad = Buffer.from(b); bad.writeUInt8(9, 201);
  assert.throws(() => parsePropAmmCtx(bad), /bad allowedCount 9/);
});

test("propAmmInit bytes decode back through the program's Init semantics to the same ctx", () => {
  // Apply handleInitPropAmm (Matcher.lean:203-221) to the builder's bytes by hand and parse the result.
  const owner = pk();
  const ix = propAmmInit(M, { ctx: pk(), owner, halfSpreadBps: 33n, impactBps: 4n, maxFillQty: 77n, paused: true, allowedMarketIds: [5n, 6n] });
  const d = ix.data, n = d[2];
  const b = buildCtx({ owner: ix.keys[1].pubkey, half: d.readBigUInt64LE(4), impact: d.readBigUInt64LE(12), maxFill: d.readBigUInt64LE(20), paused: d[1],
    ids: Array.from({ length: n }, (_, i) => d.readBigUInt64LE(28 + 8 * i)) });
  const c = parsePropAmmCtx(b);
  assert.deepEqual([c.halfSpreadBps, c.impactBps, c.maxFillQty, c.paused, c.allowedMarkets], [33n, 4n, 77n, true, [5n, 6n]]);
  assert.ok(c.owner.equals(owner));
});

// ============================================================ propAmmQuote (pure pricing, Matcher.lean:246-335)
test("propAmmQuote: ask >= mark, bid <= mark, half-spread + impact, maxMove clamp, maxFill clamp", () => {
  const ctx = { halfSpreadBps: 20n, impactBps: 2n, maxFillQty: 5n * POS_SCALE, paused: false, allowedMarkets: [1n, 2n] };
  const leg = (o: object = {}) => ({ mode: TRADE_MODE.NETTED, takerIsLong: true, marketId: 1n, maxQty: POS_SCALE, markPrice: 100n * POS_SCALE, maxMoveBps: 100n, ...o });
  // 1.0 unit: effBps = 20 + floor(1e6 * 2 / 1e6) = 22 (Matcher.lean:286-288); delta = 100e6 * 22 / 1e4 = 220000 (289)
  const [buy] = propAmmQuote(ctx, [leg()]);
  assert.deepEqual(buy, { isBuy: true, execPrice: 100_220_000n, fillQty: POS_SCALE, effBps: 22n, hedged: false });
  const [sell] = propAmmQuote(ctx, [leg({ takerIsLong: false })]);
  assert.deepEqual(sell, { isBuy: false, execPrice: 99_780_000n, fillQty: POS_SCALE, effBps: 22n, hedged: false });
  // mode 1: takerIsLong = "holds the long" => SELLS at bid; reducing a short BUYS at ask (Matcher.lean:290)
  assert.equal(propAmmQuote(ctx, [leg({ mode: TRADE_MODE.CLOSE, takerIsLong: true })])[0].execPrice, 99_780_000n);
  assert.equal(propAmmQuote(ctx, [leg({ mode: TRADE_MODE.CLOSE, takerIsLong: false })])[0].execPrice, 100_220_000n);
  // maxFillQty CLAMPS (Matcher.lean:283-284) and impact uses the clamped fill: 20 + floor(5 * 2) = 30 bps
  const [big] = propAmmQuote(ctx, [leg({ maxQty: 9n * POS_SCALE })]);
  assert.deepEqual([big.fillQty, big.effBps, big.execPrice], [5n * POS_SCALE, 30n, 100_300_000n]);
  // impact floors: 0.4 unit * 2 bps = 0.8 -> 0
  assert.equal(propAmmQuote(ctx, [leg({ maxQty: 400_000n })])[0].effBps, 20n);
  // clamp to the market's maxMoveBps (Matcher.lean:288)
  const wide = { ...ctx, halfSpreadBps: 500n };
  assert.deepEqual([propAmmQuote(wide, [leg()])[0].effBps, propAmmQuote(wide, [leg()])[0].execPrice], [100n, 101_000_000n]);
  // bid floor of 1 (Matcher.lean:291-294 `if markP > delta then markP - delta else 1`)
  assert.equal(propAmmQuote({ ...ctx, halfSpreadBps: 10_000n }, [leg({ takerIsLong: false, maxMoveBps: 10_000n })])[0].execPrice, 1n);
  // property: for a grid of inputs the ask is never below mark and the bid never above (Matcher.lean:69-75)
  for (const half of [0n, 1n, 37n, 10_000n]) for (const impact of [0n, 5n, 1_000_000n]) for (const mark of [1n, 999n, 100n * POS_SCALE, 1_000_000_000_000n])
    for (const qty of [1n, POS_SCALE, 123_456_789n]) for (const maxMove of [0n, 1n, 100n, 1500n]) {
      const c = { ...ctx, halfSpreadBps: half, impactBps: impact };
      const a = propAmmQuote(c, [leg({ markPrice: mark, maxQty: qty, maxMoveBps: maxMove })])[0];
      const b = propAmmQuote(c, [leg({ markPrice: mark, maxQty: qty, maxMoveBps: maxMove, takerIsLong: false })])[0];
      assert.ok(a.execPrice >= mark && b.execPrice <= mark && b.execPrice >= 1n);
      assert.ok(a.execPrice - mark <= (mark * maxMove) / 10_000n && mark - b.execPrice <= (mark * maxMove) / 10_000n);
    }
});

test("propAmmQuote: hedged basket (k >= 2 with a buy AND a sell) halves the half-spread; errors mirror the program", () => {
  const ctx = { halfSpreadBps: 21n, impactBps: 2n, maxFillQty: 5n * POS_SCALE, paused: false, allowedMarkets: [1n, 2n] };
  const leg = (marketId: bigint, takerIsLong: boolean, o: object = {}) => ({ mode: TRADE_MODE.NETTED, takerIsLong, marketId, maxQty: POS_SCALE, markPrice: 100n * POS_SCALE, maxMoveBps: 100n, ...o });
  // Matcher.lean:330-332: mask == 3 && k >= 2 -> halfSp >>> 1 (21 -> 10), + 2 impact = 12 bps
  const h = propAmmQuote(ctx, [leg(1n, true), leg(2n, false)]);
  assert.deepEqual(h.map((q) => [q.hedged, q.effBps, q.execPrice]), [[true, 12n, 100_120_000n], [true, 12n, 99_880_000n]]);
  // a reduce-short counts as a BUY for the mask (Matcher.lean:254-255): [sell, reduce short] is hedged
  assert.ok(propAmmQuote(ctx, [leg(1n, false), leg(2n, false, { mode: TRADE_MODE.CLOSE })])[0].hedged);
  // same direction: no discount; k = 1: never hedged
  assert.deepEqual(propAmmQuote(ctx, [leg(1n, true), leg(2n, true)]).map((q) => q.effBps), [23n, 23n]);
  assert.equal(propAmmQuote(ctx, [leg(1n, true)])[0].hedged, false);
  const code = (f: () => unknown) => { try { f(); } catch (e) { assert.ok(e instanceof PropAmmQuoteError); return (e as PropAmmQuoteError).code; } return 0; };
  assert.equal(code(() => propAmmQuote({ ...ctx, paused: true }, [leg(1n, true)])), 200);              // Matcher.lean:322
  assert.equal(code(() => propAmmQuote(ctx, [leg(3n, true)])), 201);                                    // Matcher.lean:280 / 181
  assert.equal(code(() => propAmmQuote(ctx, [leg(1n, true), leg(9n, false)])), 201);
  assert.equal(code(() => propAmmQuote(ctx, [leg(1n, true, { isRamping: true })])), 200);              // Matcher.lean:281
  assert.equal(code(() => propAmmQuote(ctx, [leg(1n, true, { mode: 2 })])), 103);                       // Matcher.lean:279
  assert.equal(code(() => propAmmQuote(ctx, [leg(1n, true, { maxQty: 0n })])), 103);
  assert.equal(code(() => propAmmQuote(ctx, [leg(1n, true, { markPrice: 0n })])), 103);
  assert.throws(() => propAmmQuote(ctx, []), /needs 1\.\.8 legs/);
});

// ============================================================ reward-module parsers (RewardModule.lean:78-128)
test("parseRewardCfg / parseEpochState / parseBidReceipt decode every field at its Lean offset", () => {
  // RewOff (RewardModule.lean:78-104): each field gets a distinct value written at the literal Lean offset.
  const keys = Array.from({ length: 10 }, pk);
  const cfg = Buffer.alloc(400);
  cfg.writeUInt32LE(0x4d574552, 0); // "REWM" (RewardModule.lean:46)
  cfg.writeUInt8(254, 4); cfg.writeUInt8(1, 5); cfg.writeUInt8(6, 6); cfg.writeUInt8(9, 7);
  [8, 40, 72, 104, 136, 168, 200, 232, 264, 296].forEach((off, i) => keys[i].toBuffer().copy(cfg, off));
  [328, 336, 344, 352, 360, 368, 376, 384, 392].forEach((off, i) => cfg.writeBigUInt64LE(BigInt(1000 + i), off));
  const c = parseRewardCfg(cfg);
  assert.deepEqual([c.pdaBump, c.burnMode, c.quoteDecimals, c.targetDecimals], [254, 1, 6, 9]);
  assert.deepEqual([c.percolator, c.dex, c.market, c.quoteMint, c.quoteVault, c.targetMint, c.targetEscrow, c.targetTokProg, c.burnSinkTok, c.activeEpochAcc].map((k) => k!.toBase58()), keys.map((k) => k.toBase58()));
  assert.deepEqual([c.epochSlots, c.minBatchQuote, c.reserveRateE6, c.activeEpochId, c.activeQuote, c.rolloverQuote, c.pendingClaims, c.totalQuoteSpent, c.totalTargetBurned],
    [1000n, 1001n, 1002n, 1003n, 1004n, 1005n, 1006n, 1007n, 1008n]);
  assert.equal(accountKind(cfg), "rewardCfg");
  const idle = Buffer.from(cfg); idle.fill(0, 296, 328);
  assert.equal(parseRewardCfg(idle).activeEpochAcc, null); // zero key = no active epoch
  assert.deepEqual([REWARD_CFG_SIZE, MAGIC_REWARD, RewOff.totalTargetBurned + 8], [400, 0x4d574552, 400]);
  assert.throws(() => parseRewardCfg(cfg.subarray(0, 399)), /bad size/);
  assert.throws(() => parseRewardCfg(Buffer.alloc(400)), /bad magic/);

  // EpochOff (RewardModule.lean:106-119)
  const ep = Buffer.alloc(104);
  ep.writeUInt32LE(0x48435045, 0); // "EPCH" (RewardModule.lean:47)
  ep.writeUInt8(1, 4);
  keys[0].toBuffer().copy(ep, 8);
  [40, 48, 56, 64, 72, 80, 88, 96].forEach((off, i) => ep.writeBigUInt64LE(BigInt(2000 + i), off));
  const e = parseEpochState(ep);
  assert.ok(e.settled && e.cfg.equals(keys[0]));
  assert.deepEqual([e.epochId, e.quotePot, e.virtBids, e.totalBids, e.quotePaid, e.startSlot, e.endSlot, e.claimedQuote], [2000n, 2001n, 2002n, 2003n, 2004n, 2005n, 2006n, 2007n]);
  assert.equal(accountKind(ep), "epochState");
  assert.deepEqual([EPOCH_SIZE, MAGIC_EPOCH, EpochOff.claimedQuote + 8], [104, 0x48435045, 104]);
  const open = Buffer.from(ep); open.writeUInt8(0, 4);
  assert.equal(parseEpochState(open).settled, false);
  assert.throws(() => parseEpochState(cfg), /bad size/);

  // BidOff (RewardModule.lean:121-128)
  const bid = Buffer.alloc(120);
  bid.writeUInt32LE(0x52444942, 0); // "BIDR" (RewardModule.lean:48)
  keys[1].toBuffer().copy(bid, 8); keys[2].toBuffer().copy(bid, 40); keys[3].toBuffer().copy(bid, 72);
  bid.writeBigUInt64LE(77n, 104); bid.writeBigUInt64LE(5_000_000n, 112);
  const r = parseBidReceipt(bid);
  assert.ok(r.cfg.equals(keys[1]) && r.epochAcc.equals(keys[2]) && r.bidder.equals(keys[3]));
  assert.deepEqual([r.epochId, r.amount], [77n, 5_000_000n]);
  assert.equal(accountKind(bid), "bidReceipt");
  assert.deepEqual([BIDDER_SIZE, MAGIC_BID, BidOff.amount + 8, BidOff], [120, 0x52444942, 120, { magic: 0, cfg: 8, epochAcc: 40, bidder: 72, epochId: 104, amount: 112 }]);
  // a claimed receipt is zeroed and stamped "DEAD" (RewardModule.lean:955-958): it must not parse as live
  const dead = Buffer.alloc(120); dead.writeUInt32LE(MAGIC_CLOSED, 0);
  assert.throws(() => parseBidReceipt(dead), /bad magic/);
  assert.equal(accountKind(dead), null);
});

// ============================================================ one-call fresh bundle (refresh.ts)
test("tradeWithMatcherFresh: prepends RefreshLeg for every open leg of the taker AND the LP, single signer", async () => {
  const { tradeWithMatcherFresh } = await import("../../src/lean/refresh.js");
  const { PflOff, LegOff, PORTFOLIO_SIZE } = await import("../../src/lean/constants.js");
  const dex = pk(), taker = pk(), takerPfl = pk(), lpPfl = pk(), ctx = pk();
  const mktA = pk(), mktB = pk(), mktD = pk();
  /** Minimal Portfolio account image with the given (market, side) legs (Layout.lean PflOff / LegOff). */
  const pfl = (legs: [PublicKey, number][]) => {
    const b = Buffer.alloc(PORTFOLIO_SIZE);
    b.writeUInt32LE(MAGIC.PORTFOLIO, 0); b.writeUInt8(legs.length, PflOff.legCount); dex.toBuffer().copy(b, PflOff.dex);
    legs.forEach(([mkt, side], i) => {
      const o = PflOff.headerSize + i * PflOff.legStride;
      b.writeUInt8(1, o + LegOff.active); b.writeUInt8(side, o + LegOff.side); mkt.toBuffer().copy(b, o + LegOff.market);
      b.writeBigUInt64LE(1_000_000n, o + LegOff.rawBasis);
    });
    return b;
  };
  // LP: short A (the traded market), long D, and a FLAT leg on B (must NOT be refreshed). Taker: long D.
  const images = new Map<string, Buffer>([[lpPfl.toBase58(), pfl([[mktA, 2], [mktD, 1], [mktB, 0]])], [takerPfl.toBase58(), pfl([[mktD, 1]])]]);
  const conn = { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => { const d = images.get(k.toBase58()); return d ? { data: d, owner: P, lamports: 1, executable: false } : null; }) } as any;
  const args = { dex, takerPortfolio: takerPfl, taker, lpPortfolio: lpPfl, matcherProgram: M, matcherCtx: ctx,
    legs: [{ market: mktA, mode: TRADE_MODE.NETTED, takerIsLong: true, maxQty: 1n }] };
  const ixs = await tradeWithMatcherFresh(conn, P, args);
  const trade = ixs[ixs.length - 1], refreshes = ixs.slice(0, -1);
  assert.equal(trade.data[0], IX.TradeWithMatcher);
  // RefreshLeg = [10, 0] with accounts dex(W), market(W), portfolio(W); exactly: taker/D, LP/A, LP/D
  assert.ok(refreshes.every((i) => i.programId.equals(P) && i.data[0] === IX.RefreshLeg && i.keys.length === 3 && i.keys[0].pubkey.equals(dex)));
  assert.deepEqual(refreshes.map((i) => `${i.keys[1].pubkey.toBase58()}:${i.keys[2].pubkey.toBase58()}`).sort(),
    [`${mktD.toBase58()}:${takerPfl.toBase58()}`, `${mktA.toBase58()}:${lpPfl.toBase58()}`, `${mktD.toBase58()}:${lpPfl.toBase58()}`].sort());
  // the other open leg's market (D) rides along as ONE trailing read-only account; traded market A is not duplicated
  assert.deepEqual(metas(trade).slice(7), [m(mktD, false, false)]);
  assert.equal(new Set(trade.keys.map((k) => k.pubkey.toBase58())).size, trade.keys.length);
  // only the taker signs anything in the whole bundle
  assert.deepEqual([...new Set(ixs.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())))], [taker.toBase58()]);
  // both flat: nothing to refresh, instruction untouched
  images.set(lpPfl.toBase58(), pfl([])); images.set(takerPfl.toBase58(), pfl([]));
  const bare = await tradeWithMatcherFresh(conn, P, args);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].keys.length, 7);
});
