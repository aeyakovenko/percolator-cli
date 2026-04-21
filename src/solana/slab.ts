import { Connection, PublicKey } from "@solana/web3.js";

// =============================================================================
// Constants — BPF layout (u128/i128 have 8-byte alignment, not 16)
// Source: /home/anatoly/percolator/src/percolator.rs,
//         /home/anatoly/percolator-prog/src/percolator.rs (state mod)
//
// Layout summary:
//   SLAB_LEN      = 1_525_656
//   HEADER_LEN    = 136          (SlabHeader)
//   CONFIG_LEN    = 400          (MarketConfig)
//   ENGINE_OFF    = 536          = align_up(136 + 400, 8)
//   ENGINE_LEN    = 1_492_192    (fixed 17_632 + 4096 * 360)
//   RISK_BUF_OFF  = 2_028_728
//   RISK_BUF_LEN  = 160
//   GEN_TABLE_OFF = 2_028_888
//   GEN_TABLE_LEN = 32_768       (MAX_ACCOUNTS * 8)
//   Total         = 1_525_656    -- wait: engine starts at 536, engine_len=1_492_192
//                                -- so RISK_BUF_OFF = 536 + 1_492_192 = 1_492_728
//                                -- GEN_TABLE_OFF = 1_492_888
//                                -- SLAB_LEN = 1_492_888 + 32_768 = 1_525_656 ✓
// =============================================================================
const MAGIC: bigint = 0x504552434f4c4154n; // "PERCOLAT"
const HEADER_LEN = 136;
const CONFIG_OFFSET = HEADER_LEN;
const CONFIG_LEN = 400;
const RESERVED_OFF = 48;             // nonce at [0..8], mat_counter at [8..16]

// Flag bits in header._padding[0] at offset 13
const FLAG_CPI_IN_PROGRESS = 1 << 2;
const FLAG_ORACLE_INITIALIZED = 1 << 3;

// =============================================================================
// Slab sizes
// =============================================================================
export const SLAB_LEN = 1_525_656;
export { HEADER_LEN, CONFIG_LEN };

/**
 * Slab header (136 bytes).
 * Layout: magic(8) + version(4) + bump(1) + _padding[3] + admin(32)
 *       + _reserved[24] + insurance_authority(32) + close_authority(32)
 */
export interface SlabHeader {
  magic: bigint;
  version: number;
  bump: number;
  flags: number;
  admin: PublicKey;
  nonce: bigint;
  matCounter: bigint;
  insuranceAuthority: PublicKey;
  closeAuthority: PublicKey;
}

export interface MarketConfig {
  collateralMint: PublicKey;
  vaultPubkey: PublicKey;
  indexFeedId: PublicKey;
  maxStalenessSlots: bigint;
  confFilterBps: number;
  vaultAuthorityBump: number;
  invert: number;
  unitScale: number;
  fundingHorizonSlots: bigint;
  fundingKBps: bigint;
  fundingMaxPremiumBps: bigint;     // i64
  fundingMaxE9PerSlot: bigint;     // i64
  oracleAuthority: PublicKey;
  authorityPriceE6: bigint;
  authorityTimestamp: bigint;
  oraclePriceCapE2bps: bigint;
  lastEffectivePriceE6: bigint;
  maxInsuranceFloor: bigint;        // u128
  minOraclePriceCapE2bps: bigint;
  insuranceWithdrawMaxBps: number;
  insuranceWithdrawCooldownSlots: bigint;
  lastHyperpIndexSlot: bigint;
  lastMarkPushSlot: bigint;
  lastInsuranceWithdrawSlot: bigint;
  firstObservedStaleSlot: bigint;
  markEwmaE6: bigint;
  markEwmaLastSlot: bigint;
  markEwmaHalflifeSlots: bigint;
  permissionlessResolveStaleSlots: bigint;
  lastGoodOracleSlot: bigint;
  maintenanceFeePerSlot: bigint;    // u128
  feeSweepCursorWord: bigint;
  feeSweepCursorBit: bigint;
  markMinFee: bigint;
  forceCloseDelaySlots: bigint;
}

/**
 * Fetch raw slab account data.
 */
export async function fetchSlab(
  connection: Connection,
  slabPubkey: PublicKey
): Promise<Buffer> {
  const info = await connection.getAccountInfo(slabPubkey);
  if (!info) {
    throw new Error(`Slab account not found: ${slabPubkey.toBase58()}`);
  }
  return Buffer.from(info.data);
}

/**
 * Parse slab header (first 136 bytes).
 */
export function parseHeader(data: Buffer): SlabHeader {
  if (data.length < HEADER_LEN) {
    throw new Error(`Slab data too short for header: ${data.length} < ${HEADER_LEN}`);
  }

  const magic = data.readBigUInt64LE(0);
  if (magic !== MAGIC) {
    throw new Error(`Invalid slab magic: expected ${MAGIC.toString(16)}, got ${magic.toString(16)}`);
  }

  const version = data.readUInt32LE(8);
  const bump = data.readUInt8(12);
  const flags = data.readUInt8(13);
  const admin = new PublicKey(data.subarray(16, 48));
  const nonce = data.readBigUInt64LE(RESERVED_OFF);
  const matCounter = data.readBigUInt64LE(RESERVED_OFF + 8);
  const insuranceAuthority = new PublicKey(data.subarray(72, 104));
  const closeAuthority = new PublicKey(data.subarray(104, 136));

  return {
    magic, version, bump, flags, admin,
    nonce, matCounter,
    insuranceAuthority, closeAuthority,
  };
}

/**
 * Parse MarketConfig starting at HEADER_LEN.
 */
export function parseConfig(data: Buffer): MarketConfig {
  const minLen = CONFIG_OFFSET + CONFIG_LEN;
  if (data.length < minLen) {
    throw new Error(`Slab data too short for config: ${data.length} < ${minLen}`);
  }

  let off = CONFIG_OFFSET;

  const collateralMint = new PublicKey(data.subarray(off, off + 32));        off += 32;
  const vaultPubkey = new PublicKey(data.subarray(off, off + 32));            off += 32;
  const indexFeedId = new PublicKey(data.subarray(off, off + 32));            off += 32;
  const maxStalenessSlots = data.readBigUInt64LE(off);                        off += 8;
  const confFilterBps = data.readUInt16LE(off);                               off += 2;
  const vaultAuthorityBump = data.readUInt8(off);                             off += 1;
  const invert = data.readUInt8(off);                                         off += 1;
  const unitScale = data.readUInt32LE(off);                                   off += 4;
  const fundingHorizonSlots = data.readBigUInt64LE(off);                      off += 8;
  const fundingKBps = data.readBigUInt64LE(off);                              off += 8;
  const fundingMaxPremiumBps = data.readBigInt64LE(off);                      off += 8;
  const fundingMaxE9PerSlot = data.readBigInt64LE(off);                      off += 8;
  const oracleAuthority = new PublicKey(data.subarray(off, off + 32));        off += 32;
  const authorityPriceE6 = data.readBigUInt64LE(off);                         off += 8;
  const authorityTimestamp = data.readBigInt64LE(off);                        off += 8;
  const oraclePriceCapE2bps = data.readBigUInt64LE(off);                      off += 8;
  const lastEffectivePriceE6 = data.readBigUInt64LE(off);                     off += 8;
  const maxInsuranceFloor = readU128LE(data, off);                            off += 16;
  const minOraclePriceCapE2bps = data.readBigUInt64LE(off);                   off += 8;
  const insuranceWithdrawMaxBps = data.readUInt16LE(off);                     off += 2;
  off += 6; // _iw_padding
  const insuranceWithdrawCooldownSlots = data.readBigUInt64LE(off);           off += 8;
  off += 16; // _iw_padding2 [u64; 2]
  const lastHyperpIndexSlot = data.readBigUInt64LE(off);                      off += 8;
  const lastMarkPushSlot = readU128LE(data, off);                             off += 16;
  const lastInsuranceWithdrawSlot = data.readBigUInt64LE(off);                off += 8;
  const firstObservedStaleSlot = data.readBigUInt64LE(off);                   off += 8;
  const markEwmaE6 = data.readBigUInt64LE(off);                               off += 8;
  const markEwmaLastSlot = data.readBigUInt64LE(off);                         off += 8;
  const markEwmaHalflifeSlots = data.readBigUInt64LE(off);                    off += 8;
  off += 8; // _ewma_padding
  const permissionlessResolveStaleSlots = data.readBigUInt64LE(off);          off += 8;
  const lastGoodOracleSlot = data.readBigUInt64LE(off);                       off += 8;
  const maintenanceFeePerSlot = readU128LE(data, off);                        off += 16;
  const feeSweepCursorWord = data.readBigUInt64LE(off);                       off += 8;
  const feeSweepCursorBit = data.readBigUInt64LE(off);                        off += 8;
  const markMinFee = data.readBigUInt64LE(off);                               off += 8;
  const forceCloseDelaySlots = data.readBigUInt64LE(off);                     // off += 8;

  return {
    collateralMint, vaultPubkey, indexFeedId,
    maxStalenessSlots, confFilterBps, vaultAuthorityBump, invert, unitScale,
    fundingHorizonSlots, fundingKBps, fundingMaxPremiumBps, fundingMaxE9PerSlot,
    oracleAuthority, authorityPriceE6, authorityTimestamp,
    oraclePriceCapE2bps, lastEffectivePriceE6,
    maxInsuranceFloor, minOraclePriceCapE2bps,
    insuranceWithdrawMaxBps, insuranceWithdrawCooldownSlots,
    lastHyperpIndexSlot, lastMarkPushSlot, lastInsuranceWithdrawSlot, firstObservedStaleSlot,
    markEwmaE6, markEwmaLastSlot, markEwmaHalflifeSlots,
    permissionlessResolveStaleSlots, lastGoodOracleSlot,
    maintenanceFeePerSlot, feeSweepCursorWord, feeSweepCursorBit,
    markMinFee, forceCloseDelaySlots,
  };
}

export function readNonce(data: Buffer): bigint {
  if (data.length < RESERVED_OFF + 8) throw new Error("Slab data too short for nonce");
  return data.readBigUInt64LE(RESERVED_OFF);
}

export function readMatCounter(data: Buffer): bigint {
  if (data.length < RESERVED_OFF + 16) throw new Error("Slab data too short for matCounter");
  return data.readBigUInt64LE(RESERVED_OFF + 8);
}

// =============================================================================
// RiskParams Layout (200 bytes, BPF 8-byte alignment)
// =============================================================================
const PARAMS_MAINTENANCE_MARGIN_OFF = 0;
const PARAMS_INITIAL_MARGIN_OFF = 8;
const PARAMS_TRADING_FEE_OFF = 16;
const PARAMS_MAX_ACCOUNTS_OFF = 24;
const PARAMS_MAX_CRANK_STALENESS_OFF = 32;
const PARAMS_LIQUIDATION_FEE_BPS_OFF = 40;
const PARAMS_LIQUIDATION_FEE_CAP_OFF = 48;     // U128
const PARAMS_MIN_LIQUIDATION_OFF = 64;         // U128
const PARAMS_MIN_INITIAL_DEPOSIT_OFF = 80;     // U128
const PARAMS_MIN_NONZERO_MM_REQ_OFF = 96;      // u128
const PARAMS_MIN_NONZERO_IM_REQ_OFF = 112;     // u128
const PARAMS_INSURANCE_FLOOR_OFF = 128;        // U128
const PARAMS_H_MIN_OFF = 144;
const PARAMS_H_MAX_OFF = 152;
const PARAMS_RESOLVE_PRICE_DEVIATION_OFF = 160;
const PARAMS_MAX_ACCRUAL_DT_OFF = 168;
const PARAMS_MAX_ABS_FUNDING_OFF = 176;
const PARAMS_MIN_FUNDING_LIFETIME_OFF = 184;
const PARAMS_MAX_ACTIVE_POSITIONS_OFF = 192;
const PARAMS_SIZE = 200;

// =============================================================================
// Account Layout (360 bytes, BPF)
// =============================================================================
const ACCT_CAPITAL_OFF = 0;
const ACCT_KIND_OFF = 16;
const ACCT_PNL_OFF = 24;
const ACCT_RESERVED_PNL_OFF = 40;
const ACCT_POSITION_BASIS_Q_OFF = 56;
const ACCT_ADL_A_BASIS_OFF = 72;
const ACCT_ADL_K_SNAP_OFF = 88;
const ACCT_F_SNAP_OFF = 104;
const ACCT_ADL_EPOCH_SNAP_OFF = 120;
const ACCT_MATCHER_PROGRAM_OFF = 128;
const ACCT_MATCHER_CONTEXT_OFF = 160;
const ACCT_OWNER_OFF = 192;
const ACCT_FEE_CREDITS_OFF = 224;
const ACCT_LAST_FEE_SLOT_OFF = 240;
const ACCT_SCHED_PRESENT_OFF = 248;
const ACCT_SCHED_REMAINING_Q_OFF = 256;
const ACCT_SCHED_ANCHOR_Q_OFF = 272;
const ACCT_SCHED_START_SLOT_OFF = 288;
const ACCT_SCHED_HORIZON_OFF = 296;
const ACCT_SCHED_RELEASE_Q_OFF = 304;
const ACCT_PENDING_PRESENT_OFF = 320;
const ACCT_PENDING_REMAINING_Q_OFF = 328;
const ACCT_PENDING_HORIZON_OFF = 344;
const ACCT_PENDING_CREATED_SLOT_OFF = 352;

const ACCOUNT_SIZE = 360;

/**
 * Layout table — all fields that depend on MAX_ACCOUNTS.
 *
 * The program can be built with different MAX_ACCOUNTS values:
 *   small  (256)  → SLAB_LEN    96_696   (~0.67 SOL rent)
 *   medium (1024) → SLAB_LEN   381_656
 *   full   (4096) → SLAB_LEN 1_525_656   (~10.6 SOL rent)
 *
 * Everything before the `used` bitmap is MAX_ACCOUNTS-independent
 * (fixed engine prefix ends at 728). Everything after shifts.
 */
export interface SlabLayout {
  maxAccounts: number;
  bitmapWords: number;
  slabLen: number;
  engineOff: number;
  engineNumUsedOff: number;     // within engine
  engineFreeHeadOff: number;
  engineAccountsOff: number;
  accountSize: number;
  paramsSize: number;
}

function computeLayout(maxAccounts: number): SlabLayout {
  const bitmapWords = Math.ceil(maxAccounts / 64);
  // Fixed engine prefix (vault..f_epoch_start_short_num) ends at 728.
  const usedOff = 728;
  const bitmapBytes = bitmapWords * 8;
  const numUsedOff = usedOff + bitmapBytes;
  const freeHeadOff = numUsedOff + 2;
  const nextFreeOff = freeHeadOff + 2;
  const prevFreeOff = nextFreeOff + maxAccounts * 2;
  const afterPrev = prevFreeOff + maxAccounts * 2;
  const accountsOff = (afterPrev + 7) & ~7; // align to 8
  const engineLen = accountsOff + maxAccounts * ACCOUNT_SIZE;
  const engineOff = 536;
  const riskBufLen = 160;
  const genTableLen = maxAccounts * 8;
  const slabLen = engineOff + engineLen + riskBufLen + genTableLen;
  return {
    maxAccounts,
    bitmapWords,
    slabLen,
    engineOff,
    engineNumUsedOff: numUsedOff,
    engineFreeHeadOff: freeHeadOff,
    engineAccountsOff: accountsOff,
    accountSize: ACCOUNT_SIZE,
    paramsSize: 200,
  };
}

/**
 * Select layout based on observed slab account data length.
 * Falls back to full-capacity layout if the length is unknown.
 */
export function layoutForDataLength(dataLen: number): SlabLayout {
  for (const cap of [64, 256, 1024, 4096]) {
    const l = computeLayout(cap);
    if (l.slabLen === dataLen) return l;
  }
  return computeLayout(4096);
}

// Full-capacity layout used by default — matches production devnet program.
const DEFAULT_LAYOUT = computeLayout(4096);
const MAX_ACCOUNTS = DEFAULT_LAYOUT.maxAccounts;
const BITMAP_WORDS = DEFAULT_LAYOUT.bitmapWords;

// =============================================================================
// RiskEngine Layout (BPF, 8-byte u128/i128 alignment). ENGINE_OFF = 536.
// All offsets below are RELATIVE to ENGINE_OFF.
// =============================================================================
const ENGINE_OFF = 536;

const ENGINE_VAULT_OFF = 0;                           // U128
const ENGINE_INSURANCE_OFF = 16;                      // InsuranceFund { U128 }
const ENGINE_PARAMS_OFF = 32;                         // RiskParams (200)
const ENGINE_CURRENT_SLOT_OFF = 232;                  // u64
const ENGINE_MARKET_MODE_OFF = 240;                   // u8
const ENGINE_RESOLVED_PRICE_OFF = 248;                // u64
const ENGINE_RESOLVED_SLOT_OFF = 256;                 // u64
const ENGINE_RESOLVED_PAYOUT_H_NUM_OFF = 264;         // u128
const ENGINE_RESOLVED_PAYOUT_H_DEN_OFF = 280;         // u128
const ENGINE_RESOLVED_PAYOUT_READY_OFF = 296;         // u8
const ENGINE_RESOLVED_K_LONG_TERMINAL_OFF = 304;      // i128
const ENGINE_RESOLVED_K_SHORT_TERMINAL_OFF = 320;     // i128
const ENGINE_RESOLVED_LIVE_PRICE_OFF = 336;           // u64
const ENGINE_LAST_CRANK_SLOT_OFF = 344;               // u64
const ENGINE_C_TOT_OFF = 352;                         // U128
const ENGINE_PNL_POS_TOT_OFF = 368;                   // u128
const ENGINE_PNL_MATURED_POS_TOT_OFF = 384;           // u128
const ENGINE_GC_CURSOR_OFF = 400;                     // u16
const ENGINE_ADL_MULT_LONG_OFF = 408;                 // u128
const ENGINE_ADL_MULT_SHORT_OFF = 424;                // u128
const ENGINE_ADL_COEFF_LONG_OFF = 440;                // i128
const ENGINE_ADL_COEFF_SHORT_OFF = 456;               // i128
const ENGINE_ADL_EPOCH_LONG_OFF = 472;                // u64
const ENGINE_ADL_EPOCH_SHORT_OFF = 480;               // u64
const ENGINE_ADL_EPOCH_START_K_LONG_OFF = 488;        // i128
const ENGINE_ADL_EPOCH_START_K_SHORT_OFF = 504;       // i128
const ENGINE_OI_EFF_LONG_Q_OFF = 520;                 // u128
const ENGINE_OI_EFF_SHORT_Q_OFF = 536;                // u128
const ENGINE_SIDE_MODE_LONG_OFF = 552;                // u8
const ENGINE_SIDE_MODE_SHORT_OFF = 553;               // u8
const ENGINE_STORED_POS_COUNT_LONG_OFF = 560;         // u64
const ENGINE_STORED_POS_COUNT_SHORT_OFF = 568;        // u64
const ENGINE_STALE_ACCOUNT_COUNT_LONG_OFF = 576;      // u64
const ENGINE_STALE_ACCOUNT_COUNT_SHORT_OFF = 584;     // u64
const ENGINE_PHANTOM_DUST_LONG_OFF = 592;             // u128
const ENGINE_PHANTOM_DUST_SHORT_OFF = 608;            // u128
const ENGINE_MATERIALIZED_ACCOUNT_COUNT_OFF = 624;    // u64
const ENGINE_NEG_PNL_ACCOUNT_COUNT_OFF = 632;         // u64
const ENGINE_LAST_ORACLE_PRICE_OFF = 640;             // u64
const ENGINE_FUND_PX_LAST_OFF = 648;                  // u64
const ENGINE_LAST_MARKET_SLOT_OFF = 656;              // u64
const ENGINE_F_LONG_NUM_OFF = 664;                    // i128
const ENGINE_F_SHORT_NUM_OFF = 680;                   // i128
const ENGINE_F_EPOCH_START_LONG_NUM_OFF = 696;        // i128
const ENGINE_F_EPOCH_START_SHORT_NUM_OFF = 712;       // i128
const ENGINE_BITMAP_OFF = 728;                        // bitmap start — MA-independent
// num_used_off, free_head_off, accounts_off are MA-dependent (see SlabLayout).
// For full capacity (MA=4096): num_used=1240, free_head=1242, accounts=17632.

// =============================================================================
// Interfaces
// =============================================================================

export interface InsuranceFund {
  balance: bigint;
}

export interface RiskParams {
  maintenanceMarginBps: bigint;
  initialMarginBps: bigint;
  tradingFeeBps: bigint;
  maxAccounts: bigint;
  maxCrankStalenessSlots: bigint;
  liquidationFeeBps: bigint;
  liquidationFeeCap: bigint;
  minLiquidationAbs: bigint;
  minInitialDeposit: bigint;
  minNonzeroMmReq: bigint;
  minNonzeroImReq: bigint;
  insuranceFloor: bigint;
  hMin: bigint;
  hMax: bigint;
  resolvePriceDeviationBps: bigint;
  maxAccrualDtSlots: bigint;
  maxAbsFundingE9PerSlot: bigint;
  minFundingLifetimeSlots: bigint;
  maxActivePositionsPerSide: bigint;
}

export enum SideMode {
  Normal = 0,
  DrainOnly = 1,
  ResetPending = 2,
}

export enum MarketMode {
  Live = 0,
  Resolved = 1,
}

export interface EngineState {
  vault: bigint;
  insuranceFund: InsuranceFund;
  currentSlot: bigint;
  marketMode: MarketMode;
  resolvedPrice: bigint;
  resolvedSlot: bigint;
  resolvedPayoutHNum: bigint;
  resolvedPayoutHDen: bigint;
  resolvedPayoutReady: number;
  resolvedKLongTerminalDelta: bigint;
  resolvedKShortTerminalDelta: bigint;
  resolvedLivePrice: bigint;
  lastCrankSlot: bigint;
  cTot: bigint;
  pnlPosTot: bigint;
  pnlMaturedPosTot: bigint;
  gcCursor: number;
  adlMultLong: bigint;
  adlMultShort: bigint;
  adlCoeffLong: bigint;
  adlCoeffShort: bigint;
  adlEpochLong: bigint;
  adlEpochShort: bigint;
  adlEpochStartKLong: bigint;
  adlEpochStartKShort: bigint;
  oiEffLongQ: bigint;
  oiEffShortQ: bigint;
  sideModeLong: SideMode;
  sideModeShort: SideMode;
  storedPosCountLong: bigint;
  storedPosCountShort: bigint;
  staleAccountCountLong: bigint;
  staleAccountCountShort: bigint;
  phantomDustBoundLongQ: bigint;
  phantomDustBoundShortQ: bigint;
  materializedAccountCount: bigint;
  negPnlAccountCount: bigint;
  lastOraclePrice: bigint;
  fundPxLast: bigint;
  lastMarketSlot: bigint;
  fLongNum: bigint;
  fShortNum: bigint;
  fEpochStartLongNum: bigint;
  fEpochStartShortNum: bigint;
  numUsedAccounts: number;
  freeHead: number;
}

export enum AccountKind {
  User = 0,
  LP = 1,
}

export interface Account {
  kind: AccountKind;
  capital: bigint;
  pnl: bigint;
  reservedPnl: bigint;
  positionBasisQ: bigint;
  adlABasis: bigint;
  adlKSnap: bigint;
  fSnap: bigint;
  adlEpochSnap: bigint;
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
  owner: PublicKey;
  feeCredits: bigint;
  lastFeeSlot: bigint;
  schedPresent: number;
  schedRemainingQ: bigint;
  schedAnchorQ: bigint;
  schedStartSlot: bigint;
  schedHorizon: bigint;
  schedReleaseQ: bigint;
  pendingPresent: number;
  pendingRemainingQ: bigint;
  pendingHorizon: bigint;
  pendingCreatedSlot: bigint;
}

// =============================================================================
// Signed / unsigned 128-bit readers
// =============================================================================
function readI128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  const unsigned = (hi << 64n) | lo;
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) return unsigned - (1n << 128n);
  return unsigned;
}

function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

// =============================================================================
// Parsing Functions
// =============================================================================

export function parseParams(data: Buffer): RiskParams {
  const base = ENGINE_OFF + ENGINE_PARAMS_OFF;
  if (data.length < base + PARAMS_SIZE) throw new Error("Slab data too short for RiskParams");

  return {
    maintenanceMarginBps: data.readBigUInt64LE(base + PARAMS_MAINTENANCE_MARGIN_OFF),
    initialMarginBps: data.readBigUInt64LE(base + PARAMS_INITIAL_MARGIN_OFF),
    tradingFeeBps: data.readBigUInt64LE(base + PARAMS_TRADING_FEE_OFF),
    maxAccounts: data.readBigUInt64LE(base + PARAMS_MAX_ACCOUNTS_OFF),
    maxCrankStalenessSlots: data.readBigUInt64LE(base + PARAMS_MAX_CRANK_STALENESS_OFF),
    liquidationFeeBps: data.readBigUInt64LE(base + PARAMS_LIQUIDATION_FEE_BPS_OFF),
    liquidationFeeCap: readU128LE(data, base + PARAMS_LIQUIDATION_FEE_CAP_OFF),
    minLiquidationAbs: readU128LE(data, base + PARAMS_MIN_LIQUIDATION_OFF),
    minInitialDeposit: readU128LE(data, base + PARAMS_MIN_INITIAL_DEPOSIT_OFF),
    minNonzeroMmReq: readU128LE(data, base + PARAMS_MIN_NONZERO_MM_REQ_OFF),
    minNonzeroImReq: readU128LE(data, base + PARAMS_MIN_NONZERO_IM_REQ_OFF),
    insuranceFloor: readU128LE(data, base + PARAMS_INSURANCE_FLOOR_OFF),
    hMin: data.readBigUInt64LE(base + PARAMS_H_MIN_OFF),
    hMax: data.readBigUInt64LE(base + PARAMS_H_MAX_OFF),
    resolvePriceDeviationBps: data.readBigUInt64LE(base + PARAMS_RESOLVE_PRICE_DEVIATION_OFF),
    maxAccrualDtSlots: data.readBigUInt64LE(base + PARAMS_MAX_ACCRUAL_DT_OFF),
    maxAbsFundingE9PerSlot: data.readBigUInt64LE(base + PARAMS_MAX_ABS_FUNDING_OFF),
    minFundingLifetimeSlots: data.readBigUInt64LE(base + PARAMS_MIN_FUNDING_LIFETIME_OFF),
    maxActivePositionsPerSide: data.readBigUInt64LE(base + PARAMS_MAX_ACTIVE_POSITIONS_OFF),
  };
}

export function parseEngine(data: Buffer): EngineState {
  const layout = layoutForDataLength(data.length);
  const base = ENGINE_OFF;
  if (data.length < base + layout.engineAccountsOff) throw new Error("Slab data too short for RiskEngine");

  return {
    vault: readU128LE(data, base + ENGINE_VAULT_OFF),
    insuranceFund: { balance: readU128LE(data, base + ENGINE_INSURANCE_OFF) },
    currentSlot: data.readBigUInt64LE(base + ENGINE_CURRENT_SLOT_OFF),
    marketMode: data.readUInt8(base + ENGINE_MARKET_MODE_OFF) as MarketMode,
    resolvedPrice: data.readBigUInt64LE(base + ENGINE_RESOLVED_PRICE_OFF),
    resolvedSlot: data.readBigUInt64LE(base + ENGINE_RESOLVED_SLOT_OFF),
    resolvedPayoutHNum: readU128LE(data, base + ENGINE_RESOLVED_PAYOUT_H_NUM_OFF),
    resolvedPayoutHDen: readU128LE(data, base + ENGINE_RESOLVED_PAYOUT_H_DEN_OFF),
    resolvedPayoutReady: data.readUInt8(base + ENGINE_RESOLVED_PAYOUT_READY_OFF),
    resolvedKLongTerminalDelta: readI128LE(data, base + ENGINE_RESOLVED_K_LONG_TERMINAL_OFF),
    resolvedKShortTerminalDelta: readI128LE(data, base + ENGINE_RESOLVED_K_SHORT_TERMINAL_OFF),
    resolvedLivePrice: data.readBigUInt64LE(base + ENGINE_RESOLVED_LIVE_PRICE_OFF),
    lastCrankSlot: data.readBigUInt64LE(base + ENGINE_LAST_CRANK_SLOT_OFF),
    cTot: readU128LE(data, base + ENGINE_C_TOT_OFF),
    pnlPosTot: readU128LE(data, base + ENGINE_PNL_POS_TOT_OFF),
    pnlMaturedPosTot: readU128LE(data, base + ENGINE_PNL_MATURED_POS_TOT_OFF),
    gcCursor: data.readUInt16LE(base + ENGINE_GC_CURSOR_OFF),
    adlMultLong: readU128LE(data, base + ENGINE_ADL_MULT_LONG_OFF),
    adlMultShort: readU128LE(data, base + ENGINE_ADL_MULT_SHORT_OFF),
    adlCoeffLong: readI128LE(data, base + ENGINE_ADL_COEFF_LONG_OFF),
    adlCoeffShort: readI128LE(data, base + ENGINE_ADL_COEFF_SHORT_OFF),
    adlEpochLong: data.readBigUInt64LE(base + ENGINE_ADL_EPOCH_LONG_OFF),
    adlEpochShort: data.readBigUInt64LE(base + ENGINE_ADL_EPOCH_SHORT_OFF),
    adlEpochStartKLong: readI128LE(data, base + ENGINE_ADL_EPOCH_START_K_LONG_OFF),
    adlEpochStartKShort: readI128LE(data, base + ENGINE_ADL_EPOCH_START_K_SHORT_OFF),
    oiEffLongQ: readU128LE(data, base + ENGINE_OI_EFF_LONG_Q_OFF),
    oiEffShortQ: readU128LE(data, base + ENGINE_OI_EFF_SHORT_Q_OFF),
    sideModeLong: data.readUInt8(base + ENGINE_SIDE_MODE_LONG_OFF) as SideMode,
    sideModeShort: data.readUInt8(base + ENGINE_SIDE_MODE_SHORT_OFF) as SideMode,
    storedPosCountLong: data.readBigUInt64LE(base + ENGINE_STORED_POS_COUNT_LONG_OFF),
    storedPosCountShort: data.readBigUInt64LE(base + ENGINE_STORED_POS_COUNT_SHORT_OFF),
    staleAccountCountLong: data.readBigUInt64LE(base + ENGINE_STALE_ACCOUNT_COUNT_LONG_OFF),
    staleAccountCountShort: data.readBigUInt64LE(base + ENGINE_STALE_ACCOUNT_COUNT_SHORT_OFF),
    phantomDustBoundLongQ: readU128LE(data, base + ENGINE_PHANTOM_DUST_LONG_OFF),
    phantomDustBoundShortQ: readU128LE(data, base + ENGINE_PHANTOM_DUST_SHORT_OFF),
    materializedAccountCount: data.readBigUInt64LE(base + ENGINE_MATERIALIZED_ACCOUNT_COUNT_OFF),
    negPnlAccountCount: data.readBigUInt64LE(base + ENGINE_NEG_PNL_ACCOUNT_COUNT_OFF),
    lastOraclePrice: data.readBigUInt64LE(base + ENGINE_LAST_ORACLE_PRICE_OFF),
    fundPxLast: data.readBigUInt64LE(base + ENGINE_FUND_PX_LAST_OFF),
    lastMarketSlot: data.readBigUInt64LE(base + ENGINE_LAST_MARKET_SLOT_OFF),
    fLongNum: readI128LE(data, base + ENGINE_F_LONG_NUM_OFF),
    fShortNum: readI128LE(data, base + ENGINE_F_SHORT_NUM_OFF),
    fEpochStartLongNum: readI128LE(data, base + ENGINE_F_EPOCH_START_LONG_NUM_OFF),
    fEpochStartShortNum: readI128LE(data, base + ENGINE_F_EPOCH_START_SHORT_NUM_OFF),
    numUsedAccounts: data.readUInt16LE(base + layout.engineNumUsedOff),
    freeHead: data.readUInt16LE(base + layout.engineFreeHeadOff),
  };
}

export function parseUsedIndices(data: Buffer): number[] {
  const layout = layoutForDataLength(data.length);
  const base = ENGINE_OFF + ENGINE_BITMAP_OFF;
  if (data.length < base + layout.bitmapWords * 8) throw new Error("Slab data too short for bitmap");

  const used: number[] = [];
  for (let word = 0; word < layout.bitmapWords; word++) {
    const bits = data.readBigUInt64LE(base + word * 8);
    if (bits === 0n) continue;
    for (let bit = 0; bit < 64; bit++) {
      if ((bits >> BigInt(bit)) & 1n) used.push(word * 64 + bit);
    }
  }
  return used;
}

export function isAccountUsed(data: Buffer, idx: number): boolean {
  const layout = layoutForDataLength(data.length);
  if (idx < 0 || idx >= layout.maxAccounts) return false;
  const base = ENGINE_OFF + ENGINE_BITMAP_OFF;
  const word = Math.floor(idx / 64);
  const bit = idx % 64;
  const bits = data.readBigUInt64LE(base + word * 8);
  return ((bits >> BigInt(bit)) & 1n) !== 0n;
}

export function maxAccountIndex(dataLen: number): number {
  const layout = layoutForDataLength(dataLen);
  return layout.maxAccounts;
}

export function parseAccount(data: Buffer, idx: number): Account {
  const layout = layoutForDataLength(data.length);
  if (idx < 0 || idx >= layout.maxAccounts) {
    throw new Error(`Account index out of range: ${idx} (max: ${layout.maxAccounts - 1})`);
  }

  const base = ENGINE_OFF + layout.engineAccountsOff + idx * ACCOUNT_SIZE;
  if (data.length < base + ACCOUNT_SIZE) throw new Error("Slab data too short for account");

  const kindByte = data.readUInt8(base + ACCT_KIND_OFF);
  const kind = kindByte === 1 ? AccountKind.LP : AccountKind.User;

  return {
    kind,
    capital: readU128LE(data, base + ACCT_CAPITAL_OFF),
    pnl: readI128LE(data, base + ACCT_PNL_OFF),
    reservedPnl: readU128LE(data, base + ACCT_RESERVED_PNL_OFF),
    positionBasisQ: readI128LE(data, base + ACCT_POSITION_BASIS_Q_OFF),
    adlABasis: readU128LE(data, base + ACCT_ADL_A_BASIS_OFF),
    adlKSnap: readI128LE(data, base + ACCT_ADL_K_SNAP_OFF),
    fSnap: readI128LE(data, base + ACCT_F_SNAP_OFF),
    adlEpochSnap: data.readBigUInt64LE(base + ACCT_ADL_EPOCH_SNAP_OFF),
    matcherProgram: new PublicKey(data.subarray(base + ACCT_MATCHER_PROGRAM_OFF, base + ACCT_MATCHER_PROGRAM_OFF + 32)),
    matcherContext: new PublicKey(data.subarray(base + ACCT_MATCHER_CONTEXT_OFF, base + ACCT_MATCHER_CONTEXT_OFF + 32)),
    owner: new PublicKey(data.subarray(base + ACCT_OWNER_OFF, base + ACCT_OWNER_OFF + 32)),
    feeCredits: readI128LE(data, base + ACCT_FEE_CREDITS_OFF),
    lastFeeSlot: data.readBigUInt64LE(base + ACCT_LAST_FEE_SLOT_OFF),
    schedPresent: data.readUInt8(base + ACCT_SCHED_PRESENT_OFF),
    schedRemainingQ: readU128LE(data, base + ACCT_SCHED_REMAINING_Q_OFF),
    schedAnchorQ: readU128LE(data, base + ACCT_SCHED_ANCHOR_Q_OFF),
    schedStartSlot: data.readBigUInt64LE(base + ACCT_SCHED_START_SLOT_OFF),
    schedHorizon: data.readBigUInt64LE(base + ACCT_SCHED_HORIZON_OFF),
    schedReleaseQ: readU128LE(data, base + ACCT_SCHED_RELEASE_Q_OFF),
    pendingPresent: data.readUInt8(base + ACCT_PENDING_PRESENT_OFF),
    pendingRemainingQ: readU128LE(data, base + ACCT_PENDING_REMAINING_Q_OFF),
    pendingHorizon: data.readBigUInt64LE(base + ACCT_PENDING_HORIZON_OFF),
    pendingCreatedSlot: data.readBigUInt64LE(base + ACCT_PENDING_CREATED_SLOT_OFF),
  };
}

export function parseAllAccounts(data: Buffer): { idx: number; account: Account }[] {
  const indices = parseUsedIndices(data);
  const maxIdx = maxAccountIndex(data.length);
  const validIndices = indices.filter(idx => idx < maxIdx);
  return validIndices.map(idx => ({ idx, account: parseAccount(data, idx) }));
}
