import { Connection, PublicKey, type GetProgramAccountsFilter } from "@solana/web3.js";

// =============================================================================
// Constants — BPF layout (u128/i128 have 8-byte alignment, not 16-byte
// alignment as on native x86_64).
//
// Layout authoritatively pinned via wrapper-side `offset_of!` /
// `size_of` logging captured against the deployed devnet BPF binary
// (engine f38ec2f, wrapper master). All offset constants below are
// BPF ground truth — DO NOT hand-edit without re-deriving from the
// wrapper. See `scripts/setup-devnet-market.ts` log capture for the
// dump-and-diff procedure.
//
// Layout summary (MAX_ACCOUNTS=4096, BPF):
//   SLAB_LEN      = 1_755_376
//   HEADER_LEN    = 136
//   CONFIG_LEN    = 384
//   ENGINE_OFF    = 520        = align_up(136 + 384, 8)
//   PARAMS_SIZE   = 168
//   ENGINE_LEN    = 1_721_928
//   RISK_BUF_LEN  = 160
//   GEN_TABLE_LEN = 32_768     (MAX_ACCOUNTS * 8)
//   ACCOUNT_SIZE  = 416        (was 360 — added loss_weight + b_snap +
//                               b_rem + b_epoch_snap = 56 bytes for
//                               B-index account-local bankruptcy state)
// =============================================================================
export const SLAB_MAGIC: bigint = 0x504552434f4c4154n; // "PERCOLAT"
// The u64 magic is stored little-endian on chain, so the account bytes are "TALOCREP".
export const SLAB_MAGIC_BYTES = [0x54, 0x41, 0x4c, 0x4f, 0x43, 0x52, 0x45, 0x50] as const;
const HEADER_LEN = 136;
const CONFIG_OFFSET = HEADER_LEN;
const CONFIG_LEN = 384;
const RESERVED_OFF = 48;             // nonce at [0..8], (8 bytes free), padding to 72

// Flag bits in header._padding[0] at offset 13
const FLAG_CPI_IN_PROGRESS = 1 << 2;
const FLAG_ORACLE_INITIALIZED = 1 << 3;

export const SLAB_LEN = 1_755_520;
export { HEADER_LEN, CONFIG_LEN };

export function hasSlabMagic(data: Buffer | Uint8Array): boolean {
  if (data.length < SLAB_MAGIC_BYTES.length) return false;
  return SLAB_MAGIC_BYTES.every((byte, i) => data[i] === byte);
}

export function slabMagicMemcmpFilter(): GetProgramAccountsFilter {
  return {
    memcmp: {
      offset: 0,
      encoding: "base64",
      bytes: Buffer.from(SLAB_MAGIC_BYTES).toString("base64"),
    },
  };
}

/**
 * Slab header (136 bytes, v12.20+ — close_authority removed).
 */
export interface SlabHeader {
  magic: bigint;
  version: number;
  bump: number;
  flags: number;
  admin: PublicKey;
  nonce: bigint;
  matCounter: bigint;
  insuranceAuthority: PublicKey;   // bytes 72..104
  insuranceOperator: PublicKey;    // bytes 104..136 (close_authority field removed)
}

/**
 * MarketConfig (384 bytes, v12.21+).
 * v12.21 changes:
 *   - removed `oracle_price_cap_e2bps` + `min_oracle_price_cap_e2bps` (16 bytes total)
 *   - added `oracle_target_price_e6` + `oracle_target_publish_time` (16 bytes total)
 *   - added `insurance_withdraw_deposits_only:u8` flag
 *   - repurposed obsolete pad slot as `insurance_withdraw_deposit_remaining:u64`
 *
 * Net: same engine offsets minus 16 bytes for the removed oracle-cap fields.
 */
export interface MarketConfig {
  collateralMint: PublicKey;
  vaultPubkey: PublicKey;
  indexFeedId: PublicKey;
  maxStalenessSecs: bigint;
  confFilterBps: number;
  vaultAuthorityBump: number;
  invert: number;
  unitScale: number;
  fundingHorizonSlots: bigint;
  fundingKBps: bigint;
  fundingMaxPremiumBps: bigint;        // i64
  fundingMaxE9PerSlot: bigint;         // i64
  hyperpAuthority: PublicKey;
  hyperpMarkE6: bigint;
  lastOraclePublishTime: bigint;       // i64
  lastEffectivePriceE6: bigint;        // dt-capped staircase
  insuranceWithdrawMaxBps: number;     // u16 — top bit (0x8000) is the deposits-only flag (v12.21+)
  tvlInsuranceCapMult: number;
  insuranceWithdrawDepositsOnly: number; // u8 (v12.21)
  insuranceWithdrawCooldownSlots: bigint;
  oracleTargetPriceE6: bigint;         // u64 (v12.21) — raw external oracle target in engine-space e6
  oracleTargetPublishTime: bigint;     // i64 (v12.21)
  lastHyperpIndexSlot: bigint;
  lastMarkPushSlot: bigint;
  lastInsuranceWithdrawSlot: bigint;
  insuranceWithdrawDepositRemaining: bigint; // u64 (v12.21) — repurposed obsolete pad
  markEwmaE6: bigint;
  markEwmaLastSlot: bigint;
  markEwmaHalflifeSlots: bigint;
  initRestartSlot: bigint;
  permissionlessResolveStaleSlots: bigint;
  lastGoodOracleSlot: bigint;
  maintenanceFeePerSlot: bigint;       // u128
  feeSweepCursorWord: bigint;
  feeSweepCursorBit: bigint;
  markMinFee: bigint;
  forceCloseDelaySlots: bigint;
  newAccountFee: bigint;               // u128
}

/**
 * Fetch and minimally validate a slab account.
 *
 * If `expectedOwner` is supplied (the percolator program id), the account's
 * `owner` field must match — otherwise we throw before any caller parses
 * the data. Without this, a system-owned account containing crafted
 * PERCOLAT magic + attacker-controlled vault/mint pubkeys would parse
 * cleanly via parseConfig() and redirect a CLI-built transaction at
 * those attacker-controlled accounts.
 *
 * The on-chain program performs the same owner check at instruction
 * dispatch, so this is defense in depth — fail loudly in the CLI before
 * the user signs, rather than silently building a tx that the program
 * will reject.
 *
 * `expectedOwner` is optional so legacy callers (scripts/tests that read
 * raw slab bytes for inspection) still work; in-tree command code paths
 * pass `ctx.programId`.
 */
export async function fetchSlab(
  connection: Connection,
  slabPubkey: PublicKey,
  expectedOwner?: PublicKey,
): Promise<Buffer> {
  const info = await connection.getAccountInfo(slabPubkey);
  if (!info) throw new Error(`Slab account not found: ${slabPubkey.toBase58()}`);
  if (expectedOwner && !info.owner.equals(expectedOwner)) {
    throw new Error(
      `Slab account ${slabPubkey.toBase58()} owner mismatch: expected ${expectedOwner.toBase58()}, got ${info.owner.toBase58()}`
    );
  }
  return Buffer.from(info.data);
}

export function parseHeader(data: Buffer): SlabHeader {
  if (data.length < HEADER_LEN) {
    throw new Error(`Slab data too short for header: ${data.length} < ${HEADER_LEN}`);
  }
  const magic = data.readBigUInt64LE(0);
  if (magic !== SLAB_MAGIC) {
    throw new Error(`Invalid slab magic: expected ${SLAB_MAGIC.toString(16)}, got ${magic.toString(16)}`);
  }
  return {
    magic,
    version: data.readUInt32LE(8),
    bump: data.readUInt8(12),
    flags: data.readUInt8(13),
    admin: new PublicKey(data.subarray(16, 48)),
    nonce: data.readBigUInt64LE(RESERVED_OFF),
    matCounter: data.readBigUInt64LE(RESERVED_OFF + 8),
    insuranceAuthority: new PublicKey(data.subarray(72, 104)),
    insuranceOperator: new PublicKey(data.subarray(104, 136)),
  };
}

export function parseConfig(data: Buffer): MarketConfig {
  const minLen = CONFIG_OFFSET + CONFIG_LEN;
  if (data.length < minLen) throw new Error(`Slab data too short for config: ${data.length} < ${minLen}`);

  let off = CONFIG_OFFSET;

  const collateralMint = new PublicKey(data.subarray(off, off + 32));        off += 32;
  const vaultPubkey = new PublicKey(data.subarray(off, off + 32));            off += 32;
  const indexFeedId = new PublicKey(data.subarray(off, off + 32));            off += 32;
  const maxStalenessSecs = data.readBigUInt64LE(off);                        off += 8;
  const confFilterBps = data.readUInt16LE(off);                               off += 2;
  const vaultAuthorityBump = data.readUInt8(off);                             off += 1;
  const invert = data.readUInt8(off);                                         off += 1;
  const unitScale = data.readUInt32LE(off);                                   off += 4;
  const fundingHorizonSlots = data.readBigUInt64LE(off);                      off += 8;
  const fundingKBps = data.readBigUInt64LE(off);                              off += 8;
  const fundingMaxPremiumBps = data.readBigInt64LE(off);                      off += 8;
  const fundingMaxE9PerSlot = data.readBigInt64LE(off);                       off += 8;
  const hyperpAuthority = new PublicKey(data.subarray(off, off + 32));        off += 32;
  const hyperpMarkE6 = data.readBigUInt64LE(off);                             off += 8;
  const lastOraclePublishTime = data.readBigInt64LE(off);                     off += 8;
  const lastEffectivePriceE6 = data.readBigUInt64LE(off);                     off += 8;
  const insuranceWithdrawMaxBps = data.readUInt16LE(off);                     off += 2;
  const tvlInsuranceCapMult = data.readUInt16LE(off);                         off += 2;
  const insuranceWithdrawDepositsOnly = data.readUInt8(off);                  off += 1;
  off += 3; // _iw_padding[3]
  const insuranceWithdrawCooldownSlots = data.readBigUInt64LE(off);           off += 8;
  const oracleTargetPriceE6 = data.readBigUInt64LE(off);                      off += 8;
  const oracleTargetPublishTime = data.readBigInt64LE(off);                   off += 8;
  const lastHyperpIndexSlot = data.readBigUInt64LE(off);                      off += 8;
  const lastMarkPushSlot = readU128LE(data, off);                             off += 16;
  const lastInsuranceWithdrawSlot = data.readBigUInt64LE(off);                off += 8;
  const insuranceWithdrawDepositRemaining = data.readBigUInt64LE(off);        off += 8;
  const markEwmaE6 = data.readBigUInt64LE(off);                               off += 8;
  const markEwmaLastSlot = data.readBigUInt64LE(off);                         off += 8;
  const markEwmaHalflifeSlots = data.readBigUInt64LE(off);                    off += 8;
  const initRestartSlot = data.readBigUInt64LE(off);                          off += 8;
  const permissionlessResolveStaleSlots = data.readBigUInt64LE(off);          off += 8;
  const lastGoodOracleSlot = data.readBigUInt64LE(off);                       off += 8;
  const maintenanceFeePerSlot = readU128LE(data, off);                        off += 16;
  const feeSweepCursorWord = data.readBigUInt64LE(off);                       off += 8;
  const feeSweepCursorBit = data.readBigUInt64LE(off);                        off += 8;
  const markMinFee = data.readBigUInt64LE(off);                               off += 8;
  const forceCloseDelaySlots = data.readBigUInt64LE(off);                     off += 8;
  const newAccountFee = readU128LE(data, off);                                // off += 16;

  return {
    collateralMint, vaultPubkey, indexFeedId,
    maxStalenessSecs, confFilterBps, vaultAuthorityBump, invert, unitScale,
    fundingHorizonSlots, fundingKBps, fundingMaxPremiumBps, fundingMaxE9PerSlot,
    hyperpAuthority, hyperpMarkE6, lastOraclePublishTime,
    lastEffectivePriceE6,
    insuranceWithdrawMaxBps, tvlInsuranceCapMult, insuranceWithdrawDepositsOnly,
    insuranceWithdrawCooldownSlots,
    oracleTargetPriceE6, oracleTargetPublishTime,
    lastHyperpIndexSlot, lastMarkPushSlot, lastInsuranceWithdrawSlot,
    insuranceWithdrawDepositRemaining,
    markEwmaE6, markEwmaLastSlot, markEwmaHalflifeSlots, initRestartSlot,
    permissionlessResolveStaleSlots, lastGoodOracleSlot,
    maintenanceFeePerSlot, feeSweepCursorWord, feeSweepCursorBit,
    markMinFee, forceCloseDelaySlots, newAccountFee,
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
// RiskParams Layout (168 bytes, BPF 8-byte alignment; v12.21+).
// Changes from v12.20:
//   - removed `max_crank_staleness_slots` (u64) from in-memory storage
//     (still present on the wire for backward-compat — read+discarded)
//   - added `max_price_move_bps_per_slot` (u64) at the end
// Net struct size unchanged at 168.
// =============================================================================
const PARAMS_MAINTENANCE_MARGIN_OFF = 0;
const PARAMS_INITIAL_MARGIN_OFF = 8;
const PARAMS_TRADING_FEE_OFF = 16;
const PARAMS_MAX_ACCOUNTS_OFF = 24;
const PARAMS_LIQUIDATION_FEE_BPS_OFF = 32;     // was 40 (max_crank_staleness removed)
const PARAMS_LIQUIDATION_FEE_CAP_OFF = 40;     // U128 (8-byte aligned on BPF)
const PARAMS_MIN_LIQUIDATION_OFF = 56;         // U128
const PARAMS_MIN_NONZERO_MM_REQ_OFF = 72;      // u128
const PARAMS_MIN_NONZERO_IM_REQ_OFF = 88;      // u128
const PARAMS_H_MIN_OFF = 104;
const PARAMS_H_MAX_OFF = 112;
const PARAMS_RESOLVE_PRICE_DEVIATION_OFF = 120;
const PARAMS_MAX_ACCRUAL_DT_OFF = 128;
const PARAMS_MAX_ABS_FUNDING_OFF = 136;
const PARAMS_MIN_FUNDING_LIFETIME_OFF = 144;
const PARAMS_MAX_ACTIVE_POSITIONS_OFF = 152;
const PARAMS_MAX_PRICE_MOVE_OFF = 160;          // u64 (v12.21+)
const PARAMS_SIZE = 168;

// =============================================================================
// Account Layout (416 bytes BPF). +56 bytes vs old layout: B-index
// account-local bankruptcy state (loss_weight + b_snap + b_rem + b_epoch_snap)
// inserted before matcher_program.
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
const ACCT_LOSS_WEIGHT_OFF = 128;             // u128 (B-index)
const ACCT_B_SNAP_OFF = 144;                  // u128
const ACCT_B_REM_OFF = 160;                   // u128
const ACCT_B_EPOCH_SNAP_OFF = 176;            // u64
const ACCT_MATCHER_PROGRAM_OFF = 184;
const ACCT_MATCHER_CONTEXT_OFF = 216;
const ACCT_OWNER_OFF = 248;
const ACCT_FEE_CREDITS_OFF = 280;             // I128
const ACCT_LAST_FEE_SLOT_OFF = 296;
const ACCT_SCHED_PRESENT_OFF = 304;
const ACCT_SCHED_REMAINING_Q_OFF = 312;
const ACCT_SCHED_ANCHOR_Q_OFF = 328;
const ACCT_SCHED_START_SLOT_OFF = 344;
const ACCT_SCHED_HORIZON_OFF = 352;
const ACCT_SCHED_RELEASE_Q_OFF = 360;
const ACCT_PENDING_PRESENT_OFF = 376;
const ACCT_PENDING_REMAINING_Q_OFF = 384;
const ACCT_PENDING_HORIZON_OFF = 400;
const ACCT_PENDING_CREATED_SLOT_OFF = 408;

const ACCOUNT_SIZE = 416;

// =============================================================================
// RiskEngine Layout (BPF, ENGINE_LEN = 1_721_928).
// New blocks compared to the prior CLI snapshot:
//   - phantom_dust split into certified+potential (4 u128 instead of 2)
//   - B-index residual state: b_*_num, loss_weight_sum_*, social_loss_*
//     (+208 bytes block at offsets 608..816)
//   - explicit_unallocated_loss_*, explicit_unallocated_protocol_loss,
//     explicit_unallocated_loss_saturated
//   - stress envelope: stress_consumed_bps_e9, stress_envelope_*
//   - bankruptcy_hmax_lock_active (bool)
//   - active_close_* continuation state (bounded full-close loop)
// All offsets below were captured via `offset_of!` logging from the BPF
// binary; do NOT recompute by hand.
// =============================================================================
const ENGINE_OFF = 520;

const ENGINE_VAULT_OFF = 0;
const ENGINE_INSURANCE_OFF = 16;
const ENGINE_PARAMS_OFF = 32;                         // RiskParams (168 bytes)
const ENGINE_CURRENT_SLOT_OFF = 200;
const ENGINE_MARKET_MODE_OFF = 208;
const ENGINE_RESOLVED_PRICE_OFF = 216;
const ENGINE_RESOLVED_SLOT_OFF = 224;
const ENGINE_RESOLVED_PAYOUT_H_NUM_OFF = 232;
const ENGINE_RESOLVED_PAYOUT_H_DEN_OFF = 248;
const ENGINE_RESOLVED_PAYOUT_READY_OFF = 264;
const ENGINE_RESOLVED_K_LONG_TERMINAL_OFF = 272;
const ENGINE_RESOLVED_K_SHORT_TERMINAL_OFF = 288;
const ENGINE_RESOLVED_LIVE_PRICE_OFF = 304;
const ENGINE_C_TOT_OFF = 312;
const ENGINE_PNL_POS_TOT_OFF = 328;
const ENGINE_PNL_MATURED_POS_TOT_OFF = 344;
const ENGINE_ADL_MULT_LONG_OFF = 360;
const ENGINE_ADL_MULT_SHORT_OFF = 376;
const ENGINE_ADL_COEFF_LONG_OFF = 392;
const ENGINE_ADL_COEFF_SHORT_OFF = 408;
const ENGINE_ADL_EPOCH_LONG_OFF = 424;
const ENGINE_ADL_EPOCH_SHORT_OFF = 432;
const ENGINE_ADL_EPOCH_START_K_LONG_OFF = 440;
const ENGINE_ADL_EPOCH_START_K_SHORT_OFF = 456;
const ENGINE_OI_EFF_LONG_Q_OFF = 472;
const ENGINE_OI_EFF_SHORT_Q_OFF = 488;
const ENGINE_SIDE_MODE_LONG_OFF = 504;
const ENGINE_SIDE_MODE_SHORT_OFF = 505;
const ENGINE_STORED_POS_COUNT_LONG_OFF = 512;
const ENGINE_STORED_POS_COUNT_SHORT_OFF = 520;
const ENGINE_STALE_ACCOUNT_COUNT_LONG_OFF = 528;
const ENGINE_STALE_ACCOUNT_COUNT_SHORT_OFF = 536;
const ENGINE_PHANTOM_DUST_CERT_LONG_OFF = 544;        // u128
const ENGINE_PHANTOM_DUST_CERT_SHORT_OFF = 560;       // u128
const ENGINE_PHANTOM_DUST_POT_LONG_OFF = 576;         // u128 (NEW: split from single field)
const ENGINE_PHANTOM_DUST_POT_SHORT_OFF = 592;        // u128
const ENGINE_B_LONG_NUM_OFF = 608;                    // u128 (B-index)
const ENGINE_B_SHORT_NUM_OFF = 624;
const ENGINE_B_EPOCH_START_LONG_NUM_OFF = 640;
const ENGINE_B_EPOCH_START_SHORT_NUM_OFF = 656;
const ENGINE_LOSS_WEIGHT_SUM_LONG_OFF = 672;
const ENGINE_LOSS_WEIGHT_SUM_SHORT_OFF = 688;
const ENGINE_SOCIAL_LOSS_REM_LONG_OFF = 704;
const ENGINE_SOCIAL_LOSS_REM_SHORT_OFF = 720;
const ENGINE_SOCIAL_LOSS_DUST_LONG_OFF = 736;
const ENGINE_SOCIAL_LOSS_DUST_SHORT_OFF = 752;
const ENGINE_EXPLICIT_UNALLOC_LONG_OFF = 768;         // U128
const ENGINE_EXPLICIT_UNALLOC_SHORT_OFF = 784;
const ENGINE_EXPLICIT_UNALLOC_PROTO_OFF = 800;
const ENGINE_EXPLICIT_UNALLOC_SATURATED_OFF = 816;    // u8
const ENGINE_MATERIALIZED_ACCOUNT_COUNT_OFF = 824;
const ENGINE_NEG_PNL_ACCOUNT_COUNT_OFF = 832;
const ENGINE_RR_CURSOR_POSITION_OFF = 840;
const ENGINE_SWEEP_GENERATION_OFF = 848;
const ENGINE_STRESS_CONSUMED_OFF = 856;               // u128
const ENGINE_STRESS_REMAINING_INDICES_OFF = 872;
const ENGINE_STRESS_ENV_START_SLOT_OFF = 880;
const ENGINE_STRESS_ENV_START_GEN_OFF = 888;
const ENGINE_LAST_SWEEP_GEN_ADVANCE_SLOT_OFF = 896;
const ENGINE_BANKRUPTCY_HMAX_LOCK_OFF = 904;          // bool (u8)
const ENGINE_ACTIVE_CLOSE_PRESENT_OFF = 905;
const ENGINE_ACTIVE_CLOSE_PHASE_OFF = 906;
const ENGINE_ACTIVE_CLOSE_ACCOUNT_IDX_OFF = 908;      // u16
const ENGINE_ACTIVE_CLOSE_OPP_SIDE_OFF = 910;         // u8
const ENGINE_ACTIVE_CLOSE_PRICE_OFF = 912;
const ENGINE_ACTIVE_CLOSE_SLOT_OFF = 920;
const ENGINE_ACTIVE_CLOSE_Q_OFF = 928;                // u128
const ENGINE_ACTIVE_CLOSE_RES_REM_OFF = 944;
const ENGINE_ACTIVE_CLOSE_RES_BOOKED_OFF = 960;
const ENGINE_ACTIVE_CLOSE_RES_RECORDED_OFF = 976;
const ENGINE_ACTIVE_CLOSE_B_CHUNKS_OFF = 992;
const ENGINE_LAST_ORACLE_PRICE_OFF = 1000;
const ENGINE_FUND_PX_LAST_OFF = 1008;
const ENGINE_LAST_MARKET_SLOT_OFF = 1016;
const ENGINE_F_LONG_NUM_OFF = 1024;
const ENGINE_F_SHORT_NUM_OFF = 1040;
const ENGINE_F_EPOCH_START_LONG_NUM_OFF = 1056;
const ENGINE_F_EPOCH_START_SHORT_NUM_OFF = 1072;
const ENGINE_BITMAP_OFF = 1088;                       // used: [u64; BITMAP_WORDS]

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
  liquidationFeeBps: bigint;
  liquidationFeeCap: bigint;
  minLiquidationAbs: bigint;
  minNonzeroMmReq: bigint;
  minNonzeroImReq: bigint;
  hMin: bigint;
  hMax: bigint;
  resolvePriceDeviationBps: bigint;
  maxAccrualDtSlots: bigint;
  maxAbsFundingE9PerSlot: bigint;
  minFundingLifetimeSlots: bigint;
  maxActivePositionsPerSide: bigint;
  maxPriceMoveBpsPerSlot: bigint;       // v12.21+
}

export enum SideMode { Normal = 0, DrainOnly = 1, ResetPending = 2 }
export enum MarketMode { Live = 0, Resolved = 1 }

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
  cTot: bigint;
  pnlPosTot: bigint;
  pnlMaturedPosTot: bigint;
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
  // Phantom dust split into certified-can-clear-OI vs potential-only
  phantomDustCertifiedLongQ: bigint;
  phantomDustCertifiedShortQ: bigint;
  phantomDustPotentialLongQ: bigint;
  phantomDustPotentialShortQ: bigint;
  // B-index residual state (account-local bankruptcy)
  bLongNum: bigint;
  bShortNum: bigint;
  bEpochStartLongNum: bigint;
  bEpochStartShortNum: bigint;
  lossWeightSumLong: bigint;
  lossWeightSumShort: bigint;
  socialLossRemainderLongNum: bigint;
  socialLossRemainderShortNum: bigint;
  socialLossDustLongNum: bigint;
  socialLossDustShortNum: bigint;
  explicitUnallocatedLossLong: bigint;
  explicitUnallocatedLossShort: bigint;
  explicitUnallocatedProtocolLoss: bigint;
  explicitUnallocatedLossSaturated: number;
  // Counts (relocated post-B-index block)
  materializedAccountCount: bigint;
  negPnlAccountCount: bigint;
  // Sweep cursor + stress envelope
  rrCursorPosition: bigint;
  sweepGeneration: bigint;
  stressConsumedBpsE9SinceEnvelope: bigint;
  stressEnvelopeRemainingIndices: bigint;
  stressEnvelopeStartSlot: bigint;
  stressEnvelopeStartGeneration: bigint;
  lastSweepGenerationAdvanceSlot: bigint;
  bankruptcyHmaxLockActive: number;
  // Active full-close continuation
  activeClosePresent: number;
  activeClosePhase: number;
  activeCloseAccountIdx: number;
  activeCloseOppSide: number;
  activeCloseClosePrice: bigint;
  activeCloseCloseSlot: bigint;
  activeCloseQCloseQ: bigint;
  activeCloseResidualRemaining: bigint;
  activeCloseResidualBooked: bigint;
  activeCloseResidualRecorded: bigint;
  activeCloseBChunksBooked: bigint;
  // Oracle + funding
  lastOraclePrice: bigint;
  fundPxLast: bigint;
  lastMarketSlot: bigint;
  fLongNum: bigint;
  fShortNum: bigint;
  fEpochStartLongNum: bigint;
  fEpochStartShortNum: bigint;
  // Slab management
  numUsedAccounts: number;
  freeHead: number;
}

export enum AccountKind { User = 0, LP = 1 }

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
  // B-index account-local bankruptcy state (NEW)
  lossWeight: bigint;
  bSnap: bigint;
  bRem: bigint;
  bEpochSnap: bigint;
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
// Layout table — MAX_ACCOUNTS-dependent fields
// =============================================================================
export interface SlabLayout {
  maxAccounts: number;
  bitmapWords: number;
  slabLen: number;
  engineOff: number;
  engineNumUsedOff: number;
  engineFreeHeadOff: number;
  engineAccountsOff: number;
  accountSize: number;
  paramsSize: number;
}

function computeLayout(maxAccounts: number): SlabLayout {
  const bitmapWords = Math.ceil(maxAccounts / 64);
  const usedOff = ENGINE_BITMAP_OFF; // 1088 (MA-independent under v12.21+)
  const bitmapBytes = bitmapWords * 8;
  const numUsedOff = usedOff + bitmapBytes;
  const freeHeadOff = numUsedOff + 2;
  const nextFreeOff = freeHeadOff + 2;
  const prevFreeOff = nextFreeOff + maxAccounts * 2;
  const afterPrev = prevFreeOff + maxAccounts * 2;
  // Align to 8 — Account's largest member is u128 which is 8-aligned on
  // BPF. Confirmed by offset_of!(RiskEngine, accounts) = 17992 at
  // MAX_ACCOUNTS=4096 (afterPrev = 17988 → +4 padding → 17992).
  const accountsOff = (afterPrev + 7) & ~7;
  const engineLen = accountsOff + maxAccounts * ACCOUNT_SIZE;
  const riskBufLen = 160;
  const genTableLen = maxAccounts * 8;
  const slabLen = ENGINE_OFF + engineLen + riskBufLen + genTableLen;
  return {
    maxAccounts, bitmapWords, slabLen,
    engineOff: ENGINE_OFF, engineNumUsedOff: numUsedOff, engineFreeHeadOff: freeHeadOff,
    engineAccountsOff: accountsOff, accountSize: ACCOUNT_SIZE, paramsSize: PARAMS_SIZE,
  };
}

export function layoutForDataLength(dataLen: number): SlabLayout {
  const candidates = [64, 256, 1024, 4096].map(computeLayout);
  for (const l of candidates) {
    if (l.slabLen === dataLen) return l;
  }
  // Silent fallback to 4096 used to mask layout drift: every downstream
  // parser would read from wrong offsets and return plausible-looking
  // garbage (the v1 mainnet slab → v12.21 wrapper break is the canonical
  // example). Fail loud instead.
  const expected = candidates.map(l => `${l.maxAccounts}=>${l.slabLen}`).join(", ");
  throw new Error(
    `slab data length ${dataLen} matches no known capacity (expected one of ${expected})`
  );
}

// =============================================================================
// Readers
// =============================================================================
function readI128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  const u = (hi << 64n) | lo;
  const SIGN = 1n << 127n;
  return u >= SIGN ? u - (1n << 128n) : u;
}
function readU128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigUInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

export function parseParams(data: Buffer): RiskParams {
  const base = ENGINE_OFF + ENGINE_PARAMS_OFF;
  if (data.length < base + PARAMS_SIZE) throw new Error("Slab data too short for RiskParams");
  return {
    maintenanceMarginBps: data.readBigUInt64LE(base + PARAMS_MAINTENANCE_MARGIN_OFF),
    initialMarginBps: data.readBigUInt64LE(base + PARAMS_INITIAL_MARGIN_OFF),
    tradingFeeBps: data.readBigUInt64LE(base + PARAMS_TRADING_FEE_OFF),
    maxAccounts: data.readBigUInt64LE(base + PARAMS_MAX_ACCOUNTS_OFF),
    liquidationFeeBps: data.readBigUInt64LE(base + PARAMS_LIQUIDATION_FEE_BPS_OFF),
    liquidationFeeCap: readU128LE(data, base + PARAMS_LIQUIDATION_FEE_CAP_OFF),
    minLiquidationAbs: readU128LE(data, base + PARAMS_MIN_LIQUIDATION_OFF),
    minNonzeroMmReq: readU128LE(data, base + PARAMS_MIN_NONZERO_MM_REQ_OFF),
    minNonzeroImReq: readU128LE(data, base + PARAMS_MIN_NONZERO_IM_REQ_OFF),
    hMin: data.readBigUInt64LE(base + PARAMS_H_MIN_OFF),
    hMax: data.readBigUInt64LE(base + PARAMS_H_MAX_OFF),
    resolvePriceDeviationBps: data.readBigUInt64LE(base + PARAMS_RESOLVE_PRICE_DEVIATION_OFF),
    maxAccrualDtSlots: data.readBigUInt64LE(base + PARAMS_MAX_ACCRUAL_DT_OFF),
    maxAbsFundingE9PerSlot: data.readBigUInt64LE(base + PARAMS_MAX_ABS_FUNDING_OFF),
    minFundingLifetimeSlots: data.readBigUInt64LE(base + PARAMS_MIN_FUNDING_LIFETIME_OFF),
    maxActivePositionsPerSide: data.readBigUInt64LE(base + PARAMS_MAX_ACTIVE_POSITIONS_OFF),
    maxPriceMoveBpsPerSlot: data.readBigUInt64LE(base + PARAMS_MAX_PRICE_MOVE_OFF),
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
    cTot: readU128LE(data, base + ENGINE_C_TOT_OFF),
    pnlPosTot: readU128LE(data, base + ENGINE_PNL_POS_TOT_OFF),
    pnlMaturedPosTot: readU128LE(data, base + ENGINE_PNL_MATURED_POS_TOT_OFF),
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
    phantomDustCertifiedLongQ: readU128LE(data, base + ENGINE_PHANTOM_DUST_CERT_LONG_OFF),
    phantomDustCertifiedShortQ: readU128LE(data, base + ENGINE_PHANTOM_DUST_CERT_SHORT_OFF),
    phantomDustPotentialLongQ: readU128LE(data, base + ENGINE_PHANTOM_DUST_POT_LONG_OFF),
    phantomDustPotentialShortQ: readU128LE(data, base + ENGINE_PHANTOM_DUST_POT_SHORT_OFF),
    bLongNum: readU128LE(data, base + ENGINE_B_LONG_NUM_OFF),
    bShortNum: readU128LE(data, base + ENGINE_B_SHORT_NUM_OFF),
    bEpochStartLongNum: readU128LE(data, base + ENGINE_B_EPOCH_START_LONG_NUM_OFF),
    bEpochStartShortNum: readU128LE(data, base + ENGINE_B_EPOCH_START_SHORT_NUM_OFF),
    lossWeightSumLong: readU128LE(data, base + ENGINE_LOSS_WEIGHT_SUM_LONG_OFF),
    lossWeightSumShort: readU128LE(data, base + ENGINE_LOSS_WEIGHT_SUM_SHORT_OFF),
    socialLossRemainderLongNum: readU128LE(data, base + ENGINE_SOCIAL_LOSS_REM_LONG_OFF),
    socialLossRemainderShortNum: readU128LE(data, base + ENGINE_SOCIAL_LOSS_REM_SHORT_OFF),
    socialLossDustLongNum: readU128LE(data, base + ENGINE_SOCIAL_LOSS_DUST_LONG_OFF),
    socialLossDustShortNum: readU128LE(data, base + ENGINE_SOCIAL_LOSS_DUST_SHORT_OFF),
    explicitUnallocatedLossLong: readU128LE(data, base + ENGINE_EXPLICIT_UNALLOC_LONG_OFF),
    explicitUnallocatedLossShort: readU128LE(data, base + ENGINE_EXPLICIT_UNALLOC_SHORT_OFF),
    explicitUnallocatedProtocolLoss: readU128LE(data, base + ENGINE_EXPLICIT_UNALLOC_PROTO_OFF),
    explicitUnallocatedLossSaturated: data.readUInt8(base + ENGINE_EXPLICIT_UNALLOC_SATURATED_OFF),
    materializedAccountCount: data.readBigUInt64LE(base + ENGINE_MATERIALIZED_ACCOUNT_COUNT_OFF),
    negPnlAccountCount: data.readBigUInt64LE(base + ENGINE_NEG_PNL_ACCOUNT_COUNT_OFF),
    rrCursorPosition: data.readBigUInt64LE(base + ENGINE_RR_CURSOR_POSITION_OFF),
    sweepGeneration: data.readBigUInt64LE(base + ENGINE_SWEEP_GENERATION_OFF),
    stressConsumedBpsE9SinceEnvelope: readU128LE(data, base + ENGINE_STRESS_CONSUMED_OFF),
    stressEnvelopeRemainingIndices: data.readBigUInt64LE(base + ENGINE_STRESS_REMAINING_INDICES_OFF),
    stressEnvelopeStartSlot: data.readBigUInt64LE(base + ENGINE_STRESS_ENV_START_SLOT_OFF),
    stressEnvelopeStartGeneration: data.readBigUInt64LE(base + ENGINE_STRESS_ENV_START_GEN_OFF),
    lastSweepGenerationAdvanceSlot: data.readBigUInt64LE(base + ENGINE_LAST_SWEEP_GEN_ADVANCE_SLOT_OFF),
    bankruptcyHmaxLockActive: data.readUInt8(base + ENGINE_BANKRUPTCY_HMAX_LOCK_OFF),
    activeClosePresent: data.readUInt8(base + ENGINE_ACTIVE_CLOSE_PRESENT_OFF),
    activeClosePhase: data.readUInt8(base + ENGINE_ACTIVE_CLOSE_PHASE_OFF),
    activeCloseAccountIdx: data.readUInt16LE(base + ENGINE_ACTIVE_CLOSE_ACCOUNT_IDX_OFF),
    activeCloseOppSide: data.readUInt8(base + ENGINE_ACTIVE_CLOSE_OPP_SIDE_OFF),
    activeCloseClosePrice: data.readBigUInt64LE(base + ENGINE_ACTIVE_CLOSE_PRICE_OFF),
    activeCloseCloseSlot: data.readBigUInt64LE(base + ENGINE_ACTIVE_CLOSE_SLOT_OFF),
    activeCloseQCloseQ: readU128LE(data, base + ENGINE_ACTIVE_CLOSE_Q_OFF),
    activeCloseResidualRemaining: readU128LE(data, base + ENGINE_ACTIVE_CLOSE_RES_REM_OFF),
    activeCloseResidualBooked: readU128LE(data, base + ENGINE_ACTIVE_CLOSE_RES_BOOKED_OFF),
    activeCloseResidualRecorded: readU128LE(data, base + ENGINE_ACTIVE_CLOSE_RES_RECORDED_OFF),
    activeCloseBChunksBooked: data.readBigUInt64LE(base + ENGINE_ACTIVE_CLOSE_B_CHUNKS_OFF),
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
  return ((data.readBigUInt64LE(base + word * 8) >> BigInt(bit)) & 1n) !== 0n;
}

export function maxAccountIndex(dataLen: number): number {
  return layoutForDataLength(dataLen).maxAccounts;
}

export function parseAccount(data: Buffer, idx: number): Account {
  const layout = layoutForDataLength(data.length);
  if (idx < 0 || idx >= layout.maxAccounts) {
    throw new Error(`Account index out of range: ${idx} (max: ${layout.maxAccounts - 1})`);
  }
  const base = ENGINE_OFF + layout.engineAccountsOff + idx * ACCOUNT_SIZE;
  if (data.length < base + ACCOUNT_SIZE) throw new Error("Slab data too short for account");
  const kindByte = data.readUInt8(base + ACCT_KIND_OFF);
  return {
    kind: kindByte === 1 ? AccountKind.LP : AccountKind.User,
    capital: readU128LE(data, base + ACCT_CAPITAL_OFF),
    pnl: readI128LE(data, base + ACCT_PNL_OFF),
    reservedPnl: readU128LE(data, base + ACCT_RESERVED_PNL_OFF),
    positionBasisQ: readI128LE(data, base + ACCT_POSITION_BASIS_Q_OFF),
    adlABasis: readU128LE(data, base + ACCT_ADL_A_BASIS_OFF),
    adlKSnap: readI128LE(data, base + ACCT_ADL_K_SNAP_OFF),
    fSnap: readI128LE(data, base + ACCT_F_SNAP_OFF),
    adlEpochSnap: data.readBigUInt64LE(base + ACCT_ADL_EPOCH_SNAP_OFF),
    lossWeight: readU128LE(data, base + ACCT_LOSS_WEIGHT_OFF),
    bSnap: readU128LE(data, base + ACCT_B_SNAP_OFF),
    bRem: readU128LE(data, base + ACCT_B_REM_OFF),
    bEpochSnap: data.readBigUInt64LE(base + ACCT_B_EPOCH_SNAP_OFF),
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
  return indices.filter(idx => idx < maxIdx).map(idx => ({ idx, account: parseAccount(data, idx) }));
}
