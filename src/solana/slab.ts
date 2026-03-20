import { Connection, PublicKey } from "@solana/web3.js";

// Constants from Rust (updated for ADL refactor 2026-03)
const MAGIC: bigint = 0x504552434f4c4154n; // "PERCOLAT"
const HEADER_LEN = 72;    // SlabHeader: magic(8) + version(4) + bump(1) + _padding(3) + admin(32) + _reserved(24)
const CONFIG_OFFSET = HEADER_LEN;  // MarketConfig starts right after header
// MarketConfig: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32) + max_staleness_secs(8) +
//               conf_filter_bps(2) + bump(1) + invert(1) + unit_scale(4) +
//               funding_horizon_slots(8) + funding_k_bps(8) + funding_inv_scale_notional_e6(16) +
//               funding_max_premium_bps(8) + funding_max_bps_per_slot(8) +
//               thresh_floor(16) + thresh_risk_bps(8) + thresh_update_interval_slots(8) +
//               thresh_step_bps(8) + thresh_alpha_bps(8) + thresh_min(16) + thresh_max(16) + thresh_min_step(16) +
//               oracle_authority(32) + authority_price_e6(8) + authority_timestamp(8) +
//               oracle_price_cap_e2bps(8) + last_effective_price_e6(8) +
//               max_maintenance_fee_per_slot(16) + max_insurance_floor(16) +
//               min_oracle_price_cap_e2bps(8) + _limits_reserved(8)
const CONFIG_LEN = 368;
const RESERVED_OFF = 48;  // Offset of _reserved field within SlabHeader

// Flag bits in header._padding[0] at offset 13
const FLAG_RESOLVED = 1 << 0;

/**
 * Slab header (72 bytes)
 */
export interface SlabHeader {
  magic: bigint;
  version: number;
  bump: number;
  flags: number;
  resolved: boolean;
  admin: PublicKey;
  nonce: bigint;
  lastThrUpdateSlot: bigint;
}

/**
 * Market config (starts at offset 72)
 * Layout: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32)
 *         + max_staleness_secs(8) + conf_filter_bps(2) + vault_authority_bump(1) + invert(1) + unit_scale(4)
 */
export interface MarketConfig {
  collateralMint: PublicKey;
  vaultPubkey: PublicKey;
  indexFeedId: PublicKey;       // index_feed_id (Pyth feed ID stored as 32 bytes)
  maxStalenessSlots: bigint;    // max_staleness_secs
  confFilterBps: number;
  vaultAuthorityBump: number;
  invert: number;               // 0 = no inversion, 1 = invert oracle price
  unitScale: number;            // Lamports per unit (0 = no scaling)
  // Funding rate parameters
  fundingHorizonSlots: bigint;
  fundingKBps: bigint;
  fundingInvScaleNotionalE6: bigint;
  fundingMaxPremiumBps: bigint;
  fundingMaxBpsPerSlot: bigint;
  // Threshold parameters
  threshFloor: bigint;
  threshRiskBps: bigint;
  threshUpdateIntervalSlots: bigint;
  threshStepBps: bigint;
  threshAlphaBps: bigint;
  threshMin: bigint;
  threshMax: bigint;
  threshMinStep: bigint;
  // Oracle authority
  oracleAuthority: PublicKey;
  authorityPriceE6: bigint;
  authorityTimestamp: bigint;
  // Oracle price circuit breaker
  oraclePriceCapE2bps: bigint;
  lastEffectivePriceE6: bigint;
  // Per-market admin limits (immutable after init)
  maxMaintenanceFeePerSlot: bigint;
  maxInsuranceFloor: bigint;
  minOraclePriceCapE2bps: bigint;
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
 * Parse slab header (first 64 bytes).
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
  const flags = data.readUInt8(13);  // _padding[0] contains flags
  const admin = new PublicKey(data.subarray(16, 48));

  // Reserved field: nonce at [0..8], lastThrUpdateSlot at [8..16]
  const nonce = data.readBigUInt64LE(RESERVED_OFF);
  const lastThrUpdateSlot = data.readBigUInt64LE(RESERVED_OFF + 8);

  return {
    magic,
    version,
    bump,
    flags,
    resolved: (flags & FLAG_RESOLVED) !== 0,
    admin,
    nonce,
    lastThrUpdateSlot,
  };
}

/**
 * Parse market config (starts at byte 72).
 * Layout: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32)
 *         + max_staleness_secs(8) + conf_filter_bps(2) + vault_authority_bump(1) + invert(1) + unit_scale(4)
 */
export function parseConfig(data: Buffer): MarketConfig {
  const minLen = CONFIG_OFFSET + CONFIG_LEN;
  if (data.length < minLen) {
    throw new Error(`Slab data too short for config: ${data.length} < ${minLen}`);
  }

  let off = CONFIG_OFFSET;

  const collateralMint = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const vaultPubkey = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  // index_feed_id (32 bytes) - Pyth feed ID, stored as 32 bytes
  const indexFeedId = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const maxStalenessSlots = data.readBigUInt64LE(off);
  off += 8;

  const confFilterBps = data.readUInt16LE(off);
  off += 2;

  const vaultAuthorityBump = data.readUInt8(off);
  off += 1;

  const invert = data.readUInt8(off);
  off += 1;

  const unitScale = data.readUInt32LE(off);
  off += 4;

  // Funding rate parameters
  const fundingHorizonSlots = data.readBigUInt64LE(off);
  off += 8;

  const fundingKBps = data.readBigUInt64LE(off);
  off += 8;

  const fundingInvScaleNotionalE6 = readI128LE(data, off);
  off += 16;

  const fundingMaxPremiumBps = data.readBigUInt64LE(off);
  off += 8;

  const fundingMaxBpsPerSlot = data.readBigUInt64LE(off);
  off += 8;

  // Threshold parameters
  const threshFloor = readU128LE(data, off);
  off += 16;

  const threshRiskBps = data.readBigUInt64LE(off);
  off += 8;

  const threshUpdateIntervalSlots = data.readBigUInt64LE(off);
  off += 8;

  const threshStepBps = data.readBigUInt64LE(off);
  off += 8;

  const threshAlphaBps = data.readBigUInt64LE(off);
  off += 8;

  const threshMin = readU128LE(data, off);
  off += 16;

  const threshMax = readU128LE(data, off);
  off += 16;

  const threshMinStep = readU128LE(data, off);
  off += 16;

  // Oracle authority fields
  const oracleAuthority = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const authorityPriceE6 = data.readBigUInt64LE(off);
  off += 8;

  const authorityTimestamp = data.readBigInt64LE(off);
  off += 8;

  // Oracle price circuit breaker
  const oraclePriceCapE2bps = data.readBigUInt64LE(off);
  off += 8;

  const lastEffectivePriceE6 = data.readBigUInt64LE(off);
  off += 8;

  // Per-market admin limits
  const maxMaintenanceFeePerSlot = readU128LE(data, off);
  off += 16;

  const maxInsuranceFloor = readU128LE(data, off);
  off += 16;

  const minOraclePriceCapE2bps = data.readBigUInt64LE(off);
  // off += 8; // _limits_reserved follows but we don't parse it

  return {
    collateralMint,
    vaultPubkey,
    indexFeedId,
    maxStalenessSlots,
    confFilterBps,
    vaultAuthorityBump,
    invert,
    unitScale,
    fundingHorizonSlots,
    fundingKBps,
    fundingInvScaleNotionalE6,
    fundingMaxPremiumBps,
    fundingMaxBpsPerSlot,
    threshFloor,
    threshRiskBps,
    threshUpdateIntervalSlots,
    threshStepBps,
    threshAlphaBps,
    threshMin,
    threshMax,
    threshMinStep,
    oracleAuthority,
    authorityPriceE6,
    authorityTimestamp,
    oraclePriceCapE2bps,
    lastEffectivePriceE6,
    maxMaintenanceFeePerSlot,
    maxInsuranceFloor,
    minOraclePriceCapE2bps,
  };
}

/**
 * Read nonce from slab header reserved field.
 */
export function readNonce(data: Buffer): bigint {
  if (data.length < RESERVED_OFF + 8) {
    throw new Error("Slab data too short for nonce");
  }
  return data.readBigUInt64LE(RESERVED_OFF);
}

/**
 * Read last threshold update slot from slab header reserved field.
 */
export function readLastThrUpdateSlot(data: Buffer): bigint {
  if (data.length < RESERVED_OFF + 16) {
    throw new Error("Slab data too short for lastThrUpdateSlot");
  }
  return data.readBigUInt64LE(RESERVED_OFF + 8);
}

// =============================================================================
// RiskParams Layout (176 bytes, repr(C) with 8-byte alignment on SBF)
// Note: SBF target uses 8-byte alignment for u128, not 16-byte
//
// Fields:
//   warmup_period_slots: u64         @   0  (8 bytes)
//   maintenance_margin_bps: u64      @   8  (8 bytes)
//   initial_margin_bps: u64          @  16  (8 bytes)
//   trading_fee_bps: u64             @  24  (8 bytes)
//   max_accounts: u64                @  32  (8 bytes)
//   new_account_fee: U128            @  40  (16 bytes)
//   maintenance_fee_per_slot: U128   @  56  (16 bytes)
//   max_crank_staleness_slots: u64   @  72  (8 bytes)
//   liquidation_fee_bps: u64         @  80  (8 bytes)
//   liquidation_fee_cap: U128        @  88  (16 bytes)
//   liquidation_buffer_bps: u64      @ 104  (8 bytes)
//   min_liquidation_abs: U128        @ 112  (16 bytes)
//   min_initial_deposit: U128        @ 128  (16 bytes)
//   min_nonzero_mm_req: u128         @ 144  (16 bytes)
//   min_nonzero_im_req: u128         @ 160  (16 bytes)
// Total: 176 bytes
// =============================================================================
const PARAMS_WARMUP_PERIOD_OFF = 0;             // u64
const PARAMS_MAINTENANCE_MARGIN_OFF = 8;        // u64
const PARAMS_INITIAL_MARGIN_OFF = 16;           // u64
const PARAMS_TRADING_FEE_OFF = 24;              // u64
const PARAMS_MAX_ACCOUNTS_OFF = 32;             // u64
const PARAMS_NEW_ACCOUNT_FEE_OFF = 40;          // U128 (16 bytes)
const PARAMS_MAINTENANCE_FEE_OFF = 56;          // U128 (16 bytes)
const PARAMS_MAX_CRANK_STALENESS_OFF = 72;      // u64
const PARAMS_LIQUIDATION_FEE_BPS_OFF = 80;      // u64
const PARAMS_LIQUIDATION_FEE_CAP_OFF = 88;      // U128 (16 bytes)
const PARAMS_LIQUIDATION_BUFFER_OFF = 104;      // u64
const PARAMS_MIN_LIQUIDATION_OFF = 112;         // U128 (16 bytes)
const PARAMS_MIN_INITIAL_DEPOSIT_OFF = 128;     // U128 (16 bytes)
const PARAMS_MIN_NONZERO_MM_REQ_OFF = 144;      // u128 (16 bytes)
const PARAMS_MIN_NONZERO_IM_REQ_OFF = 160;      // u128 (16 bytes)
const PARAMS_SIZE = 176;

// =============================================================================
// Account Layout (280 bytes, repr(C), SBF 8-byte alignment)
//
// Fields:
//   account_id: u64              @   0  (8 bytes)
//   capital: U128                @   8  (16 bytes)
//   kind: u8                     @  24  (1 byte + 7 padding to align i128@8)
//   pnl: i128                    @  32  (16 bytes)
//   reserved_pnl: u128           @  48  (16 bytes)
//   warmup_started_at_slot: u64  @  64  (8 bytes)
//   warmup_slope_per_step: u128  @  72  (16 bytes)
//   position_basis_q: i128       @  88  (16 bytes)
//   adl_a_basis: u128            @ 104  (16 bytes)
//   adl_k_snap: i128             @ 120  (16 bytes)
//   adl_epoch_snap: u64          @ 136  (8 bytes)
//   matcher_program: [u8;32]     @ 144  (32 bytes)
//   matcher_context: [u8;32]     @ 176  (32 bytes)
//   owner: [u8;32]               @ 208  (32 bytes)
//   fee_credits: I128            @ 240  (16 bytes)
//   last_fee_slot: u64           @ 256  (8 bytes)
//   fees_earned_total: U128      @ 264  (16 bytes)
// Total: 280 bytes
// =============================================================================
const ACCT_ACCOUNT_ID_OFF = 0;            // u64 (8 bytes)
const ACCT_CAPITAL_OFF = 8;               // U128 (16 bytes)
const ACCT_KIND_OFF = 24;                 // u8 (1 byte + 7 padding)
const ACCT_PNL_OFF = 32;                  // i128 (16 bytes)
const ACCT_RESERVED_PNL_OFF = 48;         // u128 (16 bytes) - was u64, now u128
const ACCT_WARMUP_STARTED_OFF = 64;       // u64 (8 bytes)
const ACCT_WARMUP_SLOPE_OFF = 72;         // u128 (16 bytes)
const ACCT_POSITION_BASIS_Q_OFF = 88;     // i128 (16 bytes) - was position_size
const ACCT_ADL_A_BASIS_OFF = 104;         // u128 (16 bytes) - replaces entry_price
const ACCT_ADL_K_SNAP_OFF = 120;          // i128 (16 bytes) - replaces funding_index
const ACCT_ADL_EPOCH_SNAP_OFF = 136;      // u64 (8 bytes) - NEW
const ACCT_MATCHER_PROGRAM_OFF = 144;     // [u8;32] (32 bytes)
const ACCT_MATCHER_CONTEXT_OFF = 176;     // [u8;32] (32 bytes)
const ACCT_OWNER_OFF = 208;               // [u8;32] (32 bytes)
const ACCT_FEE_CREDITS_OFF = 240;         // I128 (16 bytes)
const ACCT_LAST_FEE_SLOT_OFF = 256;       // u64 (8 bytes)
const ACCT_FEES_EARNED_TOTAL_OFF = 264;   // U128 (16 bytes) - NEW

const MAX_ACCOUNTS = 4096;
const ACCOUNT_SIZE = 280;
const BITMAP_WORDS = 64;

// =============================================================================
// RiskEngine Layout (repr(C), SBF 8-byte alignment for u128/i128)
//
// ENGINE_OFF = align_up(HEADER_LEN + CONFIG_LEN, 8) = align_up(72 + 368, 8) = 440
//
// Fields:
//   vault: U128                          @     0  (16 bytes)
//   insurance_fund: { U128, U128 }       @    16  (32 bytes)
//   params: RiskParams                   @    48  (176 bytes)
//   current_slot: u64                    @   224  (8 bytes)
//   funding_rate_bps_per_slot_last: i64  @   232  (8 bytes)
//   last_crank_slot: u64                 @   240  (8 bytes)
//   max_crank_staleness_slots: u64       @   248  (8 bytes)
//   c_tot: U128                          @   256  (16 bytes)
//   pnl_pos_tot: u128                    @   272  (16 bytes)
//   pnl_matured_pos_tot: u128            @   288  (16 bytes)
//   liq_cursor: u16                      @   304  (2 bytes)
//   gc_cursor: u16                       @   306  (2 bytes)
//   [4 bytes padding]
//   last_full_sweep_start_slot: u64      @   312  (8 bytes)
//   last_full_sweep_completed_slot: u64  @   320  (8 bytes)
//   crank_cursor: u16                    @   328  (2 bytes)
//   sweep_start_idx: u16                 @   330  (2 bytes)
//   [4 bytes padding]
//   lifetime_liquidations: u64           @   336  (8 bytes)
//   adl_mult_long: u128                  @   344  (16 bytes)
//   adl_mult_short: u128                 @   360  (16 bytes)
//   adl_coeff_long: i128                 @   376  (16 bytes)
//   adl_coeff_short: i128                @   392  (16 bytes)
//   adl_epoch_long: u64                  @   408  (8 bytes)
//   adl_epoch_short: u64                 @   416  (8 bytes)
//   adl_epoch_start_k_long: i128         @   424  (16 bytes)
//   adl_epoch_start_k_short: i128        @   440  (16 bytes)
//   oi_eff_long_q: u128                  @   456  (16 bytes)
//   oi_eff_short_q: u128                 @   472  (16 bytes)
//   side_mode_long: u8                   @   488  (1 byte)
//   side_mode_short: u8                  @   489  (1 byte)
//   [6 bytes padding]
//   stored_pos_count_long: u64           @   496  (8 bytes)
//   stored_pos_count_short: u64          @   504  (8 bytes)
//   stale_account_count_long: u64        @   512  (8 bytes)
//   stale_account_count_short: u64       @   520  (8 bytes)
//   phantom_dust_bound_long_q: u128      @   528  (16 bytes)
//   phantom_dust_bound_short_q: u128     @   544  (16 bytes)
//   materialized_account_count: u64      @   560  (8 bytes)
//   last_oracle_price: u64               @   568  (8 bytes)
//   last_market_slot: u64                @   576  (8 bytes)
//   funding_price_sample_last: u64       @   584  (8 bytes)
//   insurance_floor: u128                @   592  (16 bytes)
//   used: [u64; 64]                      @   608  (512 bytes)
//   num_used_accounts: u16               @  1120  (2 bytes)
//   [6 bytes padding]
//   next_account_id: u64                 @  1128  (8 bytes)
//   free_head: u16                       @  1136  (2 bytes)
//   next_free: [u16; 4096]               @  1138  (8192 bytes)
//   [6 bytes padding for account alignment]
//   accounts: [Account; 4096]            @  9336  (4096 * 280 = 1146880 bytes)
//
// Total engine size: 9336 + 1146880 = 1156216
// SLAB_LEN = ENGINE_OFF + engine_size = 440 + 1156216 = 1156656
// =============================================================================
const ENGINE_OFF = 440;

const ENGINE_VAULT_OFF = 0;                          // U128 (16 bytes)
const ENGINE_INSURANCE_OFF = 16;                     // InsuranceFund { U128, U128 } (32 bytes)
const ENGINE_PARAMS_OFF = 48;                        // RiskParams (176 bytes)
const ENGINE_CURRENT_SLOT_OFF = 224;                 // u64
const ENGINE_FUNDING_RATE_BPS_OFF = 232;             // i64
const ENGINE_LAST_CRANK_SLOT_OFF = 240;              // u64
const ENGINE_MAX_CRANK_STALENESS_OFF = 248;          // u64
const ENGINE_C_TOT_OFF = 256;                        // U128
const ENGINE_PNL_POS_TOT_OFF = 272;                  // u128
const ENGINE_PNL_MATURED_POS_TOT_OFF = 288;          // u128
const ENGINE_LIQ_CURSOR_OFF = 304;                   // u16
const ENGINE_GC_CURSOR_OFF = 306;                    // u16
// 4 bytes padding
const ENGINE_LAST_SWEEP_START_OFF = 312;             // u64
const ENGINE_LAST_SWEEP_COMPLETE_OFF = 320;          // u64
const ENGINE_CRANK_CURSOR_OFF = 328;                 // u16
const ENGINE_SWEEP_START_IDX_OFF = 330;              // u16
// 4 bytes padding
const ENGINE_LIFETIME_LIQUIDATIONS_OFF = 336;        // u64
// ADL state (already 8-byte aligned at 344)
const ENGINE_ADL_MULT_LONG_OFF = 344;                // u128
const ENGINE_ADL_MULT_SHORT_OFF = 360;               // u128
const ENGINE_ADL_COEFF_LONG_OFF = 376;               // i128
const ENGINE_ADL_COEFF_SHORT_OFF = 392;              // i128
const ENGINE_ADL_EPOCH_LONG_OFF = 408;               // u64
const ENGINE_ADL_EPOCH_SHORT_OFF = 416;              // u64
const ENGINE_ADL_EPOCH_START_K_LONG_OFF = 424;       // i128
const ENGINE_ADL_EPOCH_START_K_SHORT_OFF = 440;      // i128
const ENGINE_OI_EFF_LONG_Q_OFF = 456;                // u128
const ENGINE_OI_EFF_SHORT_Q_OFF = 472;               // u128
const ENGINE_SIDE_MODE_LONG_OFF = 488;               // u8
const ENGINE_SIDE_MODE_SHORT_OFF = 489;              // u8
// 6 bytes padding
const ENGINE_STORED_POS_COUNT_LONG_OFF = 496;        // u64
const ENGINE_STORED_POS_COUNT_SHORT_OFF = 504;       // u64
const ENGINE_STALE_ACCOUNT_COUNT_LONG_OFF = 512;     // u64
const ENGINE_STALE_ACCOUNT_COUNT_SHORT_OFF = 520;    // u64
const ENGINE_PHANTOM_DUST_LONG_OFF = 528;            // u128
const ENGINE_PHANTOM_DUST_SHORT_OFF = 544;           // u128
const ENGINE_MATERIALIZED_ACCOUNT_COUNT_OFF = 560;   // u64
const ENGINE_LAST_ORACLE_PRICE_OFF = 568;            // u64
const ENGINE_LAST_MARKET_SLOT_OFF = 576;             // u64
const ENGINE_FUNDING_PRICE_SAMPLE_OFF = 584;         // u64
const ENGINE_INSURANCE_FLOOR_OFF = 592;              // u128
const ENGINE_BITMAP_OFF = 608;                       // [u64; 64] = 512 bytes
const ENGINE_NUM_USED_OFF = 1120;                    // u16
// 6 bytes padding
const ENGINE_NEXT_ACCOUNT_ID_OFF = 1128;             // u64
const ENGINE_FREE_HEAD_OFF = 1136;                   // u16
// next_free: [u16; 4096] at 1138 (8192 bytes), ends at 9330
// 6 bytes padding for Account alignment (8-byte)
const ENGINE_ACCOUNTS_OFF = 9336;                    // accounts: [Account; 4096]

// =============================================================================
// Interfaces
// =============================================================================

export interface InsuranceFund {
  balance: bigint;
  feeRevenue: bigint;
}

export interface RiskParams {
  warmupPeriodSlots: bigint;
  maintenanceMarginBps: bigint;
  initialMarginBps: bigint;
  tradingFeeBps: bigint;
  maxAccounts: bigint;
  newAccountFee: bigint;
  maintenanceFeePerSlot: bigint;
  maxCrankStalenessSlots: bigint;
  liquidationFeeBps: bigint;
  liquidationFeeCap: bigint;
  liquidationBufferBps: bigint;
  minLiquidationAbs: bigint;
  minInitialDeposit: bigint;
  minNonzeroMmReq: bigint;
  minNonzeroImReq: bigint;
}

export enum SideMode {
  Normal = 0,
  ReduceOnly = 1,
  CloseOnly = 2,
}

export interface EngineState {
  vault: bigint;
  insuranceFund: InsuranceFund;
  currentSlot: bigint;
  fundingRateBpsPerSlotLast: bigint;
  lastCrankSlot: bigint;
  maxCrankStalenessSlots: bigint;
  cTot: bigint;
  pnlPosTot: bigint;
  pnlMaturedPosTot: bigint;
  liqCursor: number;
  gcCursor: number;
  lastSweepStartSlot: bigint;
  lastSweepCompleteSlot: bigint;
  crankCursor: number;
  sweepStartIdx: number;
  lifetimeLiquidations: bigint;
  // ADL state
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
  lastOraclePrice: bigint;
  lastMarketSlot: bigint;
  fundingPriceSampleLast: bigint;
  insuranceFloor: bigint;
  numUsedAccounts: number;
  nextAccountId: bigint;
}

export enum AccountKind {
  User = 0,
  LP = 1,
}

export interface Account {
  kind: AccountKind;
  accountId: bigint;
  capital: bigint;
  pnl: bigint;
  reservedPnl: bigint;
  warmupStartedAtSlot: bigint;
  warmupSlopePerStep: bigint;
  positionBasisQ: bigint;
  adlABasis: bigint;
  adlKSnap: bigint;
  adlEpochSnap: bigint;
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
  owner: PublicKey;
  feeCredits: bigint;
  lastFeeSlot: bigint;
  feesEarnedTotal: bigint;
}

// =============================================================================
// Helper: read signed i128 from buffer
// Match Rust's I128 wrapper: read both halves as unsigned, then interpret as signed
// =============================================================================
function readI128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  const unsigned = (hi << 64n) | lo;
  // If high bit is set, convert to negative (two's complement)
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) {
    return unsigned - (1n << 128n);
  }
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

/**
 * Parse RiskParams from engine data.
 * Note: invert/unitScale are in MarketConfig, not RiskParams.
 */
export function parseParams(data: Buffer): RiskParams {
  const base = ENGINE_OFF + ENGINE_PARAMS_OFF;
  if (data.length < base + PARAMS_SIZE) {
    throw new Error("Slab data too short for RiskParams");
  }

  return {
    warmupPeriodSlots: data.readBigUInt64LE(base + PARAMS_WARMUP_PERIOD_OFF),
    maintenanceMarginBps: data.readBigUInt64LE(base + PARAMS_MAINTENANCE_MARGIN_OFF),
    initialMarginBps: data.readBigUInt64LE(base + PARAMS_INITIAL_MARGIN_OFF),
    tradingFeeBps: data.readBigUInt64LE(base + PARAMS_TRADING_FEE_OFF),
    maxAccounts: data.readBigUInt64LE(base + PARAMS_MAX_ACCOUNTS_OFF),
    newAccountFee: readU128LE(data, base + PARAMS_NEW_ACCOUNT_FEE_OFF),
    maintenanceFeePerSlot: readU128LE(data, base + PARAMS_MAINTENANCE_FEE_OFF),
    maxCrankStalenessSlots: data.readBigUInt64LE(base + PARAMS_MAX_CRANK_STALENESS_OFF),
    liquidationFeeBps: data.readBigUInt64LE(base + PARAMS_LIQUIDATION_FEE_BPS_OFF),
    liquidationFeeCap: readU128LE(data, base + PARAMS_LIQUIDATION_FEE_CAP_OFF),
    liquidationBufferBps: data.readBigUInt64LE(base + PARAMS_LIQUIDATION_BUFFER_OFF),
    minLiquidationAbs: readU128LE(data, base + PARAMS_MIN_LIQUIDATION_OFF),
    minInitialDeposit: readU128LE(data, base + PARAMS_MIN_INITIAL_DEPOSIT_OFF),
    minNonzeroMmReq: readU128LE(data, base + PARAMS_MIN_NONZERO_MM_REQ_OFF),
    minNonzeroImReq: readU128LE(data, base + PARAMS_MIN_NONZERO_IM_REQ_OFF),
  };
}

/**
 * Parse RiskEngine state (excluding accounts array).
 */
export function parseEngine(data: Buffer): EngineState {
  const base = ENGINE_OFF;
  if (data.length < base + ENGINE_ACCOUNTS_OFF) {
    throw new Error("Slab data too short for RiskEngine");
  }

  return {
    vault: readU128LE(data, base + ENGINE_VAULT_OFF),
    insuranceFund: {
      balance: readU128LE(data, base + ENGINE_INSURANCE_OFF),
      feeRevenue: readU128LE(data, base + ENGINE_INSURANCE_OFF + 16),
    },
    currentSlot: data.readBigUInt64LE(base + ENGINE_CURRENT_SLOT_OFF),
    fundingRateBpsPerSlotLast: data.readBigInt64LE(base + ENGINE_FUNDING_RATE_BPS_OFF),
    lastCrankSlot: data.readBigUInt64LE(base + ENGINE_LAST_CRANK_SLOT_OFF),
    maxCrankStalenessSlots: data.readBigUInt64LE(base + ENGINE_MAX_CRANK_STALENESS_OFF),
    cTot: readU128LE(data, base + ENGINE_C_TOT_OFF),
    pnlPosTot: readU128LE(data, base + ENGINE_PNL_POS_TOT_OFF),
    pnlMaturedPosTot: readU128LE(data, base + ENGINE_PNL_MATURED_POS_TOT_OFF),
    liqCursor: data.readUInt16LE(base + ENGINE_LIQ_CURSOR_OFF),
    gcCursor: data.readUInt16LE(base + ENGINE_GC_CURSOR_OFF),
    lastSweepStartSlot: data.readBigUInt64LE(base + ENGINE_LAST_SWEEP_START_OFF),
    lastSweepCompleteSlot: data.readBigUInt64LE(base + ENGINE_LAST_SWEEP_COMPLETE_OFF),
    crankCursor: data.readUInt16LE(base + ENGINE_CRANK_CURSOR_OFF),
    sweepStartIdx: data.readUInt16LE(base + ENGINE_SWEEP_START_IDX_OFF),
    lifetimeLiquidations: data.readBigUInt64LE(base + ENGINE_LIFETIME_LIQUIDATIONS_OFF),
    // ADL state
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
    lastOraclePrice: data.readBigUInt64LE(base + ENGINE_LAST_ORACLE_PRICE_OFF),
    lastMarketSlot: data.readBigUInt64LE(base + ENGINE_LAST_MARKET_SLOT_OFF),
    fundingPriceSampleLast: data.readBigUInt64LE(base + ENGINE_FUNDING_PRICE_SAMPLE_OFF),
    insuranceFloor: readU128LE(data, base + ENGINE_INSURANCE_FLOOR_OFF),
    numUsedAccounts: data.readUInt16LE(base + ENGINE_NUM_USED_OFF),
    nextAccountId: data.readBigUInt64LE(base + ENGINE_NEXT_ACCOUNT_ID_OFF),
  };
}

/**
 * Read bitmap to get list of used account indices.
 */
export function parseUsedIndices(data: Buffer): number[] {
  const base = ENGINE_OFF + ENGINE_BITMAP_OFF;
  if (data.length < base + BITMAP_WORDS * 8) {
    throw new Error("Slab data too short for bitmap");
  }

  const used: number[] = [];
  for (let word = 0; word < BITMAP_WORDS; word++) {
    const bits = data.readBigUInt64LE(base + word * 8);
    if (bits === 0n) continue;
    for (let bit = 0; bit < 64; bit++) {
      if ((bits >> BigInt(bit)) & 1n) {
        used.push(word * 64 + bit);
      }
    }
  }
  return used;
}

/**
 * Check if a specific account index is used.
 */
export function isAccountUsed(data: Buffer, idx: number): boolean {
  if (idx < 0 || idx >= MAX_ACCOUNTS) return false;
  const base = ENGINE_OFF + ENGINE_BITMAP_OFF;
  const word = Math.floor(idx / 64);
  const bit = idx % 64;
  const bits = data.readBigUInt64LE(base + word * 8);
  return ((bits >> BigInt(bit)) & 1n) !== 0n;
}

/**
 * Calculate the maximum valid account index for a given slab size.
 */
export function maxAccountIndex(dataLen: number): number {
  const accountsEnd = dataLen - ENGINE_OFF - ENGINE_ACCOUNTS_OFF;
  if (accountsEnd <= 0) return 0;
  return Math.floor(accountsEnd / ACCOUNT_SIZE);
}

/**
 * Parse a single account by index.
 */
export function parseAccount(data: Buffer, idx: number): Account {
  const maxIdx = maxAccountIndex(data.length);
  if (idx < 0 || idx >= maxIdx) {
    throw new Error(`Account index out of range: ${idx} (max: ${maxIdx - 1})`);
  }

  const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + idx * ACCOUNT_SIZE;
  if (data.length < base + ACCOUNT_SIZE) {
    throw new Error("Slab data too short for account");
  }

  // Read the kind field directly from offset 24 (u8 with 7 bytes padding)
  const kindByte = data.readUInt8(base + ACCT_KIND_OFF);
  const kind = kindByte === 1 ? AccountKind.LP : AccountKind.User;

  return {
    kind,
    accountId: data.readBigUInt64LE(base + ACCT_ACCOUNT_ID_OFF),
    capital: readU128LE(data, base + ACCT_CAPITAL_OFF),
    pnl: readI128LE(data, base + ACCT_PNL_OFF),
    reservedPnl: readU128LE(data, base + ACCT_RESERVED_PNL_OFF),
    warmupStartedAtSlot: data.readBigUInt64LE(base + ACCT_WARMUP_STARTED_OFF),
    warmupSlopePerStep: readU128LE(data, base + ACCT_WARMUP_SLOPE_OFF),
    positionBasisQ: readI128LE(data, base + ACCT_POSITION_BASIS_Q_OFF),
    adlABasis: readU128LE(data, base + ACCT_ADL_A_BASIS_OFF),
    adlKSnap: readI128LE(data, base + ACCT_ADL_K_SNAP_OFF),
    adlEpochSnap: data.readBigUInt64LE(base + ACCT_ADL_EPOCH_SNAP_OFF),
    matcherProgram: new PublicKey(data.subarray(base + ACCT_MATCHER_PROGRAM_OFF, base + ACCT_MATCHER_PROGRAM_OFF + 32)),
    matcherContext: new PublicKey(data.subarray(base + ACCT_MATCHER_CONTEXT_OFF, base + ACCT_MATCHER_CONTEXT_OFF + 32)),
    owner: new PublicKey(data.subarray(base + ACCT_OWNER_OFF, base + ACCT_OWNER_OFF + 32)),
    feeCredits: readI128LE(data, base + ACCT_FEE_CREDITS_OFF),
    lastFeeSlot: data.readBigUInt64LE(base + ACCT_LAST_FEE_SLOT_OFF),
    feesEarnedTotal: readU128LE(data, base + ACCT_FEES_EARNED_TOTAL_OFF),
  };
}

/**
 * Parse all used accounts.
 * Filters out indices that would be beyond the slab's account storage capacity.
 */
export function parseAllAccounts(data: Buffer): { idx: number; account: Account }[] {
  const indices = parseUsedIndices(data);
  const maxIdx = maxAccountIndex(data.length);
  const validIndices = indices.filter(idx => idx < maxIdx);
  return validIndices.map(idx => ({
    idx,
    account: parseAccount(data, idx),
  }));
}
