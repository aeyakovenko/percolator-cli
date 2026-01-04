import { Connection, PublicKey } from "@solana/web3.js";

// Constants from Rust
const MAGIC: bigint = 0x504552434f4c4154n; // "PERCOLAT"
const HEADER_LEN = 64;
const CONFIG_OFFSET = HEADER_LEN;
const RESERVED_OFF = 48;

/**
 * Slab header (64 bytes)
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
 * Market config (90 bytes, starts at offset 64)
 */
export interface MarketConfig {
  collateralMint: PublicKey;
  vaultPubkey: PublicKey;
  collateralOracle: PublicKey;
  indexOracle: PublicKey;
  maxStalenessSlots: bigint;
  confFilterBps: number;
  vaultAuthorityBump: number;
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
 * Parse market config (starts at byte 64, 90 bytes).
 */
export function parseConfig(data: Buffer): MarketConfig {
  const minLen = CONFIG_OFFSET + 90;
  if (data.length < minLen) {
    throw new Error(`Slab data too short for config: ${data.length} < ${minLen}`);
  }

  let off = CONFIG_OFFSET;

  const collateralMint = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const vaultPubkey = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const collateralOracle = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const indexOracle = new PublicKey(data.subarray(off, off + 32));
  off += 32;

  const maxStalenessSlots = data.readBigUInt64LE(off);
  off += 8;

  const confFilterBps = data.readUInt16LE(off);
  off += 2;

  const vaultAuthorityBump = data.readUInt8(off);

  return {
    collateralMint,
    vaultPubkey,
    collateralOracle,
    indexOracle,
    maxStalenessSlots,
    confFilterBps,
    vaultAuthorityBump,
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
// RiskEngine Layout Constants (from cargo test test_struct_sizes)
// =============================================================================
const ENGINE_OFF = 208;
const ENGINE_VAULT_OFF = 0;
const ENGINE_INSURANCE_OFF = 16;
const ENGINE_PARAMS_OFF = 48;
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
// ADL scratch arrays follow, then bitmap and accounts
const ENGINE_BITMAP_OFF = 70032;
const ENGINE_NUM_USED_OFF = 70544;
const ENGINE_NEXT_ACCOUNT_ID_OFF = 70552;
const ENGINE_ACCOUNTS_OFF = 78768;

const BITMAP_WORDS = 64;
const MAX_ACCOUNTS = 4096;
const ACCOUNT_SIZE = 272;

// =============================================================================
// RiskParams Layout (144 bytes, repr(C))
// =============================================================================
const PARAMS_WARMUP_PERIOD_OFF = 0;
const PARAMS_MAINTENANCE_MARGIN_OFF = 8;
const PARAMS_INITIAL_MARGIN_OFF = 16;
const PARAMS_TRADING_FEE_OFF = 24;
const PARAMS_MAX_ACCOUNTS_OFF = 32;
const PARAMS_NEW_ACCOUNT_FEE_OFF = 40;
const PARAMS_RISK_THRESHOLD_OFF = 56;
const PARAMS_MAINTENANCE_FEE_OFF = 72;
const PARAMS_MAX_CRANK_STALENESS_OFF = 88;
const PARAMS_LIQUIDATION_FEE_BPS_OFF = 96;
const PARAMS_LIQUIDATION_FEE_CAP_OFF = 104;
const PARAMS_LIQUIDATION_BUFFER_OFF = 120;
const PARAMS_MIN_LIQUIDATION_OFF = 128;

// =============================================================================
// Account Layout (272 bytes, repr(C))
// =============================================================================
const ACCT_KIND_OFF = 0;
const ACCT_ACCOUNT_ID_OFF = 8;
const ACCT_CAPITAL_OFF = 16;
const ACCT_PNL_OFF = 32;
const ACCT_RESERVED_PNL_OFF = 48;
const ACCT_WARMUP_STARTED_OFF = 64;
const ACCT_WARMUP_SLOPE_OFF = 80;
const ACCT_POSITION_SIZE_OFF = 96;
const ACCT_ENTRY_PRICE_OFF = 112;
const ACCT_FUNDING_INDEX_OFF = 128;
const ACCT_MATCHER_PROGRAM_OFF = 144;
const ACCT_MATCHER_CONTEXT_OFF = 176;
const ACCT_OWNER_OFF = 208;
const ACCT_FEE_CREDITS_OFF = 240;
const ACCT_LAST_FEE_SLOT_OFF = 256;

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
  matcherContext: PublicKey;
  owner: PublicKey;
  feeCredits: bigint;
  lastFeeSlot: bigint;
}

// =============================================================================
// Helper: read signed i128 from buffer
// =============================================================================
function readI128LE(buf: Buffer, offset: number): bigint {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigInt64LE(offset + 8);
  return (hi << 64n) | lo;
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
 */
export function parseParams(data: Buffer): RiskParams {
  const base = ENGINE_OFF + ENGINE_PARAMS_OFF;
  if (data.length < base + 144) {
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
