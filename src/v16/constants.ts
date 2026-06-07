/**
 * v16 account-layout constants for percolator-prog HEAD `70294cb`
 * (PushEwmaMark same-slot rate-limit guard), engine pin `051e268`
 * (release impaired insurance liens in terminal wind-down).
 *
 * **Major layout changes vs `4ee339d`/`b6e23b3`:**
 *
 *  - Commit `792256b` collapsed `admin + insurance_authority +
 *    insurance_operator + backing_bucket_authority + asset_authority +
 *    hyperp_mark_authority + base_unit_authority` (7 keys × 32 B) into a
 *    single `marketauth` key. WrapperConfigV16 shrank 624 → 432.
 *  - Commit `dba87a9` unified asset-0 with assets 1..N: per-asset oracle
 *    config + authorities are now per-slot for assets ≥ 1; asset 0's oracle
 *    fields are inline in WrapperConfigV16 (so the wrapper still doubles as
 *    asset 0's profile).
 *  - `MarketGroupV16HeaderAccount` grew 638 → 710 (engine added
 *    `pnl_pos_bound_tot_num`, `pnl_matured_pos_tot`, plus a 72-byte
 *    accounting block).
 *  - `PortfolioAccountV16Account` shrank 22,379 → 9,195 (16 + 9,179) —
 *    source-domain claims compacted into a fixed inline sparse array
 *    (PortfolioSourceDomainV16Account stride 196, 32 slots → 6272 B).
 *  - Market account now starts at `DEFAULT_MARKET_SLOT_CAPACITY = 1` and
 *    reallocs on asset activation; smoke explicitly pre-sizes for `N`
 *    via `marketAccountLenFor(N)`.
 *  - `ASSET_ORACLE_PROFILE_LEN` grew 368 → 400; wrapper storage 512
 *    (unchanged); engine slot 1285 (unchanged); per-slot stride 1797.
 */

// ---------- Header ----------
export const MAGIC = 0x5045_5243_5631_3600n; // "PERCV16\0"
export const VERSION = 16;
export const KIND_MARKET = 1;
export const KIND_PORTFOLIO = 2;
export const HEADER_LEN = 16;

// ---------- WrapperConfigV16 (432 B, immediately after header) ----------
export const WRAPPER_CONFIG_LEN = 432;
export const WRAPPER_CONFIG_OFF = HEADER_LEN; // 16

export const WC = {
  marketauth: 0,                       // [u8;32]  collapsed from 7 keys
  collateral_mint: 32,                 // [u8;32]
  secondary_collateral_mint: 64,       // [u8;32]
  maintenance_fee_per_slot: 96,        // u128
  permissionless_market_init_fee: 112, // u128
  trade_fee_base_bps: 128,             // u64
  permissionless_resolve_stale_slots: 136,
  force_close_delay_slots: 144,
  last_good_oracle_slot: 152,
  insurance_withdraw_deposit_remaining: 160, // u128
  insurance_withdraw_max_bps: 176,     // u16
  liquidation_cranker_fee_share_bps: 178, // u16
  maintenance_cranker_fee_share_bps: 180, // u16
  backing_trade_fee_bps_long: 182,     // u16
  unit_scale: 184,                     // u32
  conf_filter_bps: 188,                // u16
  backing_trade_fee_bps_short: 190,    // u16
  insurance_withdraw_deposits_only: 192, // u8
  oracle_mode: 193,                    // u8  (asset-0 oracle config now inline)
  oracle_leg_count: 194,               // u8
  oracle_leg_flags: 195,               // u8
  invert: 196,                         // u8
  // 197 _padding (u8)
  free_market_slot_count: 198,         // u16  (was at WC start of MG.config in old)
  insurance_withdraw_cooldown_slots: 200, // u64
  last_insurance_withdraw_slot: 208,
  max_staleness_secs: 216,
  hybrid_soft_stale_slots: 224,
  mark_ewma_e6: 232,
  mark_ewma_last_slot: 240,
  mark_ewma_halflife_slots: 248,
  mark_min_fee: 256,
  oracle_target_price_e6: 264,
  oracle_target_publish_time: 272,     // i64
  oracle_leg_feeds: 280,               // 3 × [u8;32] = 96 B
  oracle_leg_prices_e6: 376,           // 3 × u64 = 24 B
  oracle_leg_publish_times: 400,       // 3 × i64 = 24 B
  backing_trade_fee_policy_count: 424, // u16
  backing_trade_fee_insurance_share_bps_long: 426,  // u16
  backing_trade_fee_insurance_share_bps_short: 428, // u16
  fee_redirect_to_market_0_bps: 430,   // u16  (ends at 432)
} as const;

// ---------- Per-asset oracle profile (slot wrapper storage, +0) ----------
// AssetOracleProfileV16 grew 368 → 400 (commit dba87a9). Field offsets:
export const ASSET_ORACLE_PROFILE_LEN = 400;
export const ASSET_ORACLE_WRAPPER_LEN = 512;   // the per-slot `T` storage
export const ENGINE_ASSET_SLOT_LEN = 1285;     // EngineAssetSlotV16Account
export const V16_MAX_MARKET_SLOTS = 64;        // hard ceiling
export const V16_DOMAIN_COUNT = 128;
export const DEFAULT_MARKET_SLOT_CAPACITY = 1; // initial alloc; grows on Activate

// AssetOracleProfileV16 — same as old up to insurance_authority; field set
// shrank now that the wrapper-level authorities collapsed into `marketauth`,
// but the per-slot profile still carries its own oracle authority (per-asset
// mark-pusher). Offsets verified against `cargo run --example dump_layout`.
// NB: only asset_index >= 1 uses this struct; asset 0's oracle config lives in
// WrapperConfigV16 directly.
// AssetOracleProfileV16 layout (size = 400 B, dumped via examples/dump_layout):
// the marketauth-collapse comment elsewhere is misleading — the per-asset profile
// still carries insurance_authority / insurance_operator / backing_bucket_authority
// slots; they're just mirrored from `marketauth` in the wrapper code path, but
// `UpdateAssetAuthority` (tag 65) reads and writes them independently.
export const AOP = {
  oracle_mode: 0,                      // u8
  oracle_leg_count: 1,                 // u8
  oracle_leg_flags: 2,                 // u8
  invert: 3,                           // u8
  unit_scale: 4,                       // u32
  conf_filter_bps: 8,                  // u16
  backing_trade_fee_bps_long: 10,      // u16
  backing_trade_fee_bps_short: 12,     // u16
  backing_trade_fee_insurance_share_bps_long: 14,
  backing_trade_fee_insurance_share_bps_short: 16,
  // 18..24 _padding0 (6 B)
  insurance_authority: 24,             // [u8;32]
  insurance_operator: 56,              // [u8;32]
  backing_bucket_authority: 88,        // [u8;32]
  oracle_authority: 120,               // [u8;32]
  max_staleness_secs: 152,             // u64
  hybrid_soft_stale_slots: 160,        // u64
  mark_ewma_e6: 168,                   // u64
  mark_ewma_last_slot: 176,            // u64
  mark_ewma_halflife_slots: 184,       // u64
  mark_min_fee: 192,                   // u64
  oracle_target_price_e6: 200,         // u64
  oracle_target_publish_time: 208,     // i64
  last_good_oracle_slot: 216,          // u64
  oracle_leg_feeds: 224,               // 3 × [u8;32] = 96 B
  oracle_leg_prices_e6: 320,           // 3 × u64 = 24 B
  oracle_leg_publish_times: 344,       // 3 × i64 = 24 B  (ends at 368)
  asset_admin: 368,                    // [u8;32]  (ends at 400)
} as const;

// ---------- MarketGroup ----------
// Layout: [HEADER(16)][WRAPPER_CONFIG(432)][MarketGroupHeader(710)][slots × N]
// Each slot = oracle storage(512) + EngineAssetSlot(1285) = 1797 B.
export const MARKET_GROUP_OFF = HEADER_LEN + WRAPPER_CONFIG_LEN; // 448
export const MARKET_GROUP_HEADER_LEN = 710;
export const ASSET_SLOT_LEN = ASSET_ORACLE_WRAPPER_LEN + ENGINE_ASSET_SLOT_LEN; // 1797
// Helper for smoke account allocation. Old MARKET_ACCOUNT_LEN assumed 64 slots;
// new model defaults to 1 and grows.
export function marketAccountLenFor(slotCapacity: number): number {
  return MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN + slotCapacity * ASSET_SLOT_LEN;
}
// Default 4-slot smoke market: 448 + 710 + 4*1797 = 8346.
export const MARKET_ACCOUNT_LEN = marketAccountLenFor(4);
// Old name kept for compat; resolves to the same 4-slot smoke default.
export const MARKET_GROUP_LEN = MARKET_GROUP_HEADER_LEN + 4 * ASSET_SLOT_LEN;

export const V16_MAX_ASSETS = V16_MAX_MARKET_SLOTS;
export const ORACLE_LEG_CAP = 3;

// MarketGroupV16HeaderAccount (710 B, align=1). Field offsets from dump_layout.
export const MG = {
  market_group_id: 0,                  // [u8;32]
  config: 32,                          // V16ConfigAccount (249 B)
  asset_slot_capacity: 281,            // u32
  vault: 285,                          // u128
  insurance: 301,
  c_tot: 317,
  pnl_pos_tot: 333,
  pnl_pos_bound_tot_num: 349,          // NEW
  pnl_pos_bound_tot: 365,
  pnl_matured_pos_tot: 381,            // NEW
  // 397..469 — 72-byte accounting block (audit/proof state; not parsed for smoke)
  materialized_portfolio_count: 469,   // u64  (was 397 in old layout)
  stale_certificate_count: 477,
  b_stale_account_count: 485,
  negative_pnl_account_count: 493,
  risk_epoch: 501,
  asset_set_epoch: 509,
  asset_activation_count: 517,
  last_asset_activation_slot: 525,
  next_market_id: 533,
  oracle_epoch: 541,
  funding_epoch: 549,
  slot_last: 557,
  current_slot: 565,
  bankruptcy_hlock_active: 573,
  threshold_stress_active: 574,
  loss_stale_active: 575,
  recovery_reason: 576,                // u8 (single byte now; was 2 bytes present+value)
  // 577 _padding
  mode: 578,                           // u8
  resolved_slot: 579,
  payout_snapshot: 587,
  payout_snapshot_pnl_pos_tot: 603,
  payout_snapshot_captured: 619,
  resolved_payout_ledger: 620,         // 90 B → ends at 710
  asset_slots: MARKET_GROUP_HEADER_LEN, // 710 (asset slots start here)
} as const;

// ---------- AssetStateV16Account (499 B, unchanged in this round) ----------
export const ASSET_LEN = 499;
export const AS = {
  market_id: 0,
  retired_slot: 8,
  lifecycle: 16,
  raw_oracle_target_price: 17,
  effective_price: 25,
  fund_px_last: 33,
  slot_last: 41,
  a_long: 49,
  a_short: 65,
  k_long: 81,
  k_short: 97,
  f_long_num: 113,
  f_short_num: 129,
  k_epoch_start_long: 145,
  k_epoch_start_short: 161,
  f_epoch_start_long_num: 177,
  f_epoch_start_short_num: 193,
  b_long_num: 209,
  b_short_num: 225,
  b_epoch_start_long_num: 241,
  b_epoch_start_short_num: 257,
  oi_eff_long_q: 273,
  oi_eff_short_q: 289,
  stored_pos_count_long: 305,
  stored_pos_count_short: 313,
  stale_account_count_long: 321,
  stale_account_count_short: 329,
  pending_obligation_count_long: 337,
  pending_obligation_count_short: 345,
  loss_weight_sum_long: 353,
  loss_weight_sum_short: 369,
  social_loss_remainder_long_num: 385,
  social_loss_remainder_short_num: 401,
  social_loss_dust_long_num: 417,
  social_loss_dust_short_num: 433,
  explicit_unallocated_loss_long: 449,
  explicit_unallocated_loss_short: 465,
  epoch_long: 481,
  epoch_short: 489,
  mode_long: 497,
  mode_short: 498,
} as const;

// ---------- Portfolio (9,227 B state + 16 B header + 104 B matcher config tail = 9,347 total) ----------
// PortfolioAccountV16Account shrank from 22,363 → 9,179 (source-domain claims
// compacted into a fixed inline sparse array, 32 slots × 196 B = 6,272 B).
// 7144d9b: appended 104-byte PortfolioMatcherConfigV16 tail (matcher_program +
// matcher_context + matcher_delegate + enabled u8 + 7 B padding).
// 0f87dcb: PortfolioAccount header gained 48 bytes (3 × u128) for monotonic
// residual-reward counters between reserved_pnl and fee_credits:
//   residual_crystallized_loss_atoms_total  (180..196)
//   residual_spent_principal_atoms_total    (196..212)
//   residual_received_atoms_total           (212..228)
// All later fields shifted by 48 bytes; PORTFOLIO_STATE_LEN: 9179 → 9227.
export const PORTFOLIO_STATE_LEN = 9227;
export const PORTFOLIO_ENGINE_ACCOUNT_LEN = HEADER_LEN + PORTFOLIO_STATE_LEN; // 9243
export const PORTFOLIO_MATCHER_CONFIG_LEN = 104;
export const PORTFOLIO_MATCHER_CONFIG_OFF = PORTFOLIO_ENGINE_ACCOUNT_LEN; // 9243
export const PORTFOLIO_ACCOUNT_LEN = PORTFOLIO_ENGINE_ACCOUNT_LEN + PORTFOLIO_MATCHER_CONFIG_LEN; // 9347
export const PORTFOLIO_STATE_OFF = HEADER_LEN; // 16

// PortfolioAccountV16Account inline field offsets (within state region):
// legs[16] at 276 (16 × 144 = 2304 → ends at 2580)
// source_domains[32] at 2580 (32 × 196 = 6272 → ends at 8852)
// then health_cert(121) close_progress(184) resolved_payout_receipt(66).
export const PA = {
  provenance_header: 0,                          // 100 B
  owner: 100,                                    // 32 B
  capital: 132,                                  // u128
  pnl: 148,                                      // i128
  reserved_pnl: 164,                             // u128
  residual_crystallized_loss_atoms_total: 180,   // u128  (NEW in 0f87dcb)
  residual_spent_principal_atoms_total: 196,     // u128  (NEW in 0f87dcb)
  residual_received_atoms_total: 212,            // u128  (NEW in 0f87dcb)
  fee_credits: 228,                              // i128
  cancel_deposit_escrow: 244,                    // u128
  last_fee_slot: 260,                            // u64
  active_bitmap: 268,                            // [u64; 1]
  legs: 276,                                     // 16 × 144 = 2304 → ends at 2580
  source_domains: 2580,                          // 32 × 196 = 6272 → ends at 8852
  health_cert: 8852,                             // 121 B
  stale_state: 8973,                             // u8
  b_stale_state: 8974,                           // u8
  rebalance_lock: 8975,                          // u8
  liquidation_lock: 8976,                        // u8
  close_progress: 8977,                          // 184 B
  resolved_payout_receipt: 9161,                 // 66 B → struct end at 9227
} as const;

// ---------- PortfolioLegV16Account (144 B, unchanged) ----------
export const LEG_LEN = 144;
export const PL = {
  active: 0,
  asset_index: 1,                      // u32
  market_id: 5,                        // u64
  side: 13,                            // u8
  basis_pos_q: 14,                     // i128
  a_basis: 30,
  k_snap: 46,                          // i128
  f_snap: 62,
  epoch_snap: 78,                      // u64
  loss_weight: 86,                     // u128
  b_snap: 102,
  b_rem: 118,
  b_epoch_snap: 134,                   // u64
  b_stale: 142,                        // u8
  stale: 143,                          // u8
} as const;

// ---------- Provenance header (100 B; inside portfolio) ----------
export const PROVENANCE_LEN = 100;
export const PROV = {
  market_group_id: 0,
  portfolio_account_id: 32,
  owner: 64,
  version: 96,
  layout_discriminator: 98,
} as const;

// ---------- Misc enums ----------
export const MarketMode = {
  Live: 0,
  Resolved: 1,
} as const;

export const OracleMode = {
  Manual: 0,
  HybridAfterHours: 1,
  Hyperp: 2,
  AuthMark: 3,
} as const;

export const SideMode = {
  Normal: 0,
  DrainOnly: 1,
  ResetPending: 2,
} as const;

export const AssetLifecycle = {
  Disabled: 0,
  PendingActivation: 1,
  Active: 2,
  DrainOnly: 3,
  Retired: 4,
  Recovery: 5,
} as const;

export const ORACLE_LEG_FLAG_DIVIDE_LEG2 = 0x01;
export const ORACLE_LEG_FLAG_DIVIDE_LEG3 = 0x02;

export const OracleProvider = {
  PYTH_RECEIVER: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
  SWITCHBOARD_ONDEMAND_MAINNET: "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv",
  SWITCHBOARD_ONDEMAND_DEVNET: "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2",
  CHAINLINK_STORE: "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny",
} as const;

export const SwitchboardPullFeed = {
  discriminator: Buffer.from([196, 27, 108, 196, 10, 215, 219, 40]),
  minLen: 3_208,
} as const;
export const ChainlinkFeed = {
  discriminator: Buffer.from([96, 179, 69, 66, 128, 129, 73, 117]),
  minLen: 8 + 192 + 48,
} as const;
export const PythPriceUpdateV2 = {
  minLen: 134,
} as const;

export const AssetAction = {
  Activate: 0,
  DrainOnly: 1,
  Retire: 2,
  Shutdown: 3,
} as const;

// commit 792256b collapsed authority kinds — only `marketauth` (kind 0) remains
// for market-level rotation; per-asset oracle_authority is rotated via the
// per-asset path. `Asset` (kind 5) was retired with the authority collapse.
export const AuthorityKind = {
  MarketAuth: 0,
  // legacy aliases (now all alias 0 — kept for any old call sites that compile but
  // may reject at the program if it validates kind strictly; preferred is MarketAuth):
  Admin: 0,
  HyperpMark: 0,
  Insurance: 0,
  BackingBucket: 0,
  InsuranceOperator: 0,
  Asset: 0,
} as const;
