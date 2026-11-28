/**
 * percolator-lean v2 account parsers (pinned to `2dc4d21`, offsets from constants.ts).
 */
import { PublicKey } from "@solana/web3.js";
import {
  MAGIC, DexOff, MktOff, PflOff, LegOff, InsOff, MatcherCfgOff, AdapterOff, FeedOff,
  DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, MATCHER_CFG_SIZE, ADAPTER_CFG_SIZE,
  FEED_SIZE, MAX_LEGS, SIDE, STATUS, K_ZERO, ADL_ONE, PREM_ZERO,
  PropOff, PROP_CTX_SIZE, RewOff, EpochOff, BidOff, REWARD_CFG_SIZE, EPOCH_SIZE, BIDDER_SIZE,
  MAGIC_REWARD, MAGIC_EPOCH, MAGIC_BID, POS_SCALE, BPS_DEN, TRADE_MODE,
} from "./constants.js";

const u8 = (b: Buffer, o: number) => b.readUInt8(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);
const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));
const isZeroKey = (b: Buffer, o: number) => b.subarray(o, o + 32).every((x) => x === 0);

function expect(b: Buffer, magic: number, size: number, what: string) {
  if (b.length !== size) throw new Error(`${what}: bad size (${b.length} !== ${size})`);
  const m = u32(b, 0);
  if (m !== magic) throw new Error(`${what}: bad magic 0x${m.toString(16)}`);
}

/** Which percolator-lean account type a buffer holds (strict magic + exact size), or null. */
export function accountKind(b: Buffer): "dex" | "market" | "portfolio" | "insReceipt" | "matcherCfg" | "propAmmCtx" | "adapterCfg" | "feed" | "rewardCfg" | "epochState" | "bidReceipt" | null {
  if (b.length < 4) return null;
  switch (u32(b, 0)) {
    case MAGIC.DEX: return b.length === DEX_SIZE ? "dex" : null;
    case MAGIC.MARKET: return b.length === MARKET_SIZE ? "market" : null;
    case MAGIC.PORTFOLIO: return b.length === PORTFOLIO_SIZE ? "portfolio" : null;
    case MAGIC.INSURANCE: return b.length === INS_RECEIPT_SIZE ? "insReceipt" : null;
    case MAGIC.MATCHER: return b.length === MATCHER_CFG_SIZE ? "matcherCfg" : null;
    case MAGIC.MRET: return b.length === PROP_CTX_SIZE ? "propAmmCtx" : null;
    case MAGIC_REWARD: return b.length === REWARD_CFG_SIZE ? "rewardCfg" : null;
    case MAGIC_EPOCH: return b.length === EPOCH_SIZE ? "epochState" : null;
    case MAGIC_BID: return b.length === BIDDER_SIZE ? "bidReceipt" : null;
    case MAGIC.ADAPTER: return b.length === ADAPTER_CFG_SIZE ? "adapterCfg" : null;
    case MAGIC.FEED: return b.length === FEED_SIZE ? "feed" : null;
    default: return null;
  }
}

// ---------------------------------------------------------------- Dex
export interface Dex {
  version: number; vaultBump: number; decimals: number; allowFreeze: number;
  admin: PublicKey; quoteMint: PublicKey; vault: PublicKey; feeVault: PublicKey;
  nextMarketId: bigint; nextPortfolioId: bigint; createFee: bigint;
  vaultBalance: bigint; totalCapital: bigint; totalInsurance: bigint; totalResidual: bigint; totalSurplus: bigint; totalRewards: bigint;
}
export function parseDex(b: Buffer): Dex {
  expect(b, MAGIC.DEX, DEX_SIZE, "Dex");
  const O = DexOff;
  return {
    version: u8(b, O.version), vaultBump: u8(b, O.vaultBump), decimals: u8(b, O.decimals), allowFreeze: u8(b, O.allowFreeze),
    admin: pk(b, O.admin), quoteMint: pk(b, O.quoteMint), vault: pk(b, O.vaultPda), feeVault: pk(b, O.feeVault),
    nextMarketId: u64(b, O.nextMarketId), nextPortfolioId: u64(b, O.nextPortfolioId), createFee: u64(b, O.createFee),
    vaultBalance: u64(b, O.vaultBalance), totalCapital: u64(b, O.totalCapital), totalInsurance: u64(b, O.totalInsurance),
    totalResidual: u64(b, O.totalResidual), totalSurplus: u64(b, O.totalSurplus), totalRewards: u64(b, O.totalRewards),
  };
}

// ---------------------------------------------------------------- Market
export interface Market {
  status: number; statusName: string; marketId: bigint; dex: PublicKey;
  oracleAuth: PublicKey; marketAdmin: PublicKey | null;
  markPrice: bigint; lastOracleSlot: bigint; windDownSlot: bigint;
  exitWindow: bigint; maxStaleness: bigint;
  /** @deprecated legacy name of bytes 152..159 — same value as `lastRampSlot`. */
  warmupSlots: bigint;
  /** Slot of the last saturated oracle ramp tick / bankruptcy (0 = none). For 150 slots after it the PropAMM refuses to quote. */
  lastRampSlot: bigint;
  imBps: bigint; mmBps: bigint; liqFeeBps: bigint; tradeFeeBps: bigint; maxMoveBps: bigint;
  maxInsDrawBps: bigint; maxOi: bigint; minMm: bigint;
  realizedPool: bigint; insurance: bigint; insFronted: bigint; maxFrontBps: bigint; totalPosPnl: bigint; totalInsShares: bigint;
  oiLong: bigint; oiShort: bigint; rawBasisLong: bigint; rawBasisShort: bigint;
  adlLong: bigint; adlShort: bigint;
  /** raw cumulative K (biased by K_ZERO) */
  kLong: bigint; kShort: bigint;
  resolvedNum: bigint; resolvedDen: bigint; activeLegs: bigint; rewardBps: bigint; rewardAccrued: bigint; rewardRecipient: PublicKey;
  /** 9b45ad1 built-in funding: packed cfg (0 = off), raw biased premium EWMA, and its signed E6 value (100 = 1 bps). */
  fundingCfg: bigint; premiumEwma: bigint; premiumE6: bigint;
  funding: { baseIntE6: number; deadbandE6: number; maxFund8hBps: number; decaySlots: number } | null;
}
const STATUS_NAMES = ["Active", "WindDown", "Resolved", "Tombstoned"];
const fundingOf = (c: bigint) => c === 0n ? null : {
  baseIntE6: Number(c & 0xffffn), deadbandE6: Number((c >> 16n) & 0xffffn), maxFund8hBps: Number((c >> 32n) & 0xffffn), decaySlots: Number((c >> 48n) & 0xffffn) };
export function parseMarket(b: Buffer): Market {
  expect(b, MAGIC.MARKET, MARKET_SIZE, "Market");
  const O = MktOff;
  const status = u8(b, O.status);
  return {
    status, statusName: STATUS_NAMES[status] ?? `?${status}`, marketId: u64(b, O.marketId), dex: pk(b, O.dex),
    oracleAuth: pk(b, O.oracleAuth), marketAdmin: isZeroKey(b, O.marketAdmin) ? null : pk(b, O.marketAdmin),
    markPrice: u64(b, O.markPrice), lastOracleSlot: u64(b, O.lastOracleSlot), windDownSlot: u64(b, O.windDownSlot),
    exitWindow: u64(b, O.exitWindow), maxStaleness: u64(b, O.maxStaleness), warmupSlots: u64(b, O.warmupSlots), lastRampSlot: u64(b, O.lastRampSlot),
    imBps: u64(b, O.imBps), mmBps: u64(b, O.mmBps), liqFeeBps: u64(b, O.liqFeeBps), tradeFeeBps: u64(b, O.tradeFeeBps),
    maxMoveBps: u64(b, O.maxMoveBps), maxInsDrawBps: u64(b, O.maxInsDrawBps), maxOi: u64(b, O.maxOi), minMm: u64(b, O.minMm),
    realizedPool: u64(b, O.realizedPool), insurance: u64(b, O.insurance), insFronted: u64(b, O.insFronted),
    maxFrontBps: BigInt(b.readUInt16LE(O.maxFrontBps)),
    totalPosPnl: u64(b, O.totalPosPnl), totalInsShares: u64(b, O.totalInsShares),
    oiLong: u64(b, O.oiLong), oiShort: u64(b, O.oiShort), rawBasisLong: u64(b, O.rawBasisLong), rawBasisShort: u64(b, O.rawBasisShort),
    adlLong: u64(b, O.adlLong), adlShort: u64(b, O.adlShort), kLong: u64(b, O.kLong), kShort: u64(b, O.kShort),
    resolvedNum: u64(b, O.resolvedNum), resolvedDen: u64(b, O.resolvedDen), activeLegs: u64(b, O.activeLegs),
    rewardBps: u64(b, O.rewardBps), rewardAccrued: u64(b, O.rewardAccrued), rewardRecipient: pk(b, O.rewardRecipient),
    fundingCfg: u64(b, O.fundingCfg), premiumEwma: u64(b, O.premiumEwma), premiumE6: u64(b, O.premiumEwma) - PREM_ZERO,
    funding: fundingOf(u64(b, O.fundingCfg)),
  };
}
/** Signed K relative to K_ZERO. */
export const kSigned = (k: bigint) => k - K_ZERO;
export const isMarketActive = (m: Market) => m.status === STATUS.ACTIVE;

// ---------------------------------------------------------------- Portfolio
export interface Leg {
  index: number; side: number; sideName: "flat" | "long" | "short";
  marketId: bigint; market: PublicKey;
  rawBasis: bigint; entryK: bigint; posPnl: bigint; cachedMm: bigint; cachedIm: bigint; lastRefreshSlot: bigint; lockedMm: bigint;
}
export interface Portfolio {
  legCount: number; portfolioId: bigint; totalLockedMm: bigint; dex: PublicKey; owner: PublicKey;
  capital: bigint; totalMm: bigint; totalIm: bigint; matcherCtx: PublicKey;
  /** active leg slots only */
  legs: Leg[];
}
const SIDE_NAMES = ["flat", "long", "short"] as const;
export function parsePortfolio(b: Buffer): Portfolio {
  expect(b, MAGIC.PORTFOLIO, PORTFOLIO_SIZE, "Portfolio");
  const O = PflOff;
  const legs: Leg[] = [];
  for (let i = 0; i < MAX_LEGS; i++) {
    const base = O.headerSize + i * O.legStride;
    if (u8(b, base + LegOff.active) === 0) continue;
    const side = u8(b, base + LegOff.side);
    legs.push({
      index: i, side, sideName: SIDE_NAMES[side] ?? "flat",
      marketId: u64(b, base + LegOff.marketId), market: pk(b, base + LegOff.market),
      rawBasis: u64(b, base + LegOff.rawBasis), entryK: u64(b, base + LegOff.entryK), posPnl: u64(b, base + LegOff.posPnl),
      cachedMm: u64(b, base + LegOff.cachedMm), cachedIm: u64(b, base + LegOff.cachedIm),
      lastRefreshSlot: u64(b, base + LegOff.lastRefreshSlot), lockedMm: u64(b, base + LegOff.lockedMm),
    });
  }
  return {
    legCount: u8(b, O.legCount), portfolioId: u64(b, O.portfolioId), totalLockedMm: u64(b, O.totalLockedMm),
    dex: pk(b, O.dex), owner: pk(b, O.owner), capital: u64(b, O.capital), totalMm: u64(b, O.totalMm), totalIm: u64(b, O.totalIm), matcherCtx: pk(b, O.matcherCtx),
    legs,
  };
}
/** Legs the program's same-slot freshness check covers (active and not flat). */
export const openLegs = (p: Portfolio) => p.legs.filter((l) => l.side !== SIDE.FLAT);

// ---------------------------------------------------------------- InsReceipt
export interface InsReceipt { marketId: bigint; owner: PublicKey; market: PublicKey; shares: bigint }
export function parseInsReceipt(b: Buffer): InsReceipt {
  expect(b, MAGIC.INSURANCE, INS_RECEIPT_SIZE, "InsReceipt");
  return { marketId: u64(b, InsOff.marketId), owner: pk(b, InsOff.owner), market: pk(b, InsOff.market), shares: u64(b, InsOff.shares) };
}

// ---------------------------------------------------------------- PropAMM ctx (Matcher.lean:31-50)
export interface PropAmmQuoteSlot { execPrice: bigint; fillQty: bigint }
export interface PropAmmCtx {
  /** MatcherReturn header: status 0 = ok; seq = sequence number of the LAST quote written (core sends preSeq + 1). */
  status: number; seq: bigint;
  /** All 8 quote slots as last written (slot i = leg i of the most recent quote; stale beyond that quote's k). */
  quotes: PropAmmQuoteSlot[];
  owner: PublicKey; halfSpreadBps: bigint; impactBps: bigint; maxFillQty: bigint; paused: boolean;
  /** IMMUTABLE allowlist: the first `allowedCount` market ids. */
  allowedCount: number; allowedMarkets: bigint[];
}
/** Parse a 272-byte PropAMM ctx ("MRET" header + 8 quote slots + owner params + immutable allowlist). */
export function parsePropAmmCtx(b: Buffer): PropAmmCtx {
  expect(b, MAGIC.MRET, PROP_CTX_SIZE, "PropAmmCtx");
  const O = PropOff;
  const allowedCount = u8(b, O.allowedCount);
  if (allowedCount < 1 || allowedCount > MAX_LEGS) throw new Error(`PropAmmCtx: bad allowedCount ${allowedCount}`);
  return {
    status: u32(b, O.status), seq: u64(b, O.seq),
    quotes: Array.from({ length: MAX_LEGS }, (_, i) => ({
      execPrice: u64(b, O.quotesBase + i * O.quoteStride), fillQty: u64(b, O.quotesBase + i * O.quoteStride + 8) })),
    owner: pk(b, O.owner), halfSpreadBps: u64(b, O.halfSpreadBps), impactBps: u64(b, O.impactBps),
    maxFillQty: u64(b, O.maxFillQty), paused: u8(b, O.paused) !== 0,
    allowedCount, allowedMarkets: Array.from({ length: allowedCount }, (_, i) => u64(b, O.allowedMarkets + i * 8)),
  };
}

/** Thrown by `propAmmQuote` where the on-chain quote would fail; `code` is the program's custom error number. */
export class PropAmmQuoteError extends Error {
  constructor(public readonly code: number, message: string) { super(message); this.name = "PropAmmQuoteError"; }
}
export interface PropAmmQuoteLeg {
  mode: number; takerIsLong: boolean; marketId: bigint; maxQty: bigint;
  /** Market.markPrice and Market.maxMoveBps as they will be when the trade lands. */
  markPrice: bigint; maxMoveBps: bigint;
  /** Market is inside its 150-slot ramp cooldown (lastRampSlot != 0 && slot - lastRampSlot <= 150). */
  isRamping?: boolean;
}
export interface PropAmmQuote { isBuy: boolean; execPrice: bigint; fillQty: bigint; effBps: bigint; hedged: boolean }
const U64_MAX_Q = (1n << 64n) - 1n;
/**
 * Pure off-chain replica of PropAmmQuote (Matcher.lean:246-337) for a whole basket: what `tradeWithMatcher` will
 * fill at for these legs given the ctx params and each market's mark/maxMoveBps.
 *   fillQty   = min(maxQty, maxFillQty)                                   (CLAMP, never a reject)
 *   effBps    = min(halfSpread' + floor(fillQty * impactBps / 1e6), maxMoveBps)
 *   delta     = floor(mark * effBps / 10000)
 *   execPrice = buy ? mark + delta : max(mark - delta, 1)                  (buy = ask >= mark, sell = bid <= mark)
 *   halfSpread' = halfSpreadBps >> 1 when the basket has k >= 2 legs with BOTH a buy and a sell ("hedged").
 * Throws PropAmmQuoteError(200) if paused / a leg is ramping, (201) if a leg's market is not allowlisted,
 * (103) on a bad mode / zero qty / zero mark — the same codes the transaction would fail with.
 */
export function propAmmQuote(
  ctx: Pick<PropAmmCtx, "halfSpreadBps" | "impactBps" | "maxFillQty" | "paused" | "allowedMarkets">, legs: PropAmmQuoteLeg[],
): PropAmmQuote[] {
  if (legs.length < 1 || legs.length > MAX_LEGS) throw new RangeError(`propAmmQuote: needs 1..${MAX_LEGS} legs, got ${legs.length}`);
  if (ctx.paused) throw new PropAmmQuoteError(200, "PropAMM is paused");
  const buy = (l: PropAmmQuoteLeg) => (l.mode !== TRADE_MODE.CLOSE && l.takerIsLong) || (l.mode === TRADE_MODE.CLOSE && !l.takerIsLong);
  const hedged = legs.length >= 2 && legs.some(buy) && legs.some((l) => !buy(l));
  const effHalf = hedged ? ctx.halfSpreadBps >> 1n : ctx.halfSpreadBps;
  const fit = (v: bigint, what: string) => { if (v > U64_MAX_Q) throw new RangeError(`propAmmQuote: ${what} overflows u64 (the on-chain quote would fail)`); return v; };
  return legs.map((l, i) => {
    if (!(l.mode === TRADE_MODE.OPEN || l.mode === TRADE_MODE.CLOSE || l.mode === TRADE_MODE.NETTED) || l.maxQty <= 0n || l.markPrice <= 0n)
      throw new PropAmmQuoteError(103, `leg ${i}: invalid mode/qty/mark`);
    if (!ctx.allowedMarkets.includes(l.marketId)) throw new PropAmmQuoteError(201, `leg ${i}: market id ${l.marketId} is not in the PropAMM allowlist`);
    if (l.isRamping) throw new PropAmmQuoteError(200, `leg ${i}: market ${l.marketId} is in its ramp cooldown (PropAMM does not quote)`);
    const fillQty = l.maxQty < ctx.maxFillQty ? l.maxQty : ctx.maxFillQty;
    const raw = fit(effHalf + fit((fillQty * ctx.impactBps) / POS_SCALE, "impact"), "spread");
    const effBps = raw > l.maxMoveBps ? l.maxMoveBps : raw;
    const delta = fit((l.markPrice * effBps) / BPS_DEN, "delta");
    const isBuy = buy(l);
    const execPrice = isBuy ? fit(l.markPrice + delta, "ask") : (l.markPrice > delta ? l.markPrice - delta : 1n);
    return { isBuy, execPrice, fillQty, effBps, hedged };
  });
}

// ---------------------------------------------------------------- reward module (RewardModule.lean:78-128)
export interface RewardCfg {
  pdaBump: number; burnMode: number; quoteDecimals: number; targetDecimals: number;
  percolator: PublicKey; dex: PublicKey; market: PublicKey; quoteMint: PublicKey; quoteVault: PublicKey;
  targetMint: PublicKey; targetEscrow: PublicKey; targetTokProg: PublicKey;
  /** burnMode 1 dead-sink token account (zero key in burnMode 0). */
  burnSinkTok: PublicKey;
  /** Current epoch account, or null when no epoch is active (zero key). */
  activeEpochAcc: PublicKey | null;
  epochSlots: bigint; minBatchQuote: bigint; reserveRateE6: bigint; activeEpochId: bigint; activeQuote: bigint;
  rolloverQuote: bigint; pendingClaims: bigint; totalQuoteSpent: bigint; totalTargetBurned: bigint;
}
export function parseRewardCfg(b: Buffer): RewardCfg {
  expect(b, MAGIC_REWARD, REWARD_CFG_SIZE, "RewardCfg");
  const O = RewOff;
  return {
    pdaBump: u8(b, O.pdaBump), burnMode: u8(b, O.burnMode), quoteDecimals: u8(b, O.quoteDecimals), targetDecimals: u8(b, O.targetDecimals),
    percolator: pk(b, O.percProg), dex: pk(b, O.dex), market: pk(b, O.market), quoteMint: pk(b, O.quoteMint),
    quoteVault: pk(b, O.quoteVault), targetMint: pk(b, O.targetMint), targetEscrow: pk(b, O.targetEscrow),
    targetTokProg: pk(b, O.targetTokProg), burnSinkTok: pk(b, O.burnSinkTok),
    activeEpochAcc: isZeroKey(b, O.activeEpochAcc) ? null : pk(b, O.activeEpochAcc),
    epochSlots: u64(b, O.epochSlots), minBatchQuote: u64(b, O.minBatchQuote), reserveRateE6: u64(b, O.reserveRateE6),
    activeEpochId: u64(b, O.activeEpochId), activeQuote: u64(b, O.activeQuote), rolloverQuote: u64(b, O.rolloverQuote),
    pendingClaims: u64(b, O.pendingClaims), totalQuoteSpent: u64(b, O.totalQuoteSpent), totalTargetBurned: u64(b, O.totalTargetBurned),
  };
}

export interface EpochState {
  settled: boolean; cfg: PublicKey; epochId: bigint;
  /** Q_e: quote pot auctioned this epoch. */ quotePot: bigint;
  /** B_virt: virtual reserve bids. */ virtBids: bigint;
  /** B_e: total target bid so far. */ totalBids: bigint;
  /** floor(Q_e * B_e / (B_e + B_virt)), fixed at settle. */ quotePaid: bigint;
  startSlot: bigint; endSlot: bigint; claimedQuote: bigint;
}
export function parseEpochState(b: Buffer): EpochState {
  expect(b, MAGIC_EPOCH, EPOCH_SIZE, "EpochState");
  const O = EpochOff;
  return {
    settled: u8(b, O.settled) !== 0, cfg: pk(b, O.cfg), epochId: u64(b, O.epochId), quotePot: u64(b, O.quotePot),
    virtBids: u64(b, O.virtBids), totalBids: u64(b, O.totalBids), quotePaid: u64(b, O.quotePaid),
    startSlot: u64(b, O.startSlot), endSlot: u64(b, O.endSlot), claimedQuote: u64(b, O.claimedQuote),
  };
}

export interface BidReceipt { cfg: PublicKey; epochAcc: PublicKey; bidder: PublicKey; epochId: bigint; amount: bigint }
/** Throws on a claimed receipt: ClaimQuote zeroes it and stamps the "DEAD" magic (MAGIC_CLOSED). */
export function parseBidReceipt(b: Buffer): BidReceipt {
  expect(b, MAGIC_BID, BIDDER_SIZE, "BidReceipt");
  const O = BidOff;
  return { cfg: pk(b, O.cfg), epochAcc: pk(b, O.epochAcc), bidder: pk(b, O.bidder), epochId: u64(b, O.epochId), amount: u64(b, O.amount) };
}

// ---------------------------------------------------------------- matcher / adapter / feed
/** @deprecated LEGACY 160-byte passive-matcher config (pre-PropAMM). Use PropAmmCtx / parsePropAmmCtx. */
export interface MatcherConfig {
  pdaBump: number; paused: boolean; owner: PublicKey; percolator: PublicKey; lpPortfolio: PublicKey;
  halfSpreadBps: bigint; impactBps: bigint; maxFillQty: bigint; market: PublicKey;
}
/** @deprecated LEGACY (pre-PropAMM): the 887ba02 matcher never creates this account. Use parsePropAmmCtx. */
export function parseMatcherConfig(b: Buffer): MatcherConfig {
  expect(b, MAGIC.MATCHER, MATCHER_CFG_SIZE, "MatcherConfig");
  const O = MatcherCfgOff;
  return {
    pdaBump: u8(b, O.pdaBump), paused: u8(b, O.paused) !== 0, owner: pk(b, O.owner), percolator: pk(b, O.percProg),
    lpPortfolio: pk(b, O.lpPortfolio), halfSpreadBps: u64(b, O.halfSpreadBps), impactBps: u64(b, O.impactBps), maxFillQty: u64(b, O.maxFillQty),
    market: pk(b, O.market),
  };
}

export interface AdapterConfig {
  pdaBump: number; feedType: number; quoteFeedType: number; flags: number;
  admin: PublicKey; percolator: PublicKey; market: PublicKey; feed: PublicKey; feedOwner: PublicKey; feedId: Buffer;
  maxFeedAge: bigint; maxConfBps: bigint; fundingBpsPerStep: bigint;
  hasQuote: boolean; quoteFeed: PublicKey | null; quoteFeedOwner: PublicKey | null; quoteFeedId: Buffer | null;
  hybridAfterHours: boolean; ewmaAlphaBps: bigint; ewmaPrice: bigint; ewmaMaxDevBps: bigint; lastEwmaSlot: bigint;
}
export function parseAdapterConfig(b: Buffer): AdapterConfig {
  expect(b, MAGIC.ADAPTER, ADAPTER_CFG_SIZE, "AdapterConfig");
  const O = AdapterOff;
  const flags = u8(b, O.flags);
  const hasQuote = (flags & 1) !== 0;
  return {
    pdaBump: u8(b, O.pdaBump), feedType: u8(b, O.feedType), quoteFeedType: u8(b, O.quoteFeedType), flags,
    admin: pk(b, O.admin), percolator: pk(b, O.percProg), market: pk(b, O.market), feed: pk(b, O.feedAccount),
    feedOwner: pk(b, O.feedOwner), feedId: Buffer.from(b.subarray(O.feedId, O.feedId + 32)),
    maxFeedAge: u64(b, O.maxFeedAge), maxConfBps: u64(b, O.maxConfBps),
    fundingBpsPerStep: u64(b, O.fundingBpsPerStep), hasQuote, quoteFeed: hasQuote ? pk(b, O.quoteFeed) : null,
    quoteFeedOwner: hasQuote ? pk(b, O.quoteFeedOwner) : null, quoteFeedId: hasQuote ? Buffer.from(b.subarray(O.quoteFeedId, O.quoteFeedId + 32)) : null,
    hybridAfterHours: (flags & 8) !== 0, ewmaAlphaBps: u64(b, O.ewmaAlphaBps), ewmaPrice: u64(b, O.ewmaPrice), ewmaMaxDevBps: u64(b, O.ewmaMaxDevBps), lastEwmaSlot: u64(b, O.lastEwmaSlot),
  };
}

export interface Feed { price: bigint; conf: bigint; publishSlot: bigint }
export function parseFeed(b: Buffer): Feed {
  expect(b, MAGIC.FEED, FEED_SIZE, "Feed");
  return { price: u64(b, FeedOff.price), conf: u64(b, FeedOff.conf), publishSlot: u64(b, FeedOff.publishSlot) };
}

// ---------------------------------------------------------------- invariants
export interface InvariantReport { ok: boolean; problems: string[] }
/**
 * Off-chain check of the conservation invariants the LiteSVM suite asserts:
 *   V == SPL balance, C+I+R+S == V, Σ pfl.capital == C, Σ m.insurance == I, Σ m.realizedPool == R,
 *   Σ m.feeSurplus == S, per market oiLong == oiShort <= min(maxOi, rawBasis) and adl <= ADL_ONE,
 *   per portfolio Σ leg.cachedMm/Im == totalMm/Im and active legs == legCount.
 *   Mirrors assert_dex_invariants in percolator-lean/svm-runner (2dc4d21).
 * Pass every market and portfolio of the DEX (e.g. from discover.ts) for the sum checks to apply.
 */
export function checkDexInvariants(
  dex: Dex, vaultTokenBalance: bigint, markets: Market[], portfolios: Portfolio[], receipts?: InsReceipt[],
): InvariantReport {
  const problems: string[] = [];
  const need = (c: boolean, m: string) => { if (!c) problems.push(m); };
  need(dex.vaultBalance === vaultTokenBalance, `V ${dex.vaultBalance} != SPL ${vaultTokenBalance}`);
  const sum = dex.totalCapital + dex.totalInsurance + dex.totalResidual + dex.totalSurplus + dex.totalRewards;
  need(sum === dex.vaultBalance, `C+I+R+S+Rew ${sum} != V ${dex.vaultBalance}`);
  const sumRew = markets.reduce((a, m) => a + m.rewardAccrued, 0n);
  need(sumRew === dex.totalRewards, `ΣrewardAccrued ${sumRew} != totalRewards ${dex.totalRewards}`);
  const sumCap = portfolios.reduce((a, p) => a + p.capital + p.totalLockedMm, 0n);
  need(sumCap === dex.totalCapital, `Σ(capital+lockedMm) ${sumCap} != C ${dex.totalCapital}`);
  const sumIns = markets.reduce((a, m) => a + m.insurance, 0n);
  need(sumIns === dex.totalInsurance, `Σinsurance ${sumIns} != I ${dex.totalInsurance}`);
  const sumR = markets.reduce((a, m) => a + m.realizedPool, 0n);
  need(sumR === dex.totalResidual, `ΣrealizedPool ${sumR} != R ${dex.totalResidual}`);
  // a056eee: per-market feeSurplus(232) became insFronted (F_m); S_tot is swept separately, no per-market sum to assert.
  for (const m of markets) {
    const id = `market ${m.marketId}`;
    need(m.oiLong === m.oiShort, `${id}: oiLong ${m.oiLong} != oiShort ${m.oiShort}`);
    need(m.oiLong <= m.maxOi, `${id}: oi ${m.oiLong} > maxOi ${m.maxOi}`);
    need(m.oiLong <= m.rawBasisLong, `${id}: oiLong ${m.oiLong} > rawBasisLong ${m.rawBasisLong}`);
    need(m.oiShort <= m.rawBasisShort, `${id}: oiShort ${m.oiShort} > rawBasisShort ${m.rawBasisShort}`);
    need(m.adlLong <= ADL_ONE && m.adlShort <= ADL_ONE, `${id}: adl > ADL_ONE`);
    if (receipts) {
      const mShares = receipts.filter((r) => r.marketId === m.marketId).reduce((a, r) => a + r.shares, 0n);
      need(mShares <= m.totalInsShares, `${id}: Σreceipt.shares ${mShares} > totalInsShares ${m.totalInsShares}`);
    }
  }
  for (const p of portfolios) {
    const mm = p.legs.reduce((a, l) => a + l.cachedMm, 0n);
    const im = p.legs.reduce((a, l) => a + l.cachedIm, 0n);
    const lck = p.legs.reduce((a, l) => a + l.lockedMm, 0n);
    need(mm === p.totalMm, `portfolio ${p.portfolioId}: Σmm ${mm} != totalMm ${p.totalMm}`);
    need(im === p.totalIm, `portfolio ${p.portfolioId}: Σim ${im} != totalIm ${p.totalIm}`);
    need(lck === p.totalLockedMm, `portfolio ${p.portfolioId}: ΣlockedMm ${lck} != totalLockedMm ${p.totalLockedMm}`);
    need(p.legs.length === p.legCount, `portfolio ${p.portfolioId}: active legs ${p.legs.length} != legCount ${p.legCount}`);
  }
  return { ok: problems.length === 0, problems };
}
