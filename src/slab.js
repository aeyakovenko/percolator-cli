"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountKind = void 0;
exports.fetchSlab = fetchSlab;
exports.parseHeader = parseHeader;
exports.parseConfig = parseConfig;
exports.readNonce = readNonce;
exports.readLastThrUpdateSlot = readLastThrUpdateSlot;
exports.parseParams = parseParams;
exports.parseEngine = parseEngine;
exports.parseUsedIndices = parseUsedIndices;
exports.isAccountUsed = isAccountUsed;
exports.maxAccountIndex = maxAccountIndex;
exports.parseAccount = parseAccount;
exports.parseAllAccounts = parseAllAccounts;
var web3_js_1 = require("@solana/web3.js");
// Constants from Rust (updated for funding/threshold params 2026-01)
var MAGIC = 0x504552434f4c4154n; // "PERCOLAT"
var HEADER_LEN = 72; // SlabHeader: magic(8) + version(4) + bump(1) + _padding(3) + admin(32) + _reserved(24)
var CONFIG_OFFSET = HEADER_LEN; // MarketConfig starts right after header
// MarketConfig: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32) + max_staleness_secs(8) +
//               conf_filter_bps(2) + bump(1) + invert(1) + unit_scale(4) +
//               funding_horizon_slots(8) + funding_k_bps(8) + funding_inv_scale_notional_e6(16) +
//               funding_max_premium_bps(8) + funding_max_bps_per_slot(8) +
//               thresh_floor(16) + thresh_risk_bps(8) + thresh_update_interval_slots(8) +
//               thresh_step_bps(8) + thresh_alpha_bps(8) + thresh_min(16) + thresh_max(16) + thresh_min_step(16)
var CONFIG_LEN = 256;
var RESERVED_OFF = 48; // Offset of _reserved field within SlabHeader
/**
 * Fetch raw slab account data.
 */
function fetchSlab(connection, slabPubkey) {
    return __awaiter(this, void 0, void 0, function () {
        var info;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, connection.getAccountInfo(slabPubkey)];
                case 1:
                    info = _a.sent();
                    if (!info) {
                        throw new Error("Slab account not found: ".concat(slabPubkey.toBase58()));
                    }
                    return [2 /*return*/, Buffer.from(info.data)];
            }
        });
    });
}
/**
 * Parse slab header (first 64 bytes).
 */
function parseHeader(data) {
    if (data.length < HEADER_LEN) {
        throw new Error("Slab data too short for header: ".concat(data.length, " < ").concat(HEADER_LEN));
    }
    var magic = data.readBigUInt64LE(0);
    if (magic !== MAGIC) {
        throw new Error("Invalid slab magic: expected ".concat(MAGIC.toString(16), ", got ").concat(magic.toString(16)));
    }
    var version = data.readUInt32LE(8);
    var bump = data.readUInt8(12);
    var admin = new web3_js_1.PublicKey(data.subarray(16, 48));
    // Reserved field: nonce at [0..8], lastThrUpdateSlot at [8..16]
    var nonce = data.readBigUInt64LE(RESERVED_OFF);
    var lastThrUpdateSlot = data.readBigUInt64LE(RESERVED_OFF + 8);
    return {
        magic: magic,
        version: version,
        bump: bump,
        admin: admin,
        nonce: nonce,
        lastThrUpdateSlot: lastThrUpdateSlot,
    };
}
/**
 * Parse market config (starts at byte 72).
 * Layout: collateral_mint(32) + vault_pubkey(32) + index_feed_id(32)
 *         + max_staleness_secs(8) + conf_filter_bps(2) + vault_authority_bump(1) + invert(1) + unit_scale(4)
 */
function parseConfig(data) {
    var minLen = CONFIG_OFFSET + CONFIG_LEN;
    if (data.length < minLen) {
        throw new Error("Slab data too short for config: ".concat(data.length, " < ").concat(minLen));
    }
    var off = CONFIG_OFFSET;
    var collateralMint = new web3_js_1.PublicKey(data.subarray(off, off + 32));
    off += 32;
    var vaultPubkey = new web3_js_1.PublicKey(data.subarray(off, off + 32));
    off += 32;
    // index_feed_id (32 bytes) - Pyth feed ID, stored as 32 bytes
    var indexFeedId = new web3_js_1.PublicKey(data.subarray(off, off + 32));
    off += 32;
    var maxStalenessSlots = data.readBigUInt64LE(off);
    off += 8;
    var confFilterBps = data.readUInt16LE(off);
    off += 2;
    var vaultAuthorityBump = data.readUInt8(off);
    off += 1;
    var invert = data.readUInt8(off);
    off += 1;
    var unitScale = data.readUInt32LE(off);
    off += 4;
    // Funding rate parameters
    var fundingHorizonSlots = data.readBigUInt64LE(off);
    off += 8;
    var fundingKBps = data.readBigUInt64LE(off);
    off += 8;
    var fundingInvScaleNotionalE6 = readI128LE(data, off);
    off += 16;
    var fundingMaxPremiumBps = data.readBigUInt64LE(off);
    off += 8;
    var fundingMaxBpsPerSlot = data.readBigUInt64LE(off);
    return {
        collateralMint: collateralMint,
        vaultPubkey: vaultPubkey,
        indexFeedId: indexFeedId,
        maxStalenessSlots: maxStalenessSlots,
        confFilterBps: confFilterBps,
        vaultAuthorityBump: vaultAuthorityBump,
        invert: invert,
        unitScale: unitScale,
        fundingHorizonSlots: fundingHorizonSlots,
        fundingKBps: fundingKBps,
        fundingInvScaleNotionalE6: fundingInvScaleNotionalE6,
        fundingMaxPremiumBps: fundingMaxPremiumBps,
        fundingMaxBpsPerSlot: fundingMaxBpsPerSlot,
    };
}
/**
 * Read nonce from slab header reserved field.
 */
function readNonce(data) {
    if (data.length < RESERVED_OFF + 8) {
        throw new Error("Slab data too short for nonce");
    }
    return data.readBigUInt64LE(RESERVED_OFF);
}
/**
 * Read last threshold update slot from slab header reserved field.
 */
function readLastThrUpdateSlot(data) {
    if (data.length < RESERVED_OFF + 16) {
        throw new Error("Slab data too short for lastThrUpdateSlot");
    }
    return data.readBigUInt64LE(RESERVED_OFF + 8);
}
// =============================================================================
// RiskEngine Layout Constants (updated for funding/threshold params 2026-01)
// ENGINE_OFF = HEADER_LEN + CONFIG_LEN = 72 + 256 = 328
// =============================================================================
var ENGINE_OFF = 328;
// RiskEngine struct layout (repr(C), SBF uses 8-byte alignment for u128):
// - vault: u128 (16 bytes) at offset 0
// - insurance_fund: InsuranceFund { balance: u128, fee_revenue: u128 } (32 bytes) at offset 16
// - params: RiskParams (144 bytes) at offset 48
var ENGINE_VAULT_OFF = 0;
var ENGINE_INSURANCE_OFF = 16;
var ENGINE_PARAMS_OFF = 48; // RiskParams starts here (after vault+insurance_fund)
// After RiskParams (at engine offset 48 + 144 = 192):
var ENGINE_CURRENT_SLOT_OFF = 192;
var ENGINE_FUNDING_INDEX_OFF = 200;
var ENGINE_LAST_FUNDING_SLOT_OFF = 216;
var ENGINE_LOSS_ACCUM_OFF = 224;
var ENGINE_RISK_REDUCTION_ONLY_OFF = 240;
var ENGINE_RISK_REDUCTION_WITHDRAWN_OFF = 248;
var ENGINE_WARMUP_PAUSED_OFF = 264;
var ENGINE_WARMUP_PAUSE_SLOT_OFF = 272;
var ENGINE_LAST_CRANK_SLOT_OFF = 280;
var ENGINE_MAX_CRANK_STALENESS_OFF = 288;
var ENGINE_TOTAL_OI_OFF = 296;
var ENGINE_WARMED_POS_OFF = 312;
var ENGINE_WARMED_NEG_OFF = 328;
var ENGINE_WARMUP_INSURANCE_OFF = 344;
// ADL scratch arrays and deferred socialization buckets span ~86K bytes
// See RiskEngine struct for full layout: adl_remainder_scratch, adl_idx_scratch,
// adl_exclude_scratch, pending_*, liq_cursor, gc_cursor, then sweep/crank fields
// Offsets computed backwards from ENGINE_BITMAP_OFF = 86520:
var ENGINE_LAST_SWEEP_START_OFF = 86416; // last_full_sweep_start_slot: u64
var ENGINE_LAST_SWEEP_COMPLETE_OFF = 86424; // last_full_sweep_completed_slot: u64
var ENGINE_CRANK_STEP_OFF = 86432; // crank_step: u8 (+ 7 bytes padding)
var ENGINE_LIFETIME_LIQUIDATIONS_OFF = 86440; // lifetime_liquidations: u64
var ENGINE_LIFETIME_FORCE_CLOSES_OFF = 86448; // lifetime_force_realize_closes: u64
// LP Aggregates for funding rate calculation
var ENGINE_NET_LP_POS_OFF = 86456; // net_lp_pos: i128 (sum of LP positions)
var ENGINE_LP_SUM_ABS_OFF = 86472; // lp_sum_abs: u128
var ENGINE_LP_MAX_ABS_OFF = 86488; // lp_max_abs: u128
var ENGINE_LP_MAX_ABS_SWEEP_OFF = 86504; // lp_max_abs_sweep: u128
// Verified via find-bitmap.ts against devnet 2026-01 (after RiskEngine grew by 4096 bytes):
// - Created LP and found: bitmap=1 (bit 0 set), numUsed=1, nextAccountId=6
// - bitmap (u64=1) at slab 86848 = engine 86520
// - numUsed (u16=1) at slab 87360 = engine 87032
// - nextAccountId (u64) at slab 87368 = engine 87040
// - accounts start at slab 95584 = engine 95256 (owner pubkeys verified)
var ENGINE_BITMAP_OFF = 86520; // slab 86848 = 328 + 86520 (bitmap word 0)
var ENGINE_NUM_USED_OFF = 87032; // slab 87360 = 328 + 87032 (u16)
var ENGINE_NEXT_ACCOUNT_ID_OFF = 87040; // slab 87368 = 328 + 87040 (u64)
var ENGINE_ACCOUNTS_OFF = 95256; // slab 95584 = 328 + 95256
var BITMAP_WORDS = 64;
var MAX_ACCOUNTS = 4096;
var ACCOUNT_SIZE = 248; // Empirically verified (was 272, but actual SBF layout is 248)
// =============================================================================
// RiskParams Layout (144 bytes, repr(C) with 8-byte alignment on SBF)
// Note: SBF target uses 8-byte alignment for u128, not 16-byte
// Verified via verify-layout.cjs against devnet 2024-01
// =============================================================================
var PARAMS_WARMUP_PERIOD_OFF = 0; // u64
var PARAMS_MAINTENANCE_MARGIN_OFF = 8; // u64
var PARAMS_INITIAL_MARGIN_OFF = 16; // u64
var PARAMS_TRADING_FEE_OFF = 24; // u64
var PARAMS_MAX_ACCOUNTS_OFF = 32; // u64
var PARAMS_NEW_ACCOUNT_FEE_OFF = 40; // u128 (no padding, 8-byte aligned)
var PARAMS_RISK_THRESHOLD_OFF = 56; // u128
var PARAMS_MAINTENANCE_FEE_OFF = 72; // u128
var PARAMS_MAX_CRANK_STALENESS_OFF = 88; // u64
var PARAMS_LIQUIDATION_FEE_BPS_OFF = 96; // u64
var PARAMS_LIQUIDATION_FEE_CAP_OFF = 104; // u128
var PARAMS_LIQUIDATION_BUFFER_OFF = 120; // u64
var PARAMS_MIN_LIQUIDATION_OFF = 128; // u128 (total = 144 bytes)
// =============================================================================
// Account Layout (248 bytes, repr(C))
// NOTE: Despite U128/I128 wrapper types in Rust, on-chain layout remains unchanged
// Field order: account_id, capital, kind, pnl, reserved_pnl, warmup_started,
//              warmup_slope, position_size, entry_price, funding_index,
//              matcher_program, matcher_context, owner, fee_credits, last_fee_slot
// =============================================================================
var ACCT_ACCOUNT_ID_OFF = 0; // accountId (u64, 8 bytes), ends at 8
var ACCT_CAPITAL_OFF = 8; // capital (U128, 16 bytes), ends at 24
var ACCT_KIND_OFF = 24; // kind (u8, 1 byte + 7 padding), ends at 32
var ACCT_PNL_OFF = 32; // pnl (I128, 16 bytes), ends at 48
var ACCT_RESERVED_PNL_OFF = 48; // reserved_pnl (U128, 16 bytes), ends at 64
var ACCT_WARMUP_STARTED_OFF = 56; // warmup_started (u64, 8 bytes), ends at 64
var ACCT_WARMUP_SLOPE_OFF = 64; // warmup_slope (U128, 16 bytes), ends at 80
var ACCT_POSITION_SIZE_OFF = 80; // position_size (I128, 16 bytes), ends at 96
var ACCT_ENTRY_PRICE_OFF = 96; // entry_price (u64, 8 bytes), ends at 104
var ACCT_FUNDING_INDEX_OFF = 104; // funding_index (I128, 16 bytes), ends at 120
var ACCT_MATCHER_PROGRAM_OFF = 120; // matcher_program (Pubkey, 32 bytes), ends at 152
var ACCT_MATCHER_CONTEXT_OFF = 152; // matcher_context (Pubkey, 32 bytes), ends at 184
var ACCT_OWNER_OFF = 184; // owner (Pubkey, 32 bytes), ends at 216
var ACCT_FEE_CREDITS_OFF = 216; // fee_credits (I128, 16 bytes), ends at 232
var ACCT_LAST_FEE_SLOT_OFF = 232; // last_fee_slot (u64, 8 bytes), ends at 240
var AccountKind;
(function (AccountKind) {
    AccountKind[AccountKind["User"] = 0] = "User";
    AccountKind[AccountKind["LP"] = 1] = "LP";
})(AccountKind || (exports.AccountKind = AccountKind = {}));
// =============================================================================
// Helper: read signed i128 from buffer
// Match Rust's I128 wrapper: read both halves as unsigned, then interpret as signed
// =============================================================================
function readI128LE(buf, offset) {
    var lo = buf.readBigUInt64LE(offset);
    var hi = buf.readBigUInt64LE(offset + 8);
    var unsigned = (hi << 64n) | lo;
    // If high bit is set, convert to negative (two's complement)
    var SIGN_BIT = 1n << 127n;
    if (unsigned >= SIGN_BIT) {
        return unsigned - (1n << 128n);
    }
    return unsigned;
}
function readU128LE(buf, offset) {
    var lo = buf.readBigUInt64LE(offset);
    var hi = buf.readBigUInt64LE(offset + 8);
    return (hi << 64n) | lo;
}
// =============================================================================
// Parsing Functions
// =============================================================================
/**
 * Parse RiskParams from engine data.
 * Note: invert/unitScale are in MarketConfig, not RiskParams.
 */
function parseParams(data) {
    var base = ENGINE_OFF + ENGINE_PARAMS_OFF;
    if (data.length < base + 160) { // RiskParams is 160 bytes with repr(C) padding
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
function parseEngine(data) {
    var base = ENGINE_OFF;
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
function parseUsedIndices(data) {
    var base = ENGINE_OFF + ENGINE_BITMAP_OFF;
    if (data.length < base + BITMAP_WORDS * 8) {
        throw new Error("Slab data too short for bitmap");
    }
    var used = [];
    for (var word = 0; word < BITMAP_WORDS; word++) {
        var bits = data.readBigUInt64LE(base + word * 8);
        if (bits === 0n)
            continue;
        for (var bit = 0; bit < 64; bit++) {
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
function isAccountUsed(data, idx) {
    if (idx < 0 || idx >= MAX_ACCOUNTS)
        return false;
    var base = ENGINE_OFF + ENGINE_BITMAP_OFF;
    var word = Math.floor(idx / 64);
    var bit = idx % 64;
    var bits = data.readBigUInt64LE(base + word * 8);
    return ((bits >> BigInt(bit)) & 1n) !== 0n;
}
/**
 * Calculate the maximum valid account index for a given slab size.
 */
function maxAccountIndex(dataLen) {
    var accountsEnd = dataLen - ENGINE_OFF - ENGINE_ACCOUNTS_OFF;
    if (accountsEnd <= 0)
        return 0;
    return Math.floor(accountsEnd / ACCOUNT_SIZE);
}
/**
 * Parse a single account by index.
 */
function parseAccount(data, idx) {
    var maxIdx = maxAccountIndex(data.length);
    if (idx < 0 || idx >= maxIdx) {
        throw new Error("Account index out of range: ".concat(idx, " (max: ").concat(maxIdx - 1, ")"));
    }
    var base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + idx * ACCOUNT_SIZE;
    if (data.length < base + ACCOUNT_SIZE) {
        throw new Error("Slab data too short for account");
    }
    // Detect LP accounts by checking if matcher_program is non-zero.
    // This is more robust than using the kind field because LPs always have
    // a matcher_program set during init_lp, while users never do.
    var matcherProgramBytes = data.subarray(base + ACCT_MATCHER_PROGRAM_OFF, base + ACCT_MATCHER_PROGRAM_OFF + 32);
    var isLp = !matcherProgramBytes.every(function (b) { return b === 0; });
    var kind = isLp ? AccountKind.LP : AccountKind.User;
    return {
        kind: kind,
        accountId: data.readBigUInt64LE(base + ACCT_ACCOUNT_ID_OFF),
        capital: readU128LE(data, base + ACCT_CAPITAL_OFF),
        pnl: readI128LE(data, base + ACCT_PNL_OFF),
        reservedPnl: data.readBigUInt64LE(base + ACCT_RESERVED_PNL_OFF), // u64
        warmupStartedAtSlot: data.readBigUInt64LE(base + ACCT_WARMUP_STARTED_OFF),
        warmupSlopePerStep: data.readBigUInt64LE(base + ACCT_WARMUP_SLOPE_OFF), // u64
        positionSize: readI128LE(data, base + ACCT_POSITION_SIZE_OFF),
        entryPrice: data.readBigUInt64LE(base + ACCT_ENTRY_PRICE_OFF),
        fundingIndex: readI128LE(data, base + ACCT_FUNDING_INDEX_OFF),
        matcherProgram: new web3_js_1.PublicKey(data.subarray(base + ACCT_MATCHER_PROGRAM_OFF, base + ACCT_MATCHER_PROGRAM_OFF + 32)),
        matcherContext: new web3_js_1.PublicKey(data.subarray(base + ACCT_MATCHER_CONTEXT_OFF, base + ACCT_MATCHER_CONTEXT_OFF + 32)),
        owner: new web3_js_1.PublicKey(data.subarray(base + ACCT_OWNER_OFF, base + ACCT_OWNER_OFF + 32)),
        feeCredits: readI128LE(data, base + ACCT_FEE_CREDITS_OFF),
        lastFeeSlot: data.readBigUInt64LE(base + ACCT_LAST_FEE_SLOT_OFF),
    };
}
/**
 * Parse all used accounts.
 * Filters out indices that would be beyond the slab's account storage capacity.
 */
function parseAllAccounts(data) {
    var indices = parseUsedIndices(data);
    var maxIdx = maxAccountIndex(data.length);
    var validIndices = indices.filter(function (idx) { return idx < maxIdx; });
    return validIndices.map(function (idx) { return ({
        idx: idx,
        account: parseAccount(data, idx),
    }); });
}
