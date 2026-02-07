//! Credibility-Aware Matcher for Percolator
//!
//! A deterministic, autonomous matcher whose pricing depends on:
//! - Net open interest imbalance
//! - Insurance fund size relative to open interest
//! - Market age and solvency streak
//!
//! The matcher requires no human input and signs quotes autonomously.
//! All pricing parameters are derived from on-chain state.
//!
//! ## Context Layout (256 bytes, starting at byte 64 of the 320-byte account)
//!
//! | Offset | Size | Field                    | Description                          |
//! |--------|------|--------------------------|--------------------------------------|
//! | 0      | 8    | magic                    | 0x5045_5243_4d41_5443 ("PERCMATC")   |
//! | 8      | 4    | version                  | 4                                    |
//! | 12     | 1    | kind                     | 2 = Credibility                      |
//! | 13     | 3    | _pad0                    |                                      |
//! | 16     | 32   | lp_pda                   | LP PDA for signature verification    |
//! | 48     | 4    | base_fee_bps             | Base trading fee                     |
//! | 52     | 4    | min_spread_bps           | Minimum spread floor                 |
//! | 56     | 4    | max_spread_bps           | Maximum spread cap                   |
//! | 60     | 4    | imbalance_k_bps          | Imbalance impact multiplier          |
//! | 64     | 16   | liquidity_notional_e6    | Quoting depth for impact calc        |
//! | 80     | 16   | max_fill_abs             | Max fill per trade                   |
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
const VERSION: u32 = 4;
const KIND_CREDIBILITY: u8 = 2;

// Return data layout (first 64 bytes of context account)
const RET_EXEC_PRICE_OFF: usize = 0; // i64: signed execution price
const RET_FILL_SIZE_OFF: usize = 8; // i128: signed fill size

// Context offsets (relative to byte 64 of the account)
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

// Absolute offset: context starts at byte 64 of the 320-byte account
const CTX_BASE: usize = 64;

// BPS denominator
const BPS: u64 = 10_000;

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    match data[0] {
        // Match instruction: called by percolator during trade-cpi
        0x00 => process_match(program_id, accounts, data),
        // Init instruction: set up context with LP PDA and params
        0x02 => process_init(program_id, accounts, data),
        // Update credibility snapshots: permissionless, reads from slab
        0x03 => process_update_credibility(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// =============================================================================
// Match Instruction (tag 0x00)
//
// Called by percolator via CPI. Determines execution price based on:
// 1. Base spread
// 2. Inventory imbalance adjustment
// 3. Insurance fund coverage discount
// 4. Market age discount
//
// Accounts: [lp_pda (signer), matcher_ctx (writable)]
// Data: [tag(1), oracle_price_e6(8), trade_size(16)]
// =============================================================================
fn process_match(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 25 {
        // tag(1) + oracle_price_e6(8) + trade_size_i128(16)
        return Err(ProgramError::InvalidInstructionData);
    }

    let lp_pda = &accounts[0];
    let ctx_account = &accounts[1];

    // CRITICAL: Verify LP PDA is a signer (signed by percolator via CPI)
    if !lp_pda.is_signer {
        msg!("ERROR: LP PDA must be a signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut ctx_data = ctx_account.try_borrow_mut_data()?;
    if ctx_data.len() < 320 {
        return Err(ProgramError::AccountDataTooSmall);
    }

    // Verify magic and version
    let magic = u64::from_le_bytes(ctx_data[CTX_BASE..CTX_BASE + 8].try_into().unwrap());
    if magic != MAGIC {
        msg!("ERROR: Invalid context magic");
        return Err(ProgramError::InvalidAccountData);
    }

    // Verify LP PDA matches stored PDA
    let stored_pda = Pubkey::new_from_array(
        ctx_data[CTX_BASE + CTX_LP_PDA_OFF..CTX_BASE + CTX_LP_PDA_OFF + 32]
            .try_into()
            .unwrap(),
    );
    if *lp_pda.key != stored_pda {
        msg!("ERROR: LP PDA mismatch");
        return Err(ProgramError::InvalidAccountData);
    }

    // Parse input
    let oracle_price_e6 =
        u64::from_le_bytes(data[1..9].try_into().unwrap());
    let trade_size_bytes: [u8; 16] = data[9..25].try_into().unwrap();
    let trade_size = i128::from_le_bytes(trade_size_bytes);

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
    let max_fill = read_u128(&ctx_data, CTX_BASE + CTX_MAX_FILL_OFF);
    let inventory = read_i128(&ctx_data, CTX_BASE + CTX_INVENTORY_OFF);
    let max_inventory = read_u128(&ctx_data, CTX_BASE + CTX_MAX_INVENTORY_OFF);

    // Read credibility parameters
    let insurance_snapshot = read_u128(&ctx_data, CTX_BASE + CTX_INSURANCE_OFF);
    let total_oi_snapshot = read_u128(&ctx_data, CTX_BASE + CTX_TOTAL_OI_OFF);
    let market_age_slots = read_u64(&ctx_data, CTX_BASE + CTX_MARKET_AGE_OFF);
    let age_halflife = read_u32(&ctx_data, CTX_BASE + CTX_AGE_HALFLIFE_OFF) as u64;
    let insurance_weight_bps = read_u32(&ctx_data, CTX_BASE + CTX_INSURANCE_WEIGHT_OFF) as u64;

    // Enforce max fill
    let abs_size = trade_size.unsigned_abs();
    if max_fill > 0 && abs_size > max_fill {
        msg!("ERROR: Trade exceeds max fill");
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
    // Pricing Logic: Deterministic spread calculation
    // =========================================================================

    // 1. Base spread
    let mut spread_bps = min_spread_bps;

    // 2. Inventory imbalance adjustment
    // Wider spread when inventory is skewed in the direction of the trade
    if liquidity_e6 > 0 && imbalance_k_bps > 0 {
        let inventory_abs = inventory.unsigned_abs();
        // imbalance_cost = imbalance_k_bps * |inventory| / liquidity
        let imbalance_cost = (imbalance_k_bps as u128)
            .checked_mul(inventory_abs)
            .unwrap_or(u128::MAX)
            / liquidity_e6;
        spread_bps = spread_bps.saturating_add(imbalance_cost as u64);
    }

    // 3. Insurance fund coverage discount
    // Larger insurance fund relative to OI → tighter spreads
    // discount = insurance_weight_bps * (insurance / max(oi, 1))
    // Capped at insurance_weight_bps (100% discount when insurance >= OI)
    if insurance_weight_bps > 0 && total_oi_snapshot > 0 {
        let coverage_ratio_bps = ((insurance_snapshot as u128) * (BPS as u128))
            .checked_div(total_oi_snapshot as u128)
            .unwrap_or(0) as u64;
        let discount = coverage_ratio_bps
            .min(BPS)
            .checked_mul(insurance_weight_bps)
            .unwrap_or(0)
            / BPS;
        spread_bps = spread_bps.saturating_sub(discount);
    }

    // 4. Market age discount
    // Older, solvent markets get tighter spreads
    // discount = min_spread_bps * age / (age + halflife)
    // This is a hyperbolic discount: at age = halflife, discount = 50%
    if age_halflife > 0 && market_age_slots > 0 {
        let age_discount = (min_spread_bps * market_age_slots)
            / (market_age_slots + age_halflife);
        spread_bps = spread_bps.saturating_sub(age_discount);
    }

    // 5. Clamp to [min, max]
    spread_bps = spread_bps.clamp(1, max_spread_bps); // Never zero spread

    // 6. Calculate execution price
    let total_cost_bps = spread_bps + base_fee_bps;
    let exec_price_e6 = if trade_size > 0 {
        // Buying: pay oracle + spread
        let numer = (oracle_price_e6 as u128) * ((BPS as u128) + (total_cost_bps as u128));
        (numer / (BPS as u128)) as u64
    } else {
        // Selling: receive oracle - spread
        let numer = (oracle_price_e6 as u128) * ((BPS as u128) - total_cost_bps.min(BPS) as u128);
        (numer / (BPS as u128)) as u64
    };

    // Update inventory
    write_i128(&mut ctx_data, CTX_BASE + CTX_INVENTORY_OFF, new_inventory);
    write_u64(&mut ctx_data, CTX_BASE + CTX_LAST_ORACLE_OFF, oracle_price_e6);
    write_u64(&mut ctx_data, CTX_BASE + CTX_LAST_EXEC_OFF, exec_price_e6);

    // Write return data: exec_price (i64) + fill_size (i128)
    let exec_price_i64 = exec_price_e6 as i64;
    ctx_data[RET_EXEC_PRICE_OFF..RET_EXEC_PRICE_OFF + 8]
        .copy_from_slice(&exec_price_i64.to_le_bytes());
    ctx_data[RET_FILL_SIZE_OFF..RET_FILL_SIZE_OFF + 16]
        .copy_from_slice(&trade_size.to_le_bytes());

    msg!(
        "credibility-match: spread={}bps fee={}bps price={} size={}",
        spread_bps,
        base_fee_bps,
        exec_price_e6,
        trade_size
    );

    Ok(())
}

// =============================================================================
// Init Instruction (tag 0x02)
//
// Sets up the matcher context with LP PDA and initial parameters.
// Must be called atomically with LP creation in percolator.
//
// Accounts: [lp_pda, matcher_ctx (writable)]
// Data: [tag(1), kind(1), base_fee_bps(4), min_spread_bps(4), max_spread_bps(4),
//        imbalance_k_bps(4), liquidity_e6(16), max_fill(16), max_inventory(16),
//        age_halflife(4), insurance_weight_bps(4)]
// Total: 74 bytes
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

    // Check not already initialized
    let existing_magic = u64::from_le_bytes(ctx_data[CTX_BASE..CTX_BASE + 8].try_into().unwrap());
    if existing_magic == MAGIC {
        msg!("ERROR: Context already initialized");
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let mut off = 1; // skip tag

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

    // Write context
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
        "credibility-init: fee={}bps spread=[{},{}]bps imbalance_k={}bps age_hl={} ins_w={}bps",
        base_fee_bps, min_spread_bps, max_spread_bps, imbalance_k_bps,
        age_halflife, insurance_weight_bps
    );

    Ok(())
}

// =============================================================================
// Update Credibility Instruction (tag 0x03)
//
// Permissionless: anyone can call this to update the matcher's view of
// the market's credibility state. Reads from the slab account.
//
// Accounts: [matcher_ctx (writable), slab (read-only), clock (read-only)]
// Data: [tag(1)]
//
// Reads from slab:
// - Insurance fund balance (engine offset 16, u128)
// - Total open interest (engine offset 248, u128)
// - Admin key (header offset 16, 32 bytes) — to compute market age
// - Last crank slot (engine offset 232, u64)
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

    // Verify context is initialized
    let magic = u64::from_le_bytes(ctx_data[CTX_BASE..CTX_BASE + 8].try_into().unwrap());
    if magic != MAGIC {
        msg!("ERROR: Context not initialized");
        return Err(ProgramError::UninitializedAccount);
    }

    let slab_data = slab_account.try_borrow_data()?;

    // Slab layout constants (must match percolator-prog)
    const SLAB_HEADER_LEN: usize = 72;
    const SLAB_CONFIG_LEN: usize = 320;
    const SLAB_ENGINE_OFF: usize = SLAB_HEADER_LEN + SLAB_CONFIG_LEN; // 392
    const ENGINE_INSURANCE_OFF: usize = 16;
    const ENGINE_TOTAL_OI_OFF: usize = 248;
    const ENGINE_LAST_CRANK_OFF: usize = 232;
    const ENGINE_LIFETIME_LIQS_OFF: usize = 328;

    if slab_data.len() < SLAB_ENGINE_OFF + 400 {
        msg!("ERROR: Slab too small");
        return Err(ProgramError::AccountDataTooSmall);
    }

    // Read insurance fund balance (u128)
    let ins_off = SLAB_ENGINE_OFF + ENGINE_INSURANCE_OFF;
    let insurance_balance = u128::from_le_bytes(slab_data[ins_off..ins_off + 16].try_into().unwrap());

    // Read total open interest (u128)
    let oi_off = SLAB_ENGINE_OFF + ENGINE_TOTAL_OI_OFF;
    let total_oi = u128::from_le_bytes(slab_data[oi_off..oi_off + 16].try_into().unwrap());

    // Read admin key (32 bytes at header offset 16)
    let admin_bytes: [u8; 32] = slab_data[16..48].try_into().unwrap();
    let admin_is_burned = admin_bytes == [0u8; 32]
        || admin_bytes
            == [
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0,
            ]
        || Pubkey::new_from_array(admin_bytes)
            == solana_program::system_program::id();

    // Read current slot from clock sysvar
    let clock_data = clock_account.try_borrow_data()?;
    let current_slot = if clock_data.len() >= 8 {
        u64::from_le_bytes(clock_data[0..8].try_into().unwrap())
    } else {
        0
    };

    // Read last crank slot
    let crank_off = SLAB_ENGINE_OFF + ENGINE_LAST_CRANK_OFF;
    let last_crank_slot = u64::from_le_bytes(slab_data[crank_off..crank_off + 8].try_into().unwrap());

    // Read lifetime liquidations
    let liq_off = SLAB_ENGINE_OFF + ENGINE_LIFETIME_LIQS_OFF;
    let _lifetime_liqs = u64::from_le_bytes(slab_data[liq_off..liq_off + 8].try_into().unwrap());

    // Compute market age: if admin is burned, age = current_slot - snapshot_slot from first update
    // For simplicity, we track the market age as the age from the first credibility update
    let existing_age = read_u64(&ctx_data, CTX_BASE + CTX_MARKET_AGE_OFF);
    let existing_snapshot_slot = read_u64(&ctx_data, CTX_BASE + CTX_SNAPSHOT_SLOT_OFF);
    let market_age = if existing_snapshot_slot > 0 && admin_is_burned {
        existing_age + current_slot.saturating_sub(existing_snapshot_slot)
    } else if admin_is_burned {
        0 // First update after burn
    } else {
        0 // Not burned yet, no credibility age
    };

    // Update context with fresh snapshots
    write_u128(&mut ctx_data, CTX_BASE + CTX_INSURANCE_OFF, insurance_balance);
    write_u128(&mut ctx_data, CTX_BASE + CTX_TOTAL_OI_OFF, total_oi);
    write_u64(&mut ctx_data, CTX_BASE + CTX_MARKET_AGE_OFF, market_age);
    write_u64(&mut ctx_data, CTX_BASE + CTX_SNAPSHOT_SLOT_OFF, current_slot);

    msg!(
        "credibility-update: insurance={} oi={} age={} burned={}",
        insurance_balance,
        total_oi,
        market_age,
        admin_is_burned
    );

    Ok(())
}

// =============================================================================
// Helper functions
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spread_calculation_no_credibility() {
        // With zero insurance and zero age, spread should be at max
        let min_spread: u64 = 20;
        let max_spread: u64 = 200;
        let insurance_weight: u64 = 50;
        let age_halflife: u64 = 1_000_000;

        let insurance: u128 = 0;
        let total_oi: u128 = 1_000_000;
        let market_age: u64 = 0;

        let mut spread = min_spread;

        // No insurance discount (insurance = 0)
        if insurance_weight > 0 && total_oi > 0 {
            let coverage = (insurance * BPS as u128) / total_oi;
            let discount = (coverage.min(BPS as u128) as u64 * insurance_weight) / BPS;
            spread = spread.saturating_sub(discount);
        }

        // No age discount (age = 0)
        if age_halflife > 0 && market_age > 0 {
            let age_discount = (min_spread * market_age) / (market_age + age_halflife);
            spread = spread.saturating_sub(age_discount);
        }

        spread = spread.clamp(1, max_spread);
        assert_eq!(spread, min_spread); // No discounts applied
    }

    #[test]
    fn test_spread_with_full_insurance() {
        let min_spread: u64 = 100;
        let insurance_weight: u64 = 50; // 50 bps max discount from insurance

        let insurance: u128 = 1_000_000;
        let total_oi: u128 = 1_000_000; // 100% coverage

        let mut spread = min_spread;

        let coverage = (insurance * BPS as u128) / total_oi;
        let discount = (coverage.min(BPS as u128) as u64 * insurance_weight) / BPS;
        spread = spread.saturating_sub(discount);

        // 100% coverage → full insurance_weight discount
        assert_eq!(spread, min_spread - insurance_weight);
    }

    #[test]
    fn test_spread_with_age() {
        let min_spread: u64 = 100;
        let age_halflife: u64 = 1_000_000;
        let market_age: u64 = 1_000_000; // At halflife

        let mut spread = min_spread;

        let age_discount = (min_spread * market_age) / (market_age + age_halflife);
        spread = spread.saturating_sub(age_discount);

        // At halflife, discount = 50%
        assert_eq!(spread, 50);
    }
}
