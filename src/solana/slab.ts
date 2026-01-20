import { Connection, PublicKey } from "@solana/web3.js";

// Constants from Rust (updated for funding/threshold params 2026-01)
const MAGIC: bigint = 0x504552434f4c4154n; // "PERCOLAT"
const HEADER_LEN = 72;    // SlabHeader: magic(8) + version(4) + bump(1) + _padding(3) + admin(32) + _reserved(24)
const CONFIG_OFFSET = HEADER_LEN;  // MarketConfig starts right after header
// MarketConfig: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32) + max_staleness_secs(8) +
//               conf_filter_bps(2) + bump(1) + invert(1) + unit_scale(4) +
//               funding_horizon_slots(8) + funding_k_bps(8) + funding_inv_scale_notional_e6(16) +
//               funding_max_premium_bps(8) + funding_max_bps_per_slot(8) +
//               thresh_floor(16) + thresh_risk_bps(8) + thresh_update_interval_slots(8) +
//               thresh_step_bps(8) + thresh_alpha_bps(8) + thresh_min(16) + thresh_max(16) + thresh_min_step(16) +
//               oracle_authority(32) + authority_price_e6(8) + authority_timestamp(8)
const CONFIG_LEN = 304;
const RESERVED_OFF = 48;  // Offset of _reserved field within SlabHeader

/**
 * Slab header (72 bytes)
 */
export interface SlabHeader {
  magic: bigint;
  version: number;
  bump: number;
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
  const admin = new PublicKey(data.subarray(16, 48));

  // Reserved field: nonce at [0..8], lastThrUpdateSlot at [8..16]
  const nonce = data.readBigUInt64LE(RESERVED_OFF);
  const lastThrUpdateSlot = data.readBigUInt64LE(RESERVED_OFF + 8);

  return {
    magic,
    version,
    bump,
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
// RiskEngine Layout Constants (updated for oracle authority 2026-01)
// ENGINE_OFF = HEADER_LEN + CONFIG_LEN = 72 + 304 = 376
// =============================================================================
const ENGINE_OFF = 376;
// RiskEngine struct layout (repr(C), SBF uses 8-byte alignment for u128):
// - vault: u128 (16 bytes) at offset 0
// - insurance_fund: InsuranceFund { balance: u128, fee_revenue: u128 } (32 bytes) at offset 16
// - params: RiskParams (144 bytes) at offset 48
const ENGINE_VAULT_OFF = 0;
const ENGINE_INSURANCE_OFF = 16;
const ENGINE_PARAMS_OFF = 48;         // RiskParams starts here (after vault+insurance_fund)
// After RiskParams (at engine offset 48 + 144 = 192):
const ENGINE_CURRENT_SLOT_OFF = 192;
const ENGINE_FUNDING_INDEX_OFF = 200;
const ENGINE_LAST_FUNDING_SLOT_OFF = 216;
const ENGINE_LOSS_ACCUM_OFF = 224;
const ENGINE_RISK_REDUCTION_ONLY_OFF = 240;
const ENGINE_RISK_REDUCTION_WITHDRAWN_OFF = 248;
const ENGINE_WARMUP_PAUSED_OFF = 264;
const ENGINE_WARMUP_PAUSE_SLOT_OFF = 272;
const ENGINE_LAST_CRANK_SLOT_OFF = 280;
const ENGINE_MAX_CRANK_STALENESS_OFF = 288;
const ENGINE_TOTAL_OI_OFF = 296;
const ENGINE_WARMED_POS_OFF = 312;
const ENGINE_WARMED_NEG_OFF = 328;
const ENGINE_WARMUP_INSURANCE_OFF = 344;
// ADL scratch arrays and deferred socialization buckets span ~86K bytes
// See RiskEngine struct for full layout: adl_remainder_scratch, adl_idx_scratch,
// adl_exclude_scratch, pending_*, liq_cursor, gc_cursor, then sweep/crank fields
// Offsets computed backwards from ENGINE_BITMAP_OFF = 86520:
const ENGINE_LAST_SWEEP_START_OFF = 86416;    // last_full_sweep_start_slot: u64
const ENGINE_LAST_SWEEP_COMPLETE_OFF = 86424; // last_full_sweep_completed_slot: u64
const ENGINE_CRANK_STEP_OFF = 86432;          // crank_step: u8 (+ 7 bytes padding)
const ENGINE_LIFETIME_LIQUIDATIONS_OFF = 86440; // lifetime_liquidations: u64
const ENGINE_LIFETIME_FORCE_CLOSES_OFF = 86448; // lifetime_force_realize_closes: u64
// LP Aggregates for funding rate calculation
const ENGINE_NET_LP_POS_OFF = 86456;          // net_lp_pos: i128 (sum of LP positions)
const ENGINE_LP_SUM_ABS_OFF = 86472;          // lp_sum_abs: u128
const ENGINE_LP_MAX_ABS_OFF = 86488;          // lp_max_abs: u128
const ENGINE_LP_MAX_ABS_SWEEP_OFF = 86504;    // lp_max_abs_sweep: u128
// Verified via find-bitmap.ts against devnet 2026-01 (after RiskEngine grew by 4096 bytes):
// - Created LP and found: bitmap=1 (bit 0 set), numUsed=1, nextAccountId=6
// - bitmap (u64=1) at slab 86848 = engine 86520
// - numUsed (u16=1) at slab 87360 = engine 87032
// - nextAccountId (u64) at slab 87368 = engine 87040
// - accounts start at slab 95584 = engine 95256 (owner pubkeys verified)
const ENGINE_BITMAP_OFF = 86520;          // slab 86848 = 328 + 86520 (bitmap word 0)
const ENGINE_NUM_USED_OFF = 87032;        // slab 87360 = 328 + 87032 (u16)
const ENGINE_NEXT_ACCOUNT_ID_OFF = 87040; // slab 87368 = 328 + 87040 (u64)
const ENGINE_ACCOUNTS_OFF = 95256;        // slab 95584 = 328 + 95256

const BITMAP_WORDS = 64;
const MAX_ACCOUNTS = 4096;
const ACCOUNT_SIZE = 248;  // Empirically verified (was 272, but actual SBF layout is 248)

// =============================================================================
// RiskParams Layout (144 bytes, repr(C) with 8-byte alignment on SBF)
// Note: SBF target uses 8-byte alignment for u128, not 16-byte
// Verified via verify-layout.cjs against devnet 2024-01
// =============================================================================
const PARAMS_WARMUP_PERIOD_OFF = 0;        // u64
const PARAMS_MAINTENANCE_MARGIN_OFF = 8;   // u64
const PARAMS_INITIAL_MARGIN_OFF = 16;      // u64
const PARAMS_TRADING_FEE_OFF = 24;         // u64
const PARAMS_MAX_ACCOUNTS_OFF = 32;        // u64
const PARAMS_NEW_ACCOUNT_FEE_OFF = 40;     // u128 (no padding, 8-byte aligned)
const PARAMS_RISK_THRESHOLD_OFF = 56;      // u128
const PARAMS_MAINTENANCE_FEE_OFF = 72;     // u128
const PARAMS_MAX_CRANK_STALENESS_OFF = 88; // u64
const PARAMS_LIQUIDATION_FEE_BPS_OFF = 96; // u64
const PARAMS_LIQUIDATION_FEE_CAP_OFF = 104;// u128
const PARAMS_LIQUIDATION_BUFFER_OFF = 120; // u64
const PARAMS_MIN_LIQUIDATION_OFF = 128;    // u128 (total = 144 bytes)

// =============================================================================
// Account Layout (248 bytes, repr(C))
// NOTE: Despite U128/I128 wrapper types in Rust, on-chain layout remains unchanged
// Field order: account_id, capital, kind, pnl, reserved_pnl, warmup_started,
//              warmup_slope, position_size, entry_price, funding_index,
//              matcher_program, matcher_context, owner, fee_credits, last_fee_slot
// =============================================================================
const ACCT_ACCOUNT_ID_OFF = 0;        // accountId (u64, 8 bytes), ends at 8
const ACCT_CAPITAL_OFF = 8;           // capital (U128, 16 bytes), ends at 24
const ACCT_KIND_OFF = 24;             // kind (u8, 1 byte + 7 padding), ends at 32
const ACCT_PNL_OFF = 32;              // pnl (I128, 16 bytes), ends at 48
const ACCT_RESERVED_PNL_OFF = 48;     // reserved_pnl (U128, 16 bytes), ends at 64
const ACCT_WARMUP_STARTED_OFF = 56;   // warmup_started (u64, 8 bytes), ends at 64
const ACCT_WARMUP_SLOPE_OFF = 64;     // warmup_slope (U128, 16 bytes), ends at 80
const ACCT_POSITION_SIZE_OFF = 80;    // position_size (I128, 16 bytes), ends at 96
const ACCT_ENTRY_PRICE_OFF = 96;      // entry_price (u64, 8 bytes), ends at 104
const ACCT_FUNDING_INDEX_OFF = 104;   // funding_index (I128, 16 bytes), ends at 120
const ACCT_MATCHER_PROGRAM_OFF = 120; // matcher_program (Pubkey, 32 bytes), ends at 152
const ACCT_MATCHER_CONTEXT_OFF = 152; // matcher_context (Pubkey, 32 bytes), ends at 184
const ACCT_OWNER_OFF = 184;           // owner (Pubkey, 32 bytes), ends at 216
const ACCT_FEE_CREDITS_OFF = 216;     // fee_credits (I128, 16 bytes), ends at 232
const ACCT_LAST_FEE_SLOT_OFF = 232;   // last_fee_slot (u64, 8 bytes), ends at 240

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
  riskReductionThreshold: bigint;
  maintenanceFeePerSlot: bigint;
  maxCrankStalenessSlots: bigint;
  liquidationFeeBps: bigint;
  liquidationFeeCap: bigint;
  liquidationBufferBps: bigint;
  minLiquidationAbs: bigint;
}

export interface EngineState {
  vault: bigint;
  insuranceFund: InsuranceFund;
  currentSlot: bigint;
  fundingIndexQpbE6: bigint;
  lastFundingSlot: bigint;
  lossAccum: bigint;
  riskReductionOnly: boolean;
  riskReductionModeWithdrawn: bigint;
  warmupPaused: boolean;
  warmupPauseSlot: bigint;
  lastCrankSlot: bigint;
  maxCrankStalenessSlots: bigint;
  totalOpenInterest: bigint;
  warmedPosTotal: bigint;
  warmedNegTotal: bigint;
  warmupInsuranceReserved: bigint;
  lastSweepStartSlot: bigint;
  lastSweepCompleteSlot: bigint;
  crankStep: number;
  lifetimeLiquidations: bigint;
  lifetimeForceCloses: bigint;
  // LP Aggregates for funding
  netLpPos: bigint;          // Net LP position (sum of all LP positions)
  lpSumAbs: bigint;          // Sum of abs(LP positions)
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
  positionSize: bigint;
  entryPrice: bigint;
  fundingIndex: bigint;
  matcherProgram: PublicKey;
  matcherContext: PublicKey;  // Pubkey (32 bytes)
  owner: PublicKey;
  feeCredits: bigint;
  lastFeeSlot: bigint;
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
  if (data.length < base + 160) {  // RiskParams is 160 bytes with repr(C) padding
    throw new Error("Slab data too short for RiskParams");
  }

  return {
    warmupPeriodSlots: data.readBigUInt64LE(base + PARAMS_WARMUP_PERIOD_OFF),
    maintenanceMarginBps: data.readBigUInt64LE(base + PARAMS_MAINTENANCE_MARGIN_OFF),
    initialMarginBps: data.readBigUInt64LE(base + PARAMS_INITIAL_MARGIN_OFF),
    tradingFeeBps: data.readBigUInt64LE(base + PARAMS_TRADING_FEE_OFF),
    maxAccounts: data.readBigUInt64LE(base + PARAMS_MAX_ACCOUNTS_OFF),
    newAccountFee: readU128LE(data, base + PARAMS_NEW_ACCOUNT_FEE_OFF),
    riskReductionThreshold: readU128LE(data, base + PARAMS_RISK_THRESHOLD_OFF),
    maintenanceFeePerSlot: readU128LE(data, base + PARAMS_MAINTENANCE_FEE_OFF),
    maxCrankStalenessSlots: data.readBigUInt64LE(base + PARAMS_MAX_CRANK_STALENESS_OFF),
    liquidationFeeBps: data.readBigUInt64LE(base + PARAMS_LIQUIDATION_FEE_BPS_OFF),
    liquidationFeeCap: readU128LE(data, base + PARAMS_LIQUIDATION_FEE_CAP_OFF),
    liquidationBufferBps: data.readBigUInt64LE(base + PARAMS_LIQUIDATION_BUFFER_OFF),
    minLiquidationAbs: readU128LE(data, base + PARAMS_MIN_LIQUIDATION_OFF),
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
    fundingIndexQpbE6: readI128LE(data, base + ENGINE_FUNDING_INDEX_OFF),
    lastFundingSlot: data.readBigUInt64LE(base + ENGINE_LAST_FUNDING_SLOT_OFF),
    lossAccum: readU128LE(data, base + ENGINE_LOSS_ACCUM_OFF),
    riskReductionOnly: data.readUInt8(base + ENGINE_RISK_REDUCTION_ONLY_OFF) !== 0,
    riskReductionModeWithdrawn: readU128LE(data, base + ENGINE_RISK_REDUCTION_WITHDRAWN_OFF),
    warmupPaused: data.readUInt8(base + ENGINE_WARMUP_PAUSED_OFF) !== 0,
    warmupPauseSlot: data.readBigUInt64LE(base + ENGINE_WARMUP_PAUSE_SLOT_OFF),
    lastCrankSlot: data.readBigUInt64LE(base + ENGINE_LAST_CRANK_SLOT_OFF),
    maxCrankStalenessSlots: data.readBigUInt64LE(base + ENGINE_MAX_CRANK_STALENESS_OFF),
    totalOpenInterest: readU128LE(data, base + ENGINE_TOTAL_OI_OFF),
    warmedPosTotal: readU128LE(data, base + ENGINE_WARMED_POS_OFF),
    warmedNegTotal: readU128LE(data, base + ENGINE_WARMED_NEG_OFF),
    warmupInsuranceReserved: readU128LE(data, base + ENGINE_WARMUP_INSURANCE_OFF),
    lastSweepStartSlot: data.readBigUInt64LE(base + ENGINE_LAST_SWEEP_START_OFF),
    lastSweepCompleteSlot: data.readBigUInt64LE(base + ENGINE_LAST_SWEEP_COMPLETE_OFF),
    crankStep: data.readUInt8(base + ENGINE_CRANK_STEP_OFF),
    lifetimeLiquidations: data.readBigUInt64LE(base + ENGINE_LIFETIME_LIQUIDATIONS_OFF),
    lifetimeForceCloses: data.readBigUInt64LE(base + ENGINE_LIFETIME_FORCE_CLOSES_OFF),
    // LP Aggregates for funding rate calculation
    netLpPos: readI128LE(data, base + ENGINE_NET_LP_POS_OFF),
    lpSumAbs: readU128LE(data, base + ENGINE_LP_SUM_ABS_OFF),
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
    reservedPnl: data.readBigUInt64LE(base + ACCT_RESERVED_PNL_OFF),  // u64
    warmupStartedAtSlot: data.readBigUInt64LE(base + ACCT_WARMUP_STARTED_OFF),
    warmupSlopePerStep: data.readBigUInt64LE(base + ACCT_WARMUP_SLOPE_OFF),  // u64
    positionSize: readI128LE(data, base + ACCT_POSITION_SIZE_OFF),
    entryPrice: data.readBigUInt64LE(base + ACCT_ENTRY_PRICE_OFF),
    fundingIndex: readI128LE(data, base + ACCT_FUNDING_INDEX_OFF),
    matcherProgram: new PublicKey(data.subarray(base + ACCT_MATCHER_PROGRAM_OFF, base + ACCT_MATCHER_PROGRAM_OFF + 32)),
    matcherContext: new PublicKey(data.subarray(base + ACCT_MATCHER_CONTEXT_OFF, base + ACCT_MATCHER_CONTEXT_OFF + 32)),
    owner: new PublicKey(data.subarray(base + ACCT_OWNER_OFF, base + ACCT_OWNER_OFF + 32)),
    feeCredits: readI128LE(data, base + ACCT_FEE_CREDITS_OFF),
    lastFeeSlot: data.readBigUInt64LE(base + ACCT_LAST_FEE_SLOT_OFF),
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
