/**
 * v16 account-layout constants for percolator-prog HEAD `ea7ef40`
 * ("add v16 primary secondary base unit custody"), engine pin
 * `23de295`.
 *
 * Offsets are derived directly from the `#[repr(C)]` bytemuck::Pod struct
 * definitions in src/v16_program.rs (wrapper structs, native alignment)
 * and percolator/src/v16.rs (engine structs, byte-array-backed → align 1).
 * Wrapper structs have explicit padding fields (Pod forbids implicit
 * padding), so offsets are exact field-size sums.
 */

// ---------- Header ----------
export const MAGIC = 0x5045_5243_5631_3600n; // "PERCV16\0"
export const VERSION = 16;
export const KIND_MARKET = 1;
export const KIND_PORTFOLIO = 2;
export const HEADER_LEN = 16;

// ---------- WrapperConfigV16 (624 B, immediately after header) ----------
// Grew 544 → 624 in commits 05a8f84 + ea7ef40:
//   + secondary_collateral_mint [u8;32]  (custody / dual-collateral)
//   + base_unit_authority      [u8;32]
//   + permissionless_market_init_fee u128
//   + backing_trade_fee_bps_long/short u16
//   + backing_trade_fee_policy_count u16
//   + backing_trade_fee_insurance_share_bps_long/short u16
//   + fee_redirect_to_market_0_bps u16  (replaced the old 8 B tail padding)
// All native-aligned; struct align = 16 (u128), total 624 (multiple of 16).
export const WRAPPER_CONFIG_LEN = 624;
export const WRAPPER_CONFIG_OFF = HEADER_LEN; // 16

export const WC = {
  admin: 0,
  collateral_mint: 32,
  secondary_collateral_mint: 64,       // NEW [u8;32]
  base_unit_authority: 96,             // NEW [u8;32]
  maintenance_fee_per_slot: 128,       // u128
  permissionless_market_init_fee: 144, // NEW u128
  trade_fee_base_bps: 160,             // u64
  permissionless_resolve_stale_slots: 168,
  force_close_delay_slots: 176,
  last_good_oracle_slot: 184,
  insurance_authority: 192,
  insurance_operator: 224,
  backing_bucket_authority: 256,
  asset_authority: 288,
  hyperp_mark_authority: 320,
  insurance_withdraw_deposit_remaining: 352, // u128
  insurance_withdraw_max_bps: 368,     // u16
  liquidation_cranker_fee_share_bps: 370, // u16
  maintenance_cranker_fee_share_bps: 372, // u16
  backing_trade_fee_bps_long: 374,     // NEW u16
  unit_scale: 376,                     // u32
  conf_filter_bps: 380,                // u16
  backing_trade_fee_bps_short: 382,    // NEW u16
  insurance_withdraw_deposits_only: 384, // u8
  oracle_mode: 385,                    // u8
  oracle_leg_count: 386,               // u8
  oracle_leg_flags: 387,               // u8
  invert: 388,                         // u8
  // 389 _padding0 (u8); 390..392 _padding1 ([u8;2])
  insurance_withdraw_cooldown_slots: 392, // u64
  last_insurance_withdraw_slot: 400,
  max_staleness_secs: 408,
  hybrid_soft_stale_slots: 416,
  mark_ewma_e6: 424,
  mark_ewma_last_slot: 432,
  mark_ewma_halflife_slots: 440,
  mark_min_fee: 448,
  oracle_target_price_e6: 456,
  oracle_target_publish_time: 464,     // i64
  oracle_leg_feeds: 472,               // 3 × [u8;32] = 96 B
  oracle_leg_prices_e6: 568,           // 3 × u64 = 24 B
  oracle_leg_publish_times: 592,       // 3 × i64 = 24 B
  backing_trade_fee_policy_count: 616, // NEW u16
  backing_trade_fee_insurance_share_bps_long: 618,  // NEW u16
  backing_trade_fee_insurance_share_bps_short: 620, // NEW u16
  fee_redirect_to_market_0_bps: 622,   // NEW u16  (ends at 624)
} as const;

// ---------- Per-asset oracle profile (lives at the START of each slot) ----------
// A market slot is engine `Market<T> = { wrapper: T, engine }` where T is the
// per-slot oracle storage `[u8; ASSET_ORACLE_WRAPPER_LEN]`. The wrapper writes
// an `AssetOracleProfileV16` (368 B) at offset 0 of that storage; the engine
// `EngineAssetSlotV16Account` (1285 B) follows it. So within a slot:
//   [0 .. 512)            oracle storage  (AssetOracleProfileV16 at +0)
//   [512 .. 512+1285)     engine slot     (AssetStateV16Account at +0)
// AssetOracleProfileV16 grew 232 → 368 and the storage wrapper 256 → 512 in
// commits 05a8f84 + ea7ef40 (added per-asset insurance/operator/backing/oracle
// authorities + last_good_oracle_slot + backing-trade-fee fields).
export const ASSET_ORACLE_PROFILE_LEN = 368;
export const ASSET_ORACLE_WRAPPER_LEN = 512;   // the `T` storage; engine slot follows
export const ENGINE_ASSET_SLOT_LEN = 1285;     // EngineAssetSlotV16Account (engine pin 23de295)
export const V16_MAX_MARKET_SLOTS = 64;
export const V16_DOMAIN_COUNT = 128;

// AssetOracleProfileV16 field offsets (within the slot's oracle storage, +0).
export const AOP = {
  oracle_mode: 0,                      // u8
  oracle_leg_count: 1,                 // u8
  oracle_leg_flags: 2,                 // u8
  invert: 3,                           // u8
  unit_scale: 4,                       // u32
  conf_filter_bps: 8,                  // u16
  backing_trade_fee_bps_long: 10,      // u16
  backing_trade_fee_bps_short: 12,     // u16
  backing_trade_fee_insurance_share_bps_long: 14,  // u16
  backing_trade_fee_insurance_share_bps_short: 16, // u16
  // 18..24 _padding0 ([u8;6])
  insurance_authority: 24,             // [u8;32]
  insurance_operator: 56,              // [u8;32]
  backing_bucket_authority: 88,        // [u8;32]
  oracle_authority: 120,               // [u8;32]
  max_staleness_secs: 152,             // u64
  hybrid_soft_stale_slots: 160,
  mark_ewma_e6: 168,
  mark_ewma_last_slot: 176,
  mark_ewma_halflife_slots: 184,
  mark_min_fee: 192,
  oracle_target_price_e6: 200,
  oracle_target_publish_time: 208,     // i64
  last_good_oracle_slot: 216,          // u64
  oracle_leg_feeds: 224,               // 3 × [u8;32] = 96 B
  oracle_leg_prices_e6: 320,           // 3 × u64 = 24 B
  oracle_leg_publish_times: 344,       // 3 × i64 = 24 B  (ends at 368)
} as const;

// ---------- MarketGroup (engine pin 23de295, wrapper ea7ef40) ----------
// Layout: [HEADER(16)][WRAPPER_CONFIG(624)][MarketGroupHeader(638)][slots × 64]
// Each slot = oracle storage(512) + EngineAssetSlot(1285) = 1797 B.
export const MARKET_GROUP_OFF = HEADER_LEN + WRAPPER_CONFIG_LEN; // 640
export const MARKET_GROUP_HEADER_LEN = 638;                      // size_of::<MarketGroupV16HeaderAccount>()
// Per-slot stride — oracle storage(512) + EngineAssetSlot(1285) = 1797.
export const ASSET_SLOT_LEN = ASSET_ORACLE_WRAPPER_LEN + ENGINE_ASSET_SLOT_LEN; // 1797
export const MARKET_GROUP_LEN = MARKET_GROUP_HEADER_LEN + V16_MAX_MARKET_SLOTS * ASSET_SLOT_LEN; // 638+115008=115646
export const MARKET_ACCOUNT_LEN = MARKET_GROUP_OFF + MARKET_GROUP_LEN;  // 116286 (capacity 64)

// (kept for backward-compat with older parsers; the new layout uses V16_MAX_MARKET_SLOTS=64)
export const V16_MAX_ASSETS = V16_MAX_MARKET_SLOTS;
export const ORACLE_LEG_CAP = 3;

// Field offsets in MarketGroupHeader (engine 23de295). Byte-array-backed Pod
// integers → align 1 → offsets are exact field-size sums. V16ConfigAccount=249 B.
export const MG = {
  market_group_id: 0,                  // [u8;32]
  config: 32,                          // V16ConfigAccount (249 B)
  asset_slot_capacity: 281,            // u32
  vault: 285,                          // u128
  insurance: 301,
  c_tot: 317,
  pnl_pos_tot: 333,
  pnl_pos_bound_tot_num: 349,
  pnl_pos_bound_tot: 365,
  pnl_matured_pos_tot: 381,
  materialized_portfolio_count: 397,   // u64
  stale_certificate_count: 405,
  b_stale_account_count: 413,
  negative_pnl_account_count: 421,
  risk_epoch: 429,
  asset_set_epoch: 437,
  asset_activation_count: 445,
  last_asset_activation_slot: 453,
  next_market_id: 461,
  oracle_epoch: 469,
  funding_epoch: 477,
  slot_last: 485,
  current_slot: 493,
  // ---- tail (within the 638 B header, after current_slot) ----
  bankruptcy_hlock_active: 501,        // u8
  threshold_stress_active: 502,        // u8
  loss_stale_active: 503,              // u8
  recovery_reason_present: 504,        // u8  (V16OptionalRecoveryReasonAccount.present)
  recovery_reason_value: 505,          // u8  (.value)
  mode: 506,                           // u8
  resolved_slot: 507,                  // u64
  payout_snapshot: 515,                // u128
  payout_snapshot_pnl_pos_tot: 531,    // u128
  payout_snapshot_captured: 547,       // u8
  resolved_payout_ledger: 548,         // ResolvedPayoutLedgerV16Account (90 B → ends at 638)
  asset_slots: MARKET_GROUP_HEADER_LEN,  // 638
} as const;

// ---------- AssetStateV16Account (499 B) ----------
// Two new u64 fields prepended in commits 5741bb9/b4ff060:
//   market_id (u64), retired_slot (u64) → +16 bytes prefix
export const ASSET_LEN = 499;
export const AS = {
  market_id: 0,                        // NEW u64
  retired_slot: 8,                     // NEW u64
  lifecycle: 16,                       // u8
  raw_oracle_target_price: 17,         // u64
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

// ---------- Portfolio (22,363 B state + 16 B header = 22,379 total) ----------
// Offsets from dump_layout @ commit 689b90e. source_claim_market_id is now
// [u128; 64] = 1024 B (was [u64; 32]); each source_claim_* domain array is
// [u128; 128] = 2048 B (D=128). PortfolioLeg widened to 144 B × 16 = 2304 B.
// CloseProgressLedger 184 B.
export const PORTFOLIO_STATE_LEN = 22363;
export const PORTFOLIO_ACCOUNT_LEN = HEADER_LEN + PORTFOLIO_STATE_LEN; // 22379
export const PORTFOLIO_STATE_OFF = HEADER_LEN; // 16

export const PA = {
  provenance_header: 0,                // 100 B
  owner: 100,                          // 32 B
  capital: 132,                        // u128
  pnl: 148,                            // i128
  reserved_pnl: 164,                   // u128
  source_claim_market_id: 180,         // [u128; 64] = 1024 B
  source_claim_bound_num: 1204,        // [u128; 128] = 2048 B
  source_claim_liened_num: 3252,
  source_claim_counterparty_liened_num: 5300,
  source_claim_insurance_liened_num: 7348,
  source_lien_effective_reserved: 9396,
  source_lien_counterparty_backing_num: 11444,
  source_lien_insurance_backing_num: 13492,
  source_claim_impaired_num: 15540,
  source_lien_impaired_effective_reserved: 17588,
  fee_credits: 19636,                  // i128
  cancel_deposit_escrow: 19652,
  last_fee_slot: 19668,                // u64
  active_bitmap: 19676,                // u64
  legs: 19684,                         // [PortfolioLegV16Account; 16] = 144 B × 16 = 2304
  health_cert: 21988,                  // 121 B
  stale_state: 22109,
  b_stale_state: 22110,
  rebalance_lock: 22111,
  liquidation_lock: 22112,
  close_progress: 22113,               // 184 B
  resolved_payout_receipt: 22297,      // 66 B
} as const;

// ---------- PortfolioLegV16Account (144 B, was 140) ----------
// Includes 8-byte `market_id: u64` between `active` and `side`.
export const LEG_LEN = 144;
export const PL = {
  active: 0,                           // u8
  market_id: 1,                        // NEW u64
  side: 9,                             // u8 (0 = long, 1 = short)
  basis_pos_q: 10,                     // i128
  a_basis: 26,                         // u128
  k_snap: 42,                          // i128
  f_snap: 58,
  epoch_snap: 74,                      // u64
  loss_weight: 82,                     // u128
  b_snap: 98,
  b_rem: 114,
  b_epoch_snap: 130,                   // u64
  b_stale: 138,                        // u8
  stale: 139,                          // u8
} as const;

// ---------- Provenance header (100 B; inside portfolio) ----------
export const PROVENANCE_LEN = 100;
export const PROV = {
  market_group_id: 0,         // [u8; 32]  (this is the market account pubkey)
  portfolio_account_id: 32,   // [u8; 32]  (this account's own pubkey)
  owner: 64,                  // [u8; 32]
  version: 96,                // u16
  layout_discriminator: 98,   // u16
} as const;

// ---------- Misc enums ----------
export const MarketMode = {
  Live: 0,
  Resolved: 1,
  // (others exist in engine; treat unknown as opaque)
} as const;

export const OracleMode = {
  Manual: 0,
  HybridAfterHours: 1,
  Hyperp: 2,
} as const;

export const SideMode = {
  Normal: 0,
  DrainOnly: 1,
  ResetPending: 2,
} as const;

// Source: encode_asset_lifecycle in percolator/src/v16.rs (commit a4aed26c).
// NB: AssetStateV16::default() seeds lifecycle=Active with placeholder
// price=1 for ALL 16 slots, so filter "truly activated" by
// `asset.effectivePrice != 1n` or compare against `group.assetActivationCount`.
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

// Provider program IDs dispatched by read_oracle_price_e6 (v16_program.rs ~L1944).
// Per-leg owner determines which reader runs — so a single 3-leg composite can mix providers.
export const OracleProvider = {
  PYTH_RECEIVER: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
  SWITCHBOARD_ONDEMAND_MAINNET: "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv",
  SWITCHBOARD_ONDEMAND_DEVNET: "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2",
  CHAINLINK_STORE: "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny",
} as const;

// Discriminators / dataSize hints for getProgramAccounts feed discovery.
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

// UpdateAssetLifecycle `action` codes (wrapper constants, NOT the lifecycle enum).
// Source: percolator-prog/src/v16_program.rs ASSET_ACTION_* (commit be92fe9).
export const AssetAction = {
  Activate: 0,
  DrainOnly: 1,
  Retire: 2,
} as const;

// UpdateAuthority `kind` codes (commit be92fe9 added AUTHORITY_ASSET).
export const AuthorityKind = {
  Admin: 0,
  HyperpMark: 1,
  Insurance: 2,
  BackingBucket: 3,
  InsuranceOperator: 4,
  Asset: 5,
} as const;
