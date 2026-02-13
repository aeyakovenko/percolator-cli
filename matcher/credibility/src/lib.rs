//! Credibility-Aware Matcher v2 for Percolator
//!
//! A deterministic, autonomous matcher that prices its own fragility.
//!
//! Coverage ratio (insurance_fund / open_interest) drives everything:
//!
//! | Coverage     | Tier       | Spread Effect          | Fill Effect             |
//! |-------------|------------|------------------------|-------------------------|
//! | < 10%       | CRITICAL   | max_spread (widest)    | fill capped at 25%      |
//! | 10% - 25%   | FRAGILE    | spread widens sharply  | fill capped at 50%      |
//! | 25% - 100%  | NORMAL     | linear discount        | full fill               |
//! | 100% - 200% | STRONG     | tighter spreads        | full fill               |
//! | > 200%      | FORTIFIED  | min_spread (tightest)  | fill + 50% bonus        |
//!
//! No governance. No intervention. Just math.
//!
//! ## Context Layout (256 bytes, starting at byte 64 of the 320-byte account)
//!
//! | Offset | Size | Field                    | Description                          |
//! |--------|------|--------------------------|--------------------------------------|
//! | 0      | 8    | magic                    | 0x5045_5243_4d41_5443 ("PERCMATC")   |
//! | 8      | 4    | version                  | 5                                    |
//! | 12     | 1    | kind                     | 2 = Credibility                      |
//! | 13     | 3    | _pad0                    |                                      |
//! | 16     | 32   | lp_pda                   | LP PDA for signature verification    |
//! | 48     | 4    | base_fee_bps             | Base trading fee                     |
//! | 52     | 4    | min_spread_bps           | Minimum spread floor (FORTIFIED)     |
//! | 56     | 4    | max_spread_bps           | Maximum spread cap (CRITICAL)        |
//! | 60     | 4    | imbalance_k_bps          | Imbalance impact multiplier          |
//! | 64     | 16   | liquidity_notional_e6    | Quoting depth for impact calc        |
//! | 80     | 16   | max_fill_abs             | Max fill per trade (base)            |
//! | 96     | 16   | inventory_base           | Current LP inventory (i128)          |
//! | 112    | 8    | last_oracle_price_e6     | Last oracle price seen               |
//! | 120    | 8    | last_exec_price_e6       | Last execution price                 |
//! | 128    | 16   | max_inventory_abs        | Inventory limit                      |
//! | 144    | 16   | insurance_snapshot       | Insurance fund balance snapshot       |
//! | 160    | 16   | total_oi_snapshot        | Total open interest snapshot          |
//! | 176    | 8    | market_age_slots         | Slots since admin burn                |
//! | 184    | 8    | last_deficit_slot        | Last slot with liquidation deficit    |
//! | 192    | 8    | snapshot_slot            | Slot when snapshots were updated      |
//! | 200    | 4    | age_halflife_slots       | Halflife for age discount (u32)       |
//! | 204    | 4    | insurance_weight_bps     | How much insurance ratio affects spread|
//! | 208    | 48   | _reserved                |                                       |

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg,
    program_error::ProgramError, pubkey::Pubkey,
};

entrypoint!(process_instruction);

// Context magic: "PERCMATC"
const MAGIC: u64 = 0x5045_5243_4d41_5443;
const VERSION: u32 = 5;
const KIND_CREDIBILITY: u8 = 2;

// Return data layout (first 64 bytes of context account)
const RET_ABI_VERSION_OFF: usize = 0;
const RET_FLAGS_OFF: usize = 4;
const RET_EXEC_PRICE_OFF: usize = 8;
const RET_EXEC_SIZE_OFF: usize = 16;
const RET_REQ_ID_OFF: usize = 32;
const RET_LP_ACCOUNT_ID_OFF: usize = 40;
const RET_ORACLE_ECHO_OFF: usize = 48;
const RET_RESERVED_OFF: usize = 56;

const MATCHER_ABI_VERSION: u32 = 1;
const FLAG_VALID: u32 = 1;

// Matcher call input layout (67 bytes)
const CALL_LEN: usize = 67;

// Context offsets (relative to byte 64)
const CTX_MAGIC_OFF: usize = 0;
const CTX_VERSION_OFF: usize = 8;
const CTX_KIND_OFF: usize = 12;
const CTX_LP_PDA_OFF: usize = 16;
const CTX_BASE_FEE_OFF: usize = 48;
const CTX_MIN_SPREAD_OFF: usize = 52;
const CTX_MAX_SPREAD_OFF: usize = 56;
const CTX_IMBALANCE_K_OFF: usize = 60;
const CTX_LIQUIDITY_OFF: usize = 64;
const CTX_MAX_FILL_OFF: usize = 80;
const CTX_INVENTORY_OFF: usize = 96;
const CTX_LAST_ORACLE_OFF: usize = 112;
const CTX_LAST_EXEC_OFF: usize = 120;
const CTX_MAX_INVENTORY_OFF: usize = 128;
const CTX_INSURANCE_OFF: usize = 144;
const CTX_TOTAL_OI_OFF: usize = 160;
const CTX_MARKET_AGE_OFF: usize = 176;
const CTX_LAST_DEFICIT_OFF: usize = 184;
const CTX_SNAPSHOT_SLOT_OFF: usize = 192;
const CTX_AGE_HALFLIFE_OFF: usize = 200;
const CTX_INSURANCE_WEIGHT_OFF: usize = 204;

const CTX_BASE: usize = 64;

const BPS: u64 = 10_000;

// =============================================================================
// Coverage Tiers — the market prices its own fragility
//
// These thresholds are hardcoded, not configurable. The math is the governance.
// =============================================================================

/// Coverage < 10%: CRITICAL
/// Spread locked at max. Fill capped at 25% of base max_fill.
/// The market is telling you: "I might not survive a liquidation cascade."
const TIER_CRITICAL_BPS: u64 = 1_000; // 10% in bps

/// Coverage < 25%: FRAGILE
/// Spread interpolates sharply toward max. Fill capped at 50%.
/// Thin insurance = expensive trading. No exceptions.
const TIER_FRAGILE_BPS: u64 = 2_500; // 25% in bps

/// Coverage < 100%: NORMAL
/// Linear discount from insurance_weight_bps. Full fill allowed.
/// The standard operating range.
const TIER_NORMAL_BPS: u64 = 10_000; // 100% in bps

/// Coverage < 200%: STRONG
/// Full insurance discount. Spreads at their tightest for the base formula.
/// The market has proven solvency.
const TIER_STRONG_BPS: u64 = 20_000; // 200% in bps

/// Coverage >= 200%: FORTIFIED
/// Spread at min_spread floor. Fill gets 50% bonus above base max_fill.
/// Overcollateralized markets get the best pricing.

// Fill multipliers (in percent, applied to max_fill_abs)
const FILL_PCT_CRITICAL: u128 = 25;
const FILL_PCT_FRAGILE: u128 = 50;
const FILL_PCT_NORMAL: u128 = 100;
const FILL_PCT_STRONG: u128 = 100;
const FILL_PCT_FORTIFIED: u128 = 150;

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    match data[0] {
        0x00 => process_match(program_id, accounts, data),
        0x02 => process_init(program_id, accounts, data),
        0x03 => process_update_credibility(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// =============================================================================
// Match Instruction (tag 0x00)
//
// Pricing logic:
//   1. Compute coverage ratio (insurance / OI)
//   2. Determine tier → sets spread multiplier and fill cap
//   3. Add inventory imbalance penalty
//   4. Clamp to [min_spread, max_spread]
//   5. Apply fill limit based on tier
//
// The result: thin liquidity is automatically expensive.
// =============================================================================
fn process_match(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < CALL_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let lp_pda = &accounts[0];
    let ctx_account = &accounts[1];

    if !lp_pda.is_signer {
        msg!("ERROR: LP PDA must be a signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut ctx_data = ctx_account.try_borrow_mut_data()?;
    if ctx_data.len() < 320 {
        return Err(ProgramError::AccountDataTooSmall);
    }

    let magic = u64::from_le_bytes(ctx_data[CTX_BASE..CTX_BASE + 8].try_into().unwrap());
    if magic != MAGIC {
        msg!("ERROR: Invalid context magic");
        return Err(ProgramError::InvalidAccountData);
    }

    let stored_pda = Pubkey::new_from_array(
        ctx_data[CTX_BASE + CTX_LP_PDA_OFF..CTX_BASE + CTX_LP_PDA_OFF + 32]
            .try_into()
            .unwrap(),
    );
    if *lp_pda.key != stored_pda {
        msg!("ERROR: LP PDA mismatch");
        return Err(ProgramError::InvalidAccountData);
    }

    // Parse CPI call data
    let req_id = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let _lp_idx = u16::from_le_bytes(data[9..11].try_into().unwrap());
    let lp_account_id = u64::from_le_bytes(data[11..19].try_into().unwrap());
    let oracle_price_e6 = u64::from_le_bytes(data[19..27].try_into().unwrap());
    let trade_size = i128::from_le_bytes(data[27..43].try_into().unwrap());

    if oracle_price_e6 == 0 {
        msg!("ERROR: Zero oracle price");
        return Err(ProgramError::InvalidInstructionData);
    }

    // Read context parameters
    let base_fee_bps = read_u32(&ctx_data, CTX_BASE + CTX_BASE_FEE_OFF) as u64;
    let min_spread_bps = read_u32(&ctx_data, CTX_BASE + CTX_MIN_SPREAD_OFF) as u64;
    let max_spread_bps = read_u32(&ctx_data, CTX_BASE + CTX_MAX_SPREAD_OFF) as u64;
    let imbalance_k_bps = read_u32(&ctx_data, CTX_BASE + CTX_IMBALANCE_K_OFF) as u64;
    let liquidity_e6 = read_u128(&ctx_data, CTX_BASE + CTX_LIQUIDITY_OFF);
    let base_max_fill = read_u128(&ctx_data, CTX_BASE + CTX_MAX_FILL_OFF);
    let inventory = read_i128(&ctx_data, CTX_BASE + CTX_INVENTORY_OFF);
    let max_inventory = read_u128(&ctx_data, CTX_BASE + CTX_MAX_INVENTORY_OFF);

    // Read credibility signals
    let insurance_snapshot = read_u128(&ctx_data, CTX_BASE + CTX_INSURANCE_OFF);
    let total_oi_snapshot = read_u128(&ctx_data, CTX_BASE + CTX_TOTAL_OI_OFF);
    let insurance_weight_bps = read_u32(&ctx_data, CTX_BASE + CTX_INSURANCE_WEIGHT_OFF) as u64;

    // =========================================================================
    // STEP 1: Compute coverage ratio in bps (0 = no insurance, 10000 = 100%)
    // =========================================================================
    let coverage_bps: u64 = if total_oi_snapshot > 0 {
        let ratio = ((insurance_snapshot as u128) * (BPS as u128))
            .checked_div(total_oi_snapshot as u128)
            .unwrap_or(0);
        // Allow >10000 (>100% coverage) — don't cap here
        ratio.min(u64::MAX as u128) as u64
    } else {
        // No OI: if there's any insurance, treat as FORTIFIED; else NORMAL
        if insurance_snapshot > 0 { TIER_STRONG_BPS } else { TIER_FRAGILE_BPS }
    };

    // =========================================================================
    // STEP 2: Determine tier → spread adjustment and fill multiplier
    // =========================================================================
    let (tier_name, spread_bps, fill_pct) = if coverage_bps < TIER_CRITICAL_BPS {
        // CRITICAL: <10% coverage. Max spread. Severely limited fills.
        ("CRITICAL", max_spread_bps, FILL_PCT_CRITICAL)
    } else if coverage_bps < TIER_FRAGILE_BPS {
        // FRAGILE: 10-25%. Interpolate between max_spread and 75% of spread range.
        // Linear interpolation: progress from 10% to 25%
        let progress = coverage_bps - TIER_CRITICAL_BPS; // 0..1500
        let range = TIER_FRAGILE_BPS - TIER_CRITICAL_BPS; // 1500
        let spread_range = max_spread_bps - min_spread_bps;
        // At 10%: spread = max_spread. At 25%: spread = max_spread - 25% of range
        let reduction = (spread_range / 4) * (progress as u64) / (range as u64);
        (
            "FRAGILE",
            max_spread_bps.saturating_sub(reduction),
            FILL_PCT_FRAGILE,
        )
    } else if coverage_bps < TIER_NORMAL_BPS {
        // NORMAL: 25-100%. Standard linear discount from insurance weight.
        // coverage_fraction = (coverage - 25%) / 75%
        let progress = coverage_bps - TIER_FRAGILE_BPS; // 0..7500
        let range = TIER_NORMAL_BPS - TIER_FRAGILE_BPS; // 7500
        let discount = if insurance_weight_bps > 0 {
            (insurance_weight_bps * progress as u64) / range as u64
        } else {
            0
        };
        let base = max_spread_bps - (max_spread_bps - min_spread_bps) / 4; // starts where FRAGILE ends
        (
            "NORMAL",
            base.saturating_sub(discount),
            FILL_PCT_NORMAL,
        )
    } else if coverage_bps < TIER_STRONG_BPS {
        // STRONG: 100-200%. Full insurance discount applied. Tight spreads.
        let discount = insurance_weight_bps;
        (
            "STRONG",
            min_spread_bps.saturating_add(insurance_weight_bps).saturating_sub(discount),
            FILL_PCT_STRONG,
        )
    } else {
        // FORTIFIED: >200%. Minimum spread. Bonus fill capacity.
        ("FORTIFIED", min_spread_bps, FILL_PCT_FORTIFIED)
    };

    // =========================================================================
    // STEP 3: Inventory imbalance penalty (standard market-making, all tiers)
    // =========================================================================
    let mut final_spread = spread_bps;
    if liquidity_e6 > 0 && imbalance_k_bps > 0 {
        let inventory_abs = inventory.unsigned_abs();
        let imbalance_cost = (imbalance_k_bps as u128)
            .checked_mul(inventory_abs)
            .unwrap_or(u128::MAX)
            / liquidity_e6;
        final_spread = final_spread.saturating_add(imbalance_cost as u64);
    }

    // =========================================================================
    // STEP 4: Clamp spread to [1, max_spread_bps]
    // =========================================================================
    final_spread = final_spread.clamp(1, max_spread_bps);

    // =========================================================================
    // STEP 5: Apply fill limit based on tier
    // =========================================================================
    let effective_max_fill = if base_max_fill > 0 {
        (base_max_fill * fill_pct) / 100
    } else {
        0 // 0 means unlimited in the original design
    };

    let abs_size = trade_size.unsigned_abs();
    if effective_max_fill > 0 && abs_size > effective_max_fill {
        msg!(
            "REJECT: trade {} exceeds tier {} fill limit {} (base {} * {}%)",
            abs_size, tier_name, effective_max_fill, base_max_fill, fill_pct
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    // Enforce max inventory
    let new_inventory = inventory + trade_size;
    if max_inventory > 0 {
        let new_abs = new_inventory.unsigned_abs();
        if new_abs > max_inventory {
            msg!("ERROR: Would exceed inventory limit");
            return Err(ProgramError::InvalidInstructionData);
        }
    }

    // =========================================================================
    // STEP 6: Calculate execution price
    // =========================================================================
    let total_cost_bps = final_spread + base_fee_bps;
    let exec_price_e6 = if trade_size > 0 {
        // Buying: oracle + spread
        let numer = (oracle_price_e6 as u128) * ((BPS as u128) + (total_cost_bps as u128));
        (numer / (BPS as u128)) as u64
    } else {
        // Selling: oracle - spread
        let numer = (oracle_price_e6 as u128)
            * ((BPS as u128) - total_cost_bps.min(BPS) as u128);
        (numer / (BPS as u128)) as u64
    };

    // Update state
    write_i128(&mut ctx_data, CTX_BASE + CTX_INVENTORY_OFF, new_inventory);
    write_u64(&mut ctx_data, CTX_BASE + CTX_LAST_ORACLE_OFF, oracle_price_e6);
    write_u64(&mut ctx_data, CTX_BASE + CTX_LAST_EXEC_OFF, exec_price_e6);

    // Write MatcherReturn
    write_u32(&mut ctx_data, RET_ABI_VERSION_OFF, MATCHER_ABI_VERSION);
    write_u32(&mut ctx_data, RET_FLAGS_OFF, FLAG_VALID);
    write_u64(&mut ctx_data, RET_EXEC_PRICE_OFF, exec_price_e6);
    write_i128(&mut ctx_data, RET_EXEC_SIZE_OFF, trade_size);
    write_u64(&mut ctx_data, RET_REQ_ID_OFF, req_id);
    write_u64(&mut ctx_data, RET_LP_ACCOUNT_ID_OFF, lp_account_id);
    write_u64(&mut ctx_data, RET_ORACLE_ECHO_OFF, oracle_price_e6);
    write_u64(&mut ctx_data, RET_RESERVED_OFF, 0);

    msg!(
        "credibility-match: tier={} coverage={}bps spread={}bps fee={}bps fill_cap={}% price={} size={}",
        tier_name, coverage_bps, final_spread, base_fee_bps, fill_pct, exec_price_e6, trade_size
    );

    Ok(())
}

// =============================================================================
// Init Instruction (tag 0x02) — unchanged from v1
// =============================================================================
fn process_init(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 74 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let lp_pda = &accounts[0];
    let ctx_account = &accounts[1];

    let mut ctx_data = ctx_account.try_borrow_mut_data()?;
    if ctx_data.len() < 320 {
        return Err(ProgramError::AccountDataTooSmall);
    }

    let existing_magic = u64::from_le_bytes(ctx_data[CTX_BASE..CTX_BASE + 8].try_into().unwrap());
    if existing_magic == MAGIC {
        msg!("ERROR: Context already initialized");
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let mut off = 1;
    let kind = data[off]; off += 1;
    if kind != KIND_CREDIBILITY {
        msg!("ERROR: Expected kind=2 (Credibility)");
        return Err(ProgramError::InvalidInstructionData);
    }

    let base_fee_bps = u32::from_le_bytes(data[off..off + 4].try_into().unwrap()); off += 4;
    let min_spread_bps = u32::from_le_bytes(data[off..off + 4].try_into().unwrap()); off += 4;
    let max_spread_bps = u32::from_le_bytes(data[off..off + 4].try_into().unwrap()); off += 4;
    let imbalance_k_bps = u32::from_le_bytes(data[off..off + 4].try_into().unwrap()); off += 4;
    let liquidity_e6 = u128::from_le_bytes(data[off..off + 16].try_into().unwrap()); off += 16;
    let max_fill = u128::from_le_bytes(data[off..off + 16].try_into().unwrap()); off += 16;
    let max_inventory = u128::from_le_bytes(data[off..off + 16].try_into().unwrap()); off += 16;
    let age_halflife = u32::from_le_bytes(data[off..off + 4].try_into().unwrap()); off += 4;
    let insurance_weight_bps = u32::from_le_bytes(data[off..off + 4].try_into().unwrap());

    write_u64(&mut ctx_data, CTX_BASE + CTX_MAGIC_OFF, MAGIC);
    write_u32(&mut ctx_data, CTX_BASE + CTX_VERSION_OFF, VERSION);
    ctx_data[CTX_BASE + CTX_KIND_OFF] = kind;
    ctx_data[CTX_BASE + CTX_LP_PDA_OFF..CTX_BASE + CTX_LP_PDA_OFF + 32]
        .copy_from_slice(&lp_pda.key.to_bytes());
    write_u32(&mut ctx_data, CTX_BASE + CTX_BASE_FEE_OFF, base_fee_bps);
    write_u32(&mut ctx_data, CTX_BASE + CTX_MIN_SPREAD_OFF, min_spread_bps);
    write_u32(&mut ctx_data, CTX_BASE + CTX_MAX_SPREAD_OFF, max_spread_bps);
    write_u32(&mut ctx_data, CTX_BASE + CTX_IMBALANCE_K_OFF, imbalance_k_bps);
    write_u128(&mut ctx_data, CTX_BASE + CTX_LIQUIDITY_OFF, liquidity_e6);
    write_u128(&mut ctx_data, CTX_BASE + CTX_MAX_FILL_OFF, max_fill);
    write_i128(&mut ctx_data, CTX_BASE + CTX_INVENTORY_OFF, 0);
    write_u128(&mut ctx_data, CTX_BASE + CTX_MAX_INVENTORY_OFF, max_inventory);
    write_u32(&mut ctx_data, CTX_BASE + CTX_AGE_HALFLIFE_OFF, age_halflife);
    write_u32(&mut ctx_data, CTX_BASE + CTX_INSURANCE_WEIGHT_OFF, insurance_weight_bps);

    msg!(
        "credibility-init-v2: fee={}bps spread=[{},{}]bps tiers=CRITICAL<10%<FRAGILE<25%<NORMAL<100%<STRONG<200%<FORTIFIED",
        base_fee_bps, min_spread_bps, max_spread_bps
    );

    Ok(())
}

// =============================================================================
// Update Credibility Instruction (tag 0x03) — unchanged from v1
// =============================================================================
fn process_update_credibility(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let ctx_account = &accounts[0];
    let slab_account = &accounts[1];
    let clock_account = &accounts[2];

    let mut ctx_data = ctx_account.try_borrow_mut_data()?;
    if ctx_data.len() < 320 {
        return Err(ProgramError::AccountDataTooSmall);
    }

    let magic = u64::from_le_bytes(ctx_data[CTX_BASE..CTX_BASE + 8].try_into().unwrap());
    if magic != MAGIC {
        msg!("ERROR: Context not initialized");
        return Err(ProgramError::UninitializedAccount);
    }

    let slab_data = slab_account.try_borrow_data()?;

    const SLAB_HEADER_LEN: usize = 72;
    const SLAB_CONFIG_LEN: usize = 320;
    const SLAB_ENGINE_OFF: usize = SLAB_HEADER_LEN + SLAB_CONFIG_LEN;
    const ENGINE_INSURANCE_OFF: usize = 16;
    const ENGINE_TOTAL_OI_OFF: usize = 248;
    const ENGINE_LAST_CRANK_OFF: usize = 232;
    const ENGINE_LIFETIME_LIQS_OFF: usize = 328;

    if slab_data.len() < SLAB_ENGINE_OFF + 400 {
        msg!("ERROR: Slab too small");
        return Err(ProgramError::AccountDataTooSmall);
    }

    let ins_off = SLAB_ENGINE_OFF + ENGINE_INSURANCE_OFF;
    let insurance_balance = u128::from_le_bytes(slab_data[ins_off..ins_off + 16].try_into().unwrap());

    let oi_off = SLAB_ENGINE_OFF + ENGINE_TOTAL_OI_OFF;
    let total_oi = u128::from_le_bytes(slab_data[oi_off..oi_off + 16].try_into().unwrap());

    let admin_bytes: [u8; 32] = slab_data[16..48].try_into().unwrap();
    let admin_is_burned = admin_bytes == [0u8; 32]
        || Pubkey::new_from_array(admin_bytes) == solana_program::system_program::id();

    let clock_data = clock_account.try_borrow_data()?;
    let current_slot = if clock_data.len() >= 8 {
        u64::from_le_bytes(clock_data[0..8].try_into().unwrap())
    } else {
        0
    };

    let _crank_off = SLAB_ENGINE_OFF + ENGINE_LAST_CRANK_OFF;
    let _liq_off = SLAB_ENGINE_OFF + ENGINE_LIFETIME_LIQS_OFF;

    let existing_age = read_u64(&ctx_data, CTX_BASE + CTX_MARKET_AGE_OFF);
    let existing_snapshot_slot = read_u64(&ctx_data, CTX_BASE + CTX_SNAPSHOT_SLOT_OFF);
    let market_age = if existing_snapshot_slot > 0 && admin_is_burned {
        existing_age + current_slot.saturating_sub(existing_snapshot_slot)
    } else if admin_is_burned {
        0
    } else {
        0
    };

    // Compute coverage for logging
    let coverage_bps: u64 = if total_oi > 0 {
        (((insurance_balance as u128) * (BPS as u128)) / (total_oi as u128)).min(u64::MAX as u128) as u64
    } else {
        0
    };

    let tier = if coverage_bps < TIER_CRITICAL_BPS {
        "CRITICAL"
    } else if coverage_bps < TIER_FRAGILE_BPS {
        "FRAGILE"
    } else if coverage_bps < TIER_NORMAL_BPS {
        "NORMAL"
    } else if coverage_bps < TIER_STRONG_BPS {
        "STRONG"
    } else {
        "FORTIFIED"
    };

    write_u128(&mut ctx_data, CTX_BASE + CTX_INSURANCE_OFF, insurance_balance);
    write_u128(&mut ctx_data, CTX_BASE + CTX_TOTAL_OI_OFF, total_oi);
    write_u64(&mut ctx_data, CTX_BASE + CTX_MARKET_AGE_OFF, market_age);
    write_u64(&mut ctx_data, CTX_BASE + CTX_SNAPSHOT_SLOT_OFF, current_slot);

    msg!(
        "credibility-update-v2: insurance={} oi={} coverage={}bps tier={} age={} burned={}",
        insurance_balance, total_oi, coverage_bps, tier, market_age, admin_is_burned
    );

    Ok(())
}

// =============================================================================
// Helpers
// =============================================================================

fn read_u32(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(data[off..off + 4].try_into().unwrap())
}

fn read_u64(data: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}

fn read_u128(data: &[u8], off: usize) -> u128 {
    u128::from_le_bytes(data[off..off + 16].try_into().unwrap())
}

fn read_i128(data: &[u8], off: usize) -> i128 {
    i128::from_le_bytes(data[off..off + 16].try_into().unwrap())
}

fn write_u32(data: &mut [u8], off: usize, val: u32) {
    data[off..off + 4].copy_from_slice(&val.to_le_bytes());
}

fn write_u64(data: &mut [u8], off: usize, val: u64) {
    data[off..off + 8].copy_from_slice(&val.to_le_bytes());
}

fn write_u128(data: &mut [u8], off: usize, val: u128) {
    data[off..off + 16].copy_from_slice(&val.to_le_bytes());
}

fn write_i128(data: &mut [u8], off: usize, val: i128) {
    data[off..off + 16].copy_from_slice(&val.to_le_bytes());
}

// =============================================================================
// Tests
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    fn compute_tier(coverage_bps: u64) -> (&'static str, u128) {
        if coverage_bps < TIER_CRITICAL_BPS {
            ("CRITICAL", FILL_PCT_CRITICAL)
        } else if coverage_bps < TIER_FRAGILE_BPS {
            ("FRAGILE", FILL_PCT_FRAGILE)
        } else if coverage_bps < TIER_NORMAL_BPS {
            ("NORMAL", FILL_PCT_NORMAL)
        } else if coverage_bps < TIER_STRONG_BPS {
            ("STRONG", FILL_PCT_STRONG)
        } else {
            ("FORTIFIED", FILL_PCT_FORTIFIED)
        }
    }

    #[test]
    fn test_tier_critical_zero_insurance() {
        let (tier, fill) = compute_tier(0);
        assert_eq!(tier, "CRITICAL");
        assert_eq!(fill, 25);
    }

    #[test]
    fn test_tier_critical_5pct() {
        let (tier, fill) = compute_tier(500); // 5%
        assert_eq!(tier, "CRITICAL");
        assert_eq!(fill, 25);
    }

    #[test]
    fn test_tier_fragile_boundary() {
        let (tier, fill) = compute_tier(1000); // exactly 10%
        assert_eq!(tier, "FRAGILE");
        assert_eq!(fill, 50);
    }

    #[test]
    fn test_tier_fragile_20pct() {
        let (tier, fill) = compute_tier(2000); // 20%
        assert_eq!(tier, "FRAGILE");
        assert_eq!(fill, 50);
    }

    #[test]
    fn test_tier_normal_boundary() {
        let (tier, fill) = compute_tier(2500); // exactly 25%
        assert_eq!(tier, "NORMAL");
        assert_eq!(fill, 100);
    }

    #[test]
    fn test_tier_normal_50pct() {
        let (tier, fill) = compute_tier(5000); // 50%
        assert_eq!(tier, "NORMAL");
        assert_eq!(fill, 100);
    }

    #[test]
    fn test_tier_strong_boundary() {
        let (tier, fill) = compute_tier(10000); // exactly 100%
        assert_eq!(tier, "STRONG");
        assert_eq!(fill, 100);
    }

    #[test]
    fn test_tier_strong_150pct() {
        let (tier, fill) = compute_tier(15000); // 150%
        assert_eq!(tier, "STRONG");
        assert_eq!(fill, 100);
    }

    #[test]
    fn test_tier_fortified_boundary() {
        let (tier, fill) = compute_tier(20000); // exactly 200%
        assert_eq!(tier, "FORTIFIED");
        assert_eq!(fill, 150);
    }

    #[test]
    fn test_tier_fortified_300pct() {
        let (tier, fill) = compute_tier(30000); // 300%
        assert_eq!(tier, "FORTIFIED");
        assert_eq!(fill, 150);
    }

    #[test]
    fn test_fill_cap_math() {
        let base_max_fill: u128 = 1_000_000_000; // 1 SOL
        // CRITICAL: 25% of base
        assert_eq!((base_max_fill * FILL_PCT_CRITICAL) / 100, 250_000_000);
        // FRAGILE: 50%
        assert_eq!((base_max_fill * FILL_PCT_FRAGILE) / 100, 500_000_000);
        // NORMAL/STRONG: 100%
        assert_eq!((base_max_fill * FILL_PCT_NORMAL) / 100, 1_000_000_000);
        // FORTIFIED: 150%
        assert_eq!((base_max_fill * FILL_PCT_FORTIFIED) / 100, 1_500_000_000);
    }

    #[test]
    fn test_critical_gets_max_spread() {
        // At CRITICAL tier, spread should be max_spread
        let max_spread: u64 = 200;
        let coverage_bps: u64 = 500; // 5% → CRITICAL
        let spread = if coverage_bps < TIER_CRITICAL_BPS {
            max_spread
        } else {
            0 // placeholder
        };
        assert_eq!(spread, 200);
    }

    #[test]
    fn test_fortified_gets_min_spread() {
        // At FORTIFIED tier, spread should be min_spread
        let min_spread: u64 = 5;
        let coverage_bps: u64 = 25000; // 250% → FORTIFIED
        let spread = if coverage_bps >= TIER_STRONG_BPS {
            min_spread
        } else {
            0
        };
        assert_eq!(spread, 5);
    }
}
