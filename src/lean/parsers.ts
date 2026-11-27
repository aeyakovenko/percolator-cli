/**
 * percolator-lean v2 account parsers (pinned to `2dc4d21`, offsets from constants.ts).
 */
import { PublicKey } from "@solana/web3.js";
import {
  MAGIC, DexOff, MktOff, PflOff, LegOff, InsOff, MatcherCfgOff, AdapterOff, FeedOff,
  DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, MATCHER_CFG_SIZE, ADAPTER_CFG_SIZE,
  FEED_SIZE, MAX_LEGS, SIDE, STATUS, K_ZERO, ADL_ONE,
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
export function accountKind(b: Buffer): "dex" | "market" | "portfolio" | "insReceipt" | "matcherCfg" | "adapterCfg" | "feed" | null {
  if (b.length < 4) return null;
  switch (u32(b, 0)) {
    case MAGIC.DEX: return b.length === DEX_SIZE ? "dex" : null;
    case MAGIC.MARKET: return b.length === MARKET_SIZE ? "market" : null;
    case MAGIC.PORTFOLIO: return b.length === PORTFOLIO_SIZE ? "portfolio" : null;
    case MAGIC.INSURANCE: return b.length === INS_RECEIPT_SIZE ? "insReceipt" : null;
    case MAGIC.MATCHER: return b.length === MATCHER_CFG_SIZE ? "matcherCfg" : null;
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
  exitWindow: bigint; maxStaleness: bigint; warmupSlots: bigint;
  imBps: bigint; mmBps: bigint; liqFeeBps: bigint; tradeFeeBps: bigint; maxMoveBps: bigint;
  maxInsDrawBps: bigint; maxOi: bigint; minMm: bigint;
  realizedPool: bigint; insurance: bigint; insFronted: bigint; maxFrontBps: bigint; totalPosPnl: bigint; totalInsShares: bigint;
  oiLong: bigint; oiShort: bigint; rawBasisLong: bigint; rawBasisShort: bigint;
  adlLong: bigint; adlShort: bigint;
  /** raw cumulative K (biased by K_ZERO) */
  kLong: bigint; kShort: bigint;
  resolvedNum: bigint; resolvedDen: bigint; activeLegs: bigint; rewardBps: bigint; rewardAccrued: bigint; rewardRecipient: PublicKey;
}
const STATUS_NAMES = ["Active", "WindDown", "Resolved", "Tombstoned"];
export function parseMarket(b: Buffer): Market {
  expect(b, MAGIC.MARKET, MARKET_SIZE, "Market");
  const O = MktOff;
  const status = u8(b, O.status);
  return {
    status, statusName: STATUS_NAMES[status] ?? `?${status}`, marketId: u64(b, O.marketId), dex: pk(b, O.dex),
    oracleAuth: pk(b, O.oracleAuth), marketAdmin: isZeroKey(b, O.marketAdmin) ? null : pk(b, O.marketAdmin),
    markPrice: u64(b, O.markPrice), lastOracleSlot: u64(b, O.lastOracleSlot), windDownSlot: u64(b, O.windDownSlot),
    exitWindow: u64(b, O.exitWindow), maxStaleness: u64(b, O.maxStaleness), warmupSlots: u64(b, O.warmupSlots),
    imBps: u64(b, O.imBps), mmBps: u64(b, O.mmBps), liqFeeBps: u64(b, O.liqFeeBps), tradeFeeBps: u64(b, O.tradeFeeBps),
    maxMoveBps: u64(b, O.maxMoveBps), maxInsDrawBps: u64(b, O.maxInsDrawBps), maxOi: u64(b, O.maxOi), minMm: u64(b, O.minMm),
    realizedPool: u64(b, O.realizedPool), insurance: u64(b, O.insurance), insFronted: u64(b, O.insFronted),
    maxFrontBps: BigInt(b.readUInt16LE(O.maxFrontBps)),
    totalPosPnl: u64(b, O.totalPosPnl), totalInsShares: u64(b, O.totalInsShares),
    oiLong: u64(b, O.oiLong), oiShort: u64(b, O.oiShort), rawBasisLong: u64(b, O.rawBasisLong), rawBasisShort: u64(b, O.rawBasisShort),
    adlLong: u64(b, O.adlLong), adlShort: u64(b, O.adlShort), kLong: u64(b, O.kLong), kShort: u64(b, O.kShort),
    resolvedNum: u64(b, O.resolvedNum), resolvedDen: u64(b, O.resolvedDen), activeLegs: u64(b, O.activeLegs),
    rewardBps: u64(b, O.rewardBps), rewardAccrued: u64(b, O.rewardAccrued), rewardRecipient: pk(b, O.rewardRecipient),
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

// ---------------------------------------------------------------- matcher / adapter / feed
export interface MatcherConfig {
  pdaBump: number; paused: boolean; owner: PublicKey; percolator: PublicKey; lpPortfolio: PublicKey;
  halfSpreadBps: bigint; impactBps: bigint; maxFillQty: bigint; market: PublicKey;
}
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
