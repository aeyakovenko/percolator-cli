/**
 * percolator-lean v2 constants, layouts, opcodes and error codes.
 *
 * PINNED to percolator-lean commit `46969cd` (account layouts = 9b45ad1; 8774e86+ needs trailing leg markets) (Layout/Matcher/OracleAdapter.lean).
 * Everything ABI-specific lives in this file and instructions.ts — re-pinning to a new
 * commit is an edit to these two files only.
 */
import { PublicKey } from "@solana/web3.js";

export const LEAN_SOURCE_COMMIT = "46969cd";

// ---------- deployed programs (devnet) ----------
export const LEAN_DEVNET = {
  // a31a1f8 (deployed via Agave CLI 4.4.1, 2026-11-27) — validation deployment.
  percolator: new PublicKey("4xw3wdbqbTXWKdxYkSYgfsk3GX2YTbKsiefKwFr9Q6TM"),
  matcher: new PublicKey("2HQtUrH1u4KnPGABxyVNNmXo9SJ3zQg9otz6wyfJMJip"),
  oracleAdapter: new PublicKey("BkyW7iLvAWuyEozvnGAwgks4dyuTNm7Xnybd6DwQLu2x"),
  rewardModule: new PublicKey("4vj8wK4HBsyxi5xMz7UXVpkKw1CqMBkrvRBmuM8YvHAi"),
  /** test-only writable FEED account program (lean-devnet/mock-feed) */
  mockFeed: new PublicKey("9EqYn4MUYC8q4FNcV3SAvYN9VuLsouLSYJxW1eEy7yNx"),
} as const;

// ---------- deployed programs (mainnet-beta) ----------
// ROUND 4 (launched on 9b45ad1, upgraded in place to 887ba02; built-in HL/Binance funding, Market = 416 B): FRESH program ids, deployed 2026-11-28
// via Agave CLI 4.4.1 (devnet-validated). Upgrade authority: A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK.
export const LEAN_MAINNET = {
  percolator: new PublicKey("EUj4Jj8SY3MpkboazJWLeUMmZjCAwwaUhkAGXZQNfLnB"),
  rewardModule: new PublicKey("CH9WNijiS9p6bKfSEgpHXujAJuxUJ29rgynZuZst9Utv"),
  matcher: new PublicKey("GVN3LTDVGRstkxSYzg2Jw8YoguyvgHBTpewK8mEwBBtp"),
  oracleAdapter: new PublicKey("BTJX41YamU8Y74FCcUGMGbjxwamrc2artBUvViF9Tyoz"),
} as const;
/** ROUND 3 (DEPRECATED, a31a1f8, Market = 400 B): left running untouched for users who still hold
 *  positions there. NOT compatible with this client's 416-byte Market layout — use percolator-cli@5ba2b70. */
export const LEAN_MAINNET_R3 = {
  percolator: new PublicKey("6NeT5VYzF2DAj8RcUJtLfgv21CR8WiehNpABFV1t4M3Q"),
  rewardModule: new PublicKey("D8V9aNXEPjgan1Kz4wjYrW5UJZzJWsGYsVJpa6NPtEMw"),
  matcher: new PublicKey("EFLgSpuiyXxHJHFAWCZtmzdcTXeHguiMSUyRHN3z3FDR"),
  oracleAdapter: new PublicKey("B4v96XfX4df9NtPbHjYsLTYkrjccGqWt4nsgyPpJbCSN"),
} as const;

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

// ---------- scales & bounds ----------
export const POS_SCALE = 1_000_000n;
export const ADL_ONE = 1_000_000_000n;
export const BPS_DEN = 10_000n;
export const K_ZERO = 0x4000000000000000n;
export const MAX_PRICE = 1_000_000_000_000n;
export const MAX_OI = 10_000_000_000_000n;
export const MAX_CREATE_FEE = 10_000_000_000n;
export const MIN_EXIT_WINDOW = 10n;
/** e1e4404: first insurance LP deposit to a market must be >= 1.0 quote unit (anti-inflation). */
export const MIN_FIRST_INS_DEPOSIT = 1_000_000n;
export const MAX_LEGS = 8;
/** InitDex: minimum lamports the vault PDA must end up with (165-byte token account) */
export const SPL_TOKEN_ACCOUNT_RENT = 2_039_280n;

// ---------- magics (u32 LE at offset 0) ----------
export const MAGIC = {
  DEX: 0x58454450,        // "PDEX"
  MARKET: 0x50544b4d,     // "MKTP"
  PORTFOLIO: 0x4f4c4650,  // "PFLO"
  INSURANCE: 0x52534e49,  // "INSR"
  MATCHER: 0x4843544d,    // "MTCH" (LEGACY 160-byte passive-matcher config; not produced by the 887ba02 matcher)
  MRET: 0x5445524d,       // "MRET" — PropAMM ctx / MatcherReturn header (Layout.lean:50)
  ADAPTER: 0x5044414f,    // "OADP"
  FEED: 0x44454546,       // "FEED"
} as const;

// ---------- PDA seed tags (4 bytes) ----------
export const SEED = {
  DEX_VAULT: Buffer.from("dvlt"),   // [dvlt, dex]           → percolator
  LP_AUTH: Buffer.from("lpau"),     // [lpau, matcherCfg]    → matcher
  ORACLE_AUTH: Buffer.from("orac"), // [orac, adapterCfg]    → oracle_adapter
  REW_AUTH: Buffer.from("rewm"),    // [rewm, rewardCfg]     → reward_module
} as const;

export const STATUS = { ACTIVE: 0, WINDDOWN: 1, RESOLVED: 2, TOMBSTONED: 3 } as const;
export const SIDE = { FLAT: 0, LONG: 1, SHORT: 2 } as const;

// ---------- account sizes ----------
// The DEX keeps its E6 accounting as raw token base units, so collateral must be a
// 6-decimal USD-style token (e.g. USDC); any other decimals silently breaks conservation.
export const COLLATERAL_DECIMALS = 6;
export const DEX_SIZE = 208;
export const MARKET_SIZE = 416; // 9b45ad1: +fundingCfg@400 +premiumEwma@408 (built-in HL/Binance funding)
export const PORTFOLIO_SIZE = 976;
export const INS_RECEIPT_SIZE = 88;
/** @deprecated LEGACY passive-matcher config (pre-PropAMM). The matcher deployed at 887ba02 uses PROP_CTX_SIZE. */
export const MATCHER_CFG_SIZE = 160;
/** PropAMM context account (Matcher.lean:38 `PropOff.size`). Fresh account owned by the matcher program. */
export const PROP_CTX_SIZE = 272;
export const ADAPTER_CFG_SIZE = 352;
export const FEED_SIZE = 32;
export const REWARD_CFG_SIZE = 400;
export const EPOCH_SIZE = 104;
export const BIDDER_SIZE = 120;

// ---------- offsets ----------
export const DexOff = {
  magic: 0, version: 4, vaultBump: 5, decimals: 6, allowFreeze: 7, admin: 8, quoteMint: 40, vaultPda: 72,
  feeVault: 104, nextMarketId: 136, nextPortfolioId: 144, createFee: 152, vaultBalance: 160,
  totalCapital: 168, totalInsurance: 176, totalResidual: 184, totalSurplus: 192, totalRewards: 200,
} as const;

export const MktOff = {
  magic: 0, status: 4, maxFrontBps: 6, marketId: 8, dex: 16, oracleAuth: 48, marketAdmin: 80, markPrice: 112,
  lastOracleSlot: 120, windDownSlot: 128, exitWindow: 136, maxStaleness: 144, warmupSlots: 152, lastRampSlot: 152, // 45648f5: bytes 152..159 = lastRampSlot (legacy warmupSlots name kept)
  imBps: 160, mmBps: 168, liqFeeBps: 176, tradeFeeBps: 184, maxMoveBps: 192, maxInsDrawBps: 200,
  maxOi: 208, realizedPool: 216, insurance: 224, insFronted: 232, totalPosPnl: 240,
  totalInsShares: 248, oiLong: 256, oiShort: 264, rawBasisLong: 272, rawBasisShort: 280,
  adlLong: 288, adlShort: 296, kLong: 304, kShort: 312, resolvedNum: 320, resolvedDen: 328,
  activeLegs: 336, minMm: 344, rewardBps: 352, rewardAccrued: 360, rewardRecipient: 368,
  fundingCfg: 400, premiumEwma: 408, // 9b45ad1
} as const;
/** 9b45ad1 built-in funding: 2^62-biased zero for the signed E6 premium EWMA; funding normalized per 8h. */
export const PREM_ZERO = 1n << 62n;
export const SLOTS_PER_8H = 72_000n;
export const MAX_FUND_8H_BPS = 1_000n;
export const MAX_FUND_DEADBAND_E6 = 50_000n;

export const PflOff = { // a31a1f8: 976B (+totalLockedMm@16; legStride 104 with per-leg lockedMm firewall)
  magic: 0, legCount: 4, portfolioId: 8, totalLockedMm: 16, dex: 24, owner: 56, capital: 88,
  totalMm: 96, totalIm: 104, matcherCtx: 112, headerSize: 144, legStride: 104,
} as const;

export const LegOff = { // a31a1f8: 104B stride (+per-leg lockedMm@96 isolated-MM firewall)
  active: 0, side: 1, marketId: 8, market: 16, rawBasis: 48, entryK: 56, posPnl: 64,
  cachedMm: 72, cachedIm: 80, lastRefreshSlot: 88, lockedMm: 96,
} as const;

/** 55c167f: bytes 4..7 (zero padding before) = lastDepositBucket u32 = (slot >> 4) of the receipt's last share-minting deposit. */
export const InsOff = { magic: 0, lastDepositBucket: 4, marketId: 8, owner: 16, market: 48, shares: 80 } as const;
/** 55c167f (Issue #117): WithdrawInsurance while the market has OI needs insFronted == 0, adlLong == adlShort == ADL_ONE
 *  and curBucket - receipt.lastDepositBucket >= 10 buckets of 16 slots (160 slots). An empty market has no cooldown. */
export const INS_WITHDRAW_COOLDOWN_BUCKETS = 10n;
export const INS_BUCKET_SHIFT = 4n;

/** PropAMM ctx layout (Matcher.lean:31-50). Bytes 0..144 = MatcherReturn header + 8 quote slots (rewritten by every
 *  quote), 144..208 = owner-mutable params, 201 + 208..272 = IMMUTABLE marketId allowlist. */
export const PropOff = {
  magic: 0, status: 4, seq: 8, quotesBase: 16, quoteStride: 16, owner: 144, halfSpreadBps: 176, impactBps: 184,
  maxFillQty: 192, paused: 200, allowedCount: 201, allowedMarkets: 208,
} as const;

/** @deprecated LEGACY 160-byte passive-matcher config layout (pre-PropAMM). */
export const MatcherCfgOff = {
  magic: 0, pdaBump: 4, paused: 5, owner: 8, percProg: 40, lpPortfolio: 72,
  halfSpreadBps: 104, impactBps: 112, maxFillQty: 120, market: 128, // e1e4404: pinned Market (32)
} as const;

// f2b8b11: native Pyth/Chainlink/Switchboard + 2-leg composite.
export const ADAPTER_CFG_SIZE_V2 = 352;
export const FEED_TYPE = { CUSTOM: 0, PYTH_V2: 1, CHAINLINK: 2, SWITCHBOARD: 3 } as const;
export const ADAPTER_FLAG = { HAS_QUOTE: 1, PIN_FID: 2, PIN_QFID: 4, HYBRID_AH: 8 } as const;
export const AdapterOff = {
  magic: 0, pdaBump: 4, feedType: 5, quoteFeedType: 6, flags: 7, admin: 8, percProg: 40,
  market: 72, feedAccount: 104, maxFeedAge: 136, maxConfBps: 144, fundingBpsPerStep: 152,
  feedOwner: 160, feedId: 192, quoteFeed: 224, quoteFeedOwner: 256, quoteFeedId: 288,
  ewmaAlphaBps: 320, ewmaPrice: 328, ewmaMaxDevBps: 336, lastEwmaSlot: 344,
} as const;

export const FeedOff = { magic: 0, price: 8, conf: 16, publishSlot: 24 } as const;

// ---------- opcodes ----------
export const IX = {
  InitDex: 0, UpdateCreateFee: 1, CreateMarket: 2, UpdateMarketAuth: 3, UpdateOracle: 4,
  InitPortfolio: 5, DepositCollateral: 6, WithdrawCollateral: 7, DepositInsurance: 8,
  WithdrawInsurance: 9, RefreshLeg: 10, Trade: 11, Liquidate: 12, ClearDeadLeg: 13,
  StartWindDown: 14, ForceClosePair: 15, ResolveMarket: 16, ClaimResolved: 17,
  TombstoneMarket: 18, CloseAccount: 19, SweepSurplus: 20, ClaimReward: 21, SetPortfolioMatcher: 22, TradeWithMatcher: 23, // Layout.lean IxOp
} as const;
/** @deprecated LEGACY passive-matcher opcodes. At 887ba02 the matcher program is the PropAMM: use PROP_AMM_IX. */
export const MATCHER_IX = { Init: 0, Update: 1, Fill: 2, WithdrawLp: 3 } as const;
/** PropAMM matcher opcodes (Matcher.lean:339-346 dispatch). Quote (2) is the 0-signer CPI entrypoint. */
export const PROP_AMM_IX = { Init: 0, Update: 1, Quote: 2 } as const;
export const ADAPTER_IX = { Init: 0, Crank: 1, InitEwma: 2, PushEwmaMark: 3 } as const;
export const REWARD_IX = { InitReward: 0, StartEpoch: 1, SubmitBid: 2, SettleEpoch: 3, ClaimQuote: 4 } as const;

// ---------- reward module offsets (ee69211) ----------
export const RewOff = {
  magic: 0, pdaBump: 4, burnMode: 5, quoteDecimals: 6, targetDecimals: 7, percProg: 8, dex: 40,
  market: 72, quoteMint: 104, quoteVault: 136, targetMint: 168, targetEscrow: 200, targetTokProg: 232,
  burnSinkTok: 264, activeEpochAcc: 296, epochSlots: 328, minBatchQuote: 336, reserveRateE6: 344,
  activeEpochId: 352, activeQuote: 360, rolloverQuote: 368, pendingClaims: 376, totalQuoteSpent: 384,
  totalTargetBurned: 392,
} as const;
export const EpochOff = {
  magic: 0, settled: 4, cfg: 8, epochId: 40, quotePot: 48, virtBids: 56, totalBids: 64,
  quotePaid: 72, startSlot: 80, endSlot: 88, claimedQuote: 96,
} as const;
/** BidReceipt layout (RewardModule.lean:121-128). */
export const BidOff = { magic: 0, cfg: 8, epochAcc: 40, bidder: 72, epochId: 104, amount: 112 } as const;
export const MAGIC_REWARD = 0x4d574552; // "REWM"
export const MAGIC_EPOCH = 0x48435045;  // "EPCH" (RewardModule.lean:47)
export const MAGIC_BID = 0x52444942;    // "BIDR" (RewardModule.lean:48)
export const MAGIC_CLOSED = 0x44454144; // "DEAD" (Layout.lean:49; stamped on closed accounts incl. claimed BidReceipts)

/** 0 = open/increase, 1 = reduce, 4 = auto-netted buy/sell (reduce + hand-off + open + flip in one). With
 *  TradeWithMatcher use FLIP/NETTED for "just buy/sell qty": OPEN/CLOSE fail (invalidSide/legNotFound) whenever the
 *  LP's current inventory is on the wrong side. Modes 2/3 (position hand-off) are used internally by NETTED and are
 *  rejected by TradeWithMatcher (Program.lean:2236); bilateral `trade` passes its mode byte through unfiltered. */
export const TRADE_MODE = { OPEN: 0, CLOSE: 1, FLIP: 4, NETTED: 4 } as const; // fb67248: mode 4 = atomic position flip (tradeNettedCore)
export const MARKET_AUTH_ROLE = { ADMIN: 0, ORACLE: 1 } as const;

// ---------- custom error codes ----------
export const LEAN_ERRORS: Record<number, string> = {
  100: "invalidMagic", 101: "invalidStatus", 102: "unauthorized", 103: "invalidParams",
  104: "oracleClamp", 105: "oracleNotStale", 106: "oracleStale", 107: "insufficientMargin",
  108: "insufficientFunds", 109: "aliasedAccounts", 110: "marketMismatch", 111: "ownerMismatch",
  112: "mintMismatch", 113: "vaultMismatch", 114: "oiLimitExceeded", 115: "adlHaircutActive",
  116: "positionHealthy", 117: "exitWindowActive", 118: "nonzeroOi", 119: "nonzeroState",
  120: "invalidTokenProg", 121: "invalidSide", 122: "stalePortfolioLeg", 123: "invalidInstruction",
  124: "portfolioFull", 125: "legNotFound", 126: "oracleSameSlot", 127: "dexMismatch",
  128: "invalidVaultState", 129: "invalidSysProg", 130: "execPriceClamp", 131: "invalidMatcher",
  // PropAMM matcher (Matcher.lean:26-29). 200 is also returned while a market is in its 150-slot ramp cooldown.
  // (The legacy passive matcher's 201..206 qtyTooLarge/slippage/... no longer exist: a taker limit-price miss is
  //  core 130 execPriceClamp, and maxFillQty CLAMPS the fill instead of rejecting.)
  200: "matcher.paused", 201: "matcher.marketNotAllowed",
  // oracle adapter (OracleAdapter.lean:59-69)
  300: "adapter.feedStale", 301: "adapter.feedWideConf", 302: "adapter.feedMismatch",
  303: "adapter.progMismatch", 304: "adapter.badFeedFormat", 305: "adapter.badFeedId",
  306: "adapter.ewmaDevExceeded", 307: "adapter.ewmaNotEnabled", 308: "adapter.ewmaSameSlot",
  // reward module (RewardModule.lean:60-74)
  400: "reward.progMismatch", 401: "reward.dexMismatch", 402: "reward.mktMismatch", 403: "reward.mintMismatch",
  404: "reward.sinkMismatch", 405: "reward.epochActive", 406: "reward.badBurnMode", 407: "reward.recipientBad",
  408: "reward.belowMinBatch", 409: "reward.epochClosed", 410: "reward.epochNotEnded", 411: "reward.epochMismatch",
  413: "reward.vaultMismatch",
};

/** Map a custom program error number to its name ("custom:<n>" if unknown). */
export function leanErrorName(code: number): string {
  return LEAN_ERRORS[code] ?? `custom:${code}`;
}
