/**
 * v16 account parsers: header, wrapper config, market group, portfolio.
 * Offsets sourced from src/v16/constants.ts (regenerated from
 * percolator-prog/examples/dump_layout.rs).
 */
import { PublicKey } from "@solana/web3.js";
import {
  MAGIC, VERSION, KIND_MARKET, KIND_PORTFOLIO,
  HEADER_LEN, WRAPPER_CONFIG_OFF, MARKET_GROUP_OFF, MARKET_ACCOUNT_LEN,
  PORTFOLIO_STATE_OFF, PORTFOLIO_ACCOUNT_LEN,
  WC, MG, PA, AS, PL, PROV, AOP, ASSET_LEN, ASSET_SLOT_LEN, LEG_LEN,
  ASSET_ORACLE_WRAPPER_LEN,
  V16_MAX_ASSETS, V16_DOMAIN_COUNT, ORACLE_LEG_CAP,
} from "./constants.js";

// ---------- primitive readers ----------
function u8(b: Buffer, o: number): number { return b.readUInt8(o); }
function u16(b: Buffer, o: number): number { return b.readUInt16LE(o); }
function u32(b: Buffer, o: number): number { return b.readUInt32LE(o); }
function u64(b: Buffer, o: number): bigint { return b.readBigUInt64LE(o); }
function i64(b: Buffer, o: number): bigint { return b.readBigInt64LE(o); }
function u128(b: Buffer, o: number): bigint {
  return b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
}
function i128(b: Buffer, o: number): bigint {
  const u = u128(b, o);
  return u < (1n << 127n) ? u : u - (1n << 128n);
}
function pk(b: Buffer, o: number): PublicKey { return new PublicKey(b.subarray(o, o + 32)); }
function hex(b: Buffer, o: number, len: number): string { return b.subarray(o, o + len).toString("hex"); }

// ---------- Header ----------
export interface Header {
  magic: bigint;
  version: number;
  kind: number;
}
export function parseHeader(data: Buffer): Header {
  if (data.length < HEADER_LEN) throw new Error(`buf too small: ${data.length}`);
  return { magic: u64(data, 0), version: u16(data, 8), kind: u8(data, 10) };
}
export function isMarket(data: Buffer): boolean {
  const h = parseHeader(data);
  return h.magic === MAGIC && h.version === VERSION && h.kind === KIND_MARKET;
}
export function isPortfolio(data: Buffer): boolean {
  const h = parseHeader(data);
  return h.magic === MAGIC && h.version === VERSION && h.kind === KIND_PORTFOLIO;
}

// ---------- WrapperConfigV16 ----------
export interface WrapperConfig {
  admin: PublicKey;
  collateralMint: PublicKey;
  secondaryCollateralMint: PublicKey;        // NEW (ea7ef40)
  baseUnitAuthority: PublicKey;              // NEW (ea7ef40)
  maintenanceFeePerSlot: bigint;
  permissionlessMarketInitFee: bigint;       // NEW (ea7ef40)
  tradeFeeBaseBps: bigint;
  permissionlessResolveStaleSlots: bigint;
  forceCloseDelaySlots: bigint;
  lastGoodOracleSlot: bigint;
  insuranceAuthority: PublicKey;
  insuranceOperator: PublicKey;
  backingBucketAuthority: PublicKey;
  assetAuthority: PublicKey;
  hyperpMarkAuthority: PublicKey;
  insuranceWithdrawDepositRemaining: bigint;
  insuranceWithdrawMaxBps: number;
  liquidationCrankerFeeShareBps: number;
  maintenanceCrankerFeeShareBps: number;     // present since 689b90e
  backingTradeFeeBpsLong: number;            // NEW (05a8f84)
  backingTradeFeeBpsShort: number;           // NEW (05a8f84)
  unitScale: number;
  confFilterBps: number;
  insuranceWithdrawDepositsOnly: number;
  oracleMode: number;
  oracleLegCount: number;
  oracleLegFlags: number;
  invert: number;
  insuranceWithdrawCooldownSlots: bigint;
  lastInsuranceWithdrawSlot: bigint;
  maxStalenessSecs: bigint;
  hybridSoftStaleSlots: bigint;
  markEwmaE6: bigint;
  markEwmaLastSlot: bigint;
  markEwmaHalflifeSlots: bigint;
  markMinFee: bigint;
  oracleTargetPriceE6: bigint;
  oracleTargetPublishTime: bigint;
  oracleLegFeeds: string[];
  oracleLegPricesE6: bigint[];
  oracleLegPublishTimes: bigint[];
  backingTradeFeePolicyCount: number;                  // NEW (05a8f84)
  backingTradeFeeInsuranceShareBpsLong: number;        // NEW (05a8f84)
  backingTradeFeeInsuranceShareBpsShort: number;       // NEW (05a8f84)
  feeRedirectToMarket0Bps: number;                     // NEW (ea7ef40)
}

export function parseWrapperConfig(data: Buffer): WrapperConfig {
  const b = WRAPPER_CONFIG_OFF;
  const legFeeds: string[] = [];
  for (let i = 0; i < ORACLE_LEG_CAP; i++) {
    legFeeds.push(hex(data, b + WC.oracle_leg_feeds + i * 32, 32));
  }
  const legPrices: bigint[] = [];
  for (let i = 0; i < ORACLE_LEG_CAP; i++) {
    legPrices.push(u64(data, b + WC.oracle_leg_prices_e6 + i * 8));
  }
  const legTimes: bigint[] = [];
  for (let i = 0; i < ORACLE_LEG_CAP; i++) {
    legTimes.push(i64(data, b + WC.oracle_leg_publish_times + i * 8));
  }
  return {
    admin: pk(data, b + WC.admin),
    collateralMint: pk(data, b + WC.collateral_mint),
    secondaryCollateralMint: pk(data, b + WC.secondary_collateral_mint),
    baseUnitAuthority: pk(data, b + WC.base_unit_authority),
    maintenanceFeePerSlot: u128(data, b + WC.maintenance_fee_per_slot),
    permissionlessMarketInitFee: u128(data, b + WC.permissionless_market_init_fee),
    tradeFeeBaseBps: u64(data, b + WC.trade_fee_base_bps),
    permissionlessResolveStaleSlots: u64(data, b + WC.permissionless_resolve_stale_slots),
    forceCloseDelaySlots: u64(data, b + WC.force_close_delay_slots),
    lastGoodOracleSlot: u64(data, b + WC.last_good_oracle_slot),
    insuranceAuthority: pk(data, b + WC.insurance_authority),
    insuranceOperator: pk(data, b + WC.insurance_operator),
    backingBucketAuthority: pk(data, b + WC.backing_bucket_authority),
    assetAuthority: pk(data, b + WC.asset_authority),
    hyperpMarkAuthority: pk(data, b + WC.hyperp_mark_authority),
    insuranceWithdrawDepositRemaining: u128(data, b + WC.insurance_withdraw_deposit_remaining),
    insuranceWithdrawMaxBps: u16(data, b + WC.insurance_withdraw_max_bps),
    liquidationCrankerFeeShareBps: u16(data, b + WC.liquidation_cranker_fee_share_bps),
    maintenanceCrankerFeeShareBps: u16(data, b + WC.maintenance_cranker_fee_share_bps),
    backingTradeFeeBpsLong: u16(data, b + WC.backing_trade_fee_bps_long),
    backingTradeFeeBpsShort: u16(data, b + WC.backing_trade_fee_bps_short),
    unitScale: u32(data, b + WC.unit_scale),
    confFilterBps: u16(data, b + WC.conf_filter_bps),
    insuranceWithdrawDepositsOnly: u8(data, b + WC.insurance_withdraw_deposits_only),
    oracleMode: u8(data, b + WC.oracle_mode),
    oracleLegCount: u8(data, b + WC.oracle_leg_count),
    oracleLegFlags: u8(data, b + WC.oracle_leg_flags),
    invert: u8(data, b + WC.invert),
    insuranceWithdrawCooldownSlots: u64(data, b + WC.insurance_withdraw_cooldown_slots),
    lastInsuranceWithdrawSlot: u64(data, b + WC.last_insurance_withdraw_slot),
    maxStalenessSecs: u64(data, b + WC.max_staleness_secs),
    hybridSoftStaleSlots: u64(data, b + WC.hybrid_soft_stale_slots),
    markEwmaE6: u64(data, b + WC.mark_ewma_e6),
    markEwmaLastSlot: u64(data, b + WC.mark_ewma_last_slot),
    markEwmaHalflifeSlots: u64(data, b + WC.mark_ewma_halflife_slots),
    markMinFee: u64(data, b + WC.mark_min_fee),
    oracleTargetPriceE6: u64(data, b + WC.oracle_target_price_e6),
    oracleTargetPublishTime: i64(data, b + WC.oracle_target_publish_time),
    oracleLegFeeds: legFeeds,
    oracleLegPricesE6: legPrices,
    oracleLegPublishTimes: legTimes,
    backingTradeFeePolicyCount: u16(data, b + WC.backing_trade_fee_policy_count),
    backingTradeFeeInsuranceShareBpsLong: u16(data, b + WC.backing_trade_fee_insurance_share_bps_long),
    backingTradeFeeInsuranceShareBpsShort: u16(data, b + WC.backing_trade_fee_insurance_share_bps_short),
    feeRedirectToMarket0Bps: u16(data, b + WC.fee_redirect_to_market_0_bps),
  };
}

// ---------- AssetStateV16 ----------
export interface AssetState {
  index: number;
  marketId: bigint;         // NEW (commit 4942e45 + earlier prefix)
  retiredSlot: bigint;
  lifecycle: number;
  rawOracleTargetPrice: bigint;
  effectivePrice: bigint;
  fundPxLast: bigint;
  slotLast: bigint;
  aLong: bigint; aShort: bigint;
  kLong: bigint; kShort: bigint;
  fLongNum: bigint; fShortNum: bigint;
  oiEffLongQ: bigint; oiEffShortQ: bigint;
  storedPosCountLong: bigint; storedPosCountShort: bigint;
  modeLong: number; modeShort: number;
  epochLong: bigint; epochShort: bigint;
}

export function parseAsset(data: Buffer, baseOff: number, index: number): AssetState {
  const b = baseOff;
  return {
    index,
    marketId: u64(data, b + AS.market_id),
    retiredSlot: u64(data, b + AS.retired_slot),
    lifecycle: u8(data, b + AS.lifecycle),
    rawOracleTargetPrice: u64(data, b + AS.raw_oracle_target_price),
    effectivePrice: u64(data, b + AS.effective_price),
    fundPxLast: u64(data, b + AS.fund_px_last),
    slotLast: u64(data, b + AS.slot_last),
    aLong: u128(data, b + AS.a_long), aShort: u128(data, b + AS.a_short),
    kLong: i128(data, b + AS.k_long), kShort: i128(data, b + AS.k_short),
    fLongNum: i128(data, b + AS.f_long_num), fShortNum: i128(data, b + AS.f_short_num),
    oiEffLongQ: u128(data, b + AS.oi_eff_long_q),
    oiEffShortQ: u128(data, b + AS.oi_eff_short_q),
    storedPosCountLong: u64(data, b + AS.stored_pos_count_long),
    storedPosCountShort: u64(data, b + AS.stored_pos_count_short),
    modeLong: u8(data, b + AS.mode_long), modeShort: u8(data, b + AS.mode_short),
    epochLong: u64(data, b + AS.epoch_long), epochShort: u64(data, b + AS.epoch_short),
  };
}

// ---------- AssetOracleProfileV16 (per-slot, at oracle-storage offset 0) ----------
export interface AssetOracleProfile {
  index: number;
  oracleMode: number;
  oracleLegCount: number;
  oracleLegFlags: number;
  invert: number;
  unitScale: number;
  confFilterBps: number;
  backingTradeFeeBpsLong: number;
  backingTradeFeeBpsShort: number;
  backingTradeFeeInsuranceShareBpsLong: number;
  backingTradeFeeInsuranceShareBpsShort: number;
  insuranceAuthority: PublicKey;
  insuranceOperator: PublicKey;
  backingBucketAuthority: PublicKey;
  oracleAuthority: PublicKey;
  maxStalenessSecs: bigint;
  hybridSoftStaleSlots: bigint;
  markEwmaE6: bigint;
  markEwmaHalflifeSlots: bigint;
  markMinFee: bigint;
  oracleTargetPriceE6: bigint;
  oracleTargetPublishTime: bigint;
  lastGoodOracleSlot: bigint;
  oracleLegFeeds: string[];
  oracleLegPricesE6: bigint[];
  oracleLegPublishTimes: bigint[];
}

// `slotOff` is the start of the slot (= MARKET_GROUP_OFF + MG.asset_slots + i*ASSET_SLOT_LEN);
// the profile sits at slotOff + 0 (engine `Market<T>` puts the oracle storage first).
export function parseAssetOracleProfile(data: Buffer, slotOff: number, index: number): AssetOracleProfile {
  const o = slotOff;
  const legFeeds: string[] = [];
  const legPrices: bigint[] = [];
  const legTimes: bigint[] = [];
  for (let i = 0; i < ORACLE_LEG_CAP; i++) {
    legFeeds.push(hex(data, o + AOP.oracle_leg_feeds + i * 32, 32));
    legPrices.push(u64(data, o + AOP.oracle_leg_prices_e6 + i * 8));
    legTimes.push(i64(data, o + AOP.oracle_leg_publish_times + i * 8));
  }
  return {
    index,
    oracleMode: u8(data, o + AOP.oracle_mode),
    oracleLegCount: u8(data, o + AOP.oracle_leg_count),
    oracleLegFlags: u8(data, o + AOP.oracle_leg_flags),
    invert: u8(data, o + AOP.invert),
    unitScale: u32(data, o + AOP.unit_scale),
    confFilterBps: u16(data, o + AOP.conf_filter_bps),
    backingTradeFeeBpsLong: u16(data, o + AOP.backing_trade_fee_bps_long),
    backingTradeFeeBpsShort: u16(data, o + AOP.backing_trade_fee_bps_short),
    backingTradeFeeInsuranceShareBpsLong: u16(data, o + AOP.backing_trade_fee_insurance_share_bps_long),
    backingTradeFeeInsuranceShareBpsShort: u16(data, o + AOP.backing_trade_fee_insurance_share_bps_short),
    insuranceAuthority: pk(data, o + AOP.insurance_authority),
    insuranceOperator: pk(data, o + AOP.insurance_operator),
    backingBucketAuthority: pk(data, o + AOP.backing_bucket_authority),
    oracleAuthority: pk(data, o + AOP.oracle_authority),
    maxStalenessSecs: u64(data, o + AOP.max_staleness_secs),
    hybridSoftStaleSlots: u64(data, o + AOP.hybrid_soft_stale_slots),
    markEwmaE6: u64(data, o + AOP.mark_ewma_e6),
    markEwmaHalflifeSlots: u64(data, o + AOP.mark_ewma_halflife_slots),
    markMinFee: u64(data, o + AOP.mark_min_fee),
    oracleTargetPriceE6: u64(data, o + AOP.oracle_target_price_e6),
    oracleTargetPublishTime: i64(data, o + AOP.oracle_target_publish_time),
    lastGoodOracleSlot: u64(data, o + AOP.last_good_oracle_slot),
    oracleLegFeeds: legFeeds,
    oracleLegPricesE6: legPrices,
    oracleLegPublishTimes: legTimes,
  };
}

// ---------- MarketGroupV16 ----------
export interface MarketGroup {
  marketGroupId: string;
  vault: bigint;
  insurance: bigint;
  cTot: bigint;
  pnlPosTot: bigint;
  pnlMaturedPosTot: bigint;
  materializedPortfolioCount: bigint;
  staleCertificateCount: bigint;
  bStaleAccountCount: bigint;
  negativePnlAccountCount: bigint;
  riskEpoch: bigint;
  assetSetEpoch: bigint;
  assetActivationCount: bigint;
  nextMarketId: bigint;
  oracleEpoch: bigint;
  fundingEpoch: bigint;
  slotLast: bigint;
  currentSlot: bigint;
  assets: AssetState[];
  mode: number;
  bankruptcyHlockActive: number;
  thresholdStressActive: number;
  lossStaleActive: number;
  resolvedSlot: bigint;
  payoutSnapshotCaptured: number;
  payoutSnapshot: bigint;
  payoutSnapshotPnlPosTot: bigint;
}

export function parseMarketGroup(data: Buffer): MarketGroup {
  const b = MARKET_GROUP_OFF;
  // The engine seeds all 16 asset slots with lifecycle=Active and
  // placeholder price=1, so a slot is "truly activated" only when its
  // effective_price differs from the placeholder (or oi/positions exist).
  const assets: AssetState[] = [];
  // Asset-slot capacity is DYNAMIC, not a fixed 64: the asset_slots array is the
  // trailing field of the account, and permissionless append reallocs the account
  // to grow it (asset_index+1). Derive capacity from the account data length, the
  // same way the program does (market_slot_capacity), rather than hardcoding
  // V16_MAX_MARKET_SLOTS — otherwise we'd read past a smaller account or miss the
  // slots of a grown one.
  const capacity = Math.max(0, Math.floor((data.length - b - MG.asset_slots) / ASSET_SLOT_LEN));
  for (let i = 0; i < capacity; i++) {
    // Each slot is engine `Market<T> = { wrapper: T, engine }`:
    //   [slotOff .. +512)  oracle storage (AssetOracleProfileV16 at +0)
    //   [slotOff+512 ..)   EngineAssetSlot (AssetStateV16Account at +0)
    const slotOff = b + MG.asset_slots + i * ASSET_SLOT_LEN;
    const off = slotOff + ASSET_ORACLE_WRAPPER_LEN;
    const a = parseAsset(data, off, i);
    const placeholder = a.effectivePrice === 1n
                     && a.rawOracleTargetPrice === 1n
                     && a.fundPxLast === 1n
                     && a.oiEffLongQ === 0n && a.oiEffShortQ === 0n
                     && a.storedPosCountLong === 0n && a.storedPosCountShort === 0n;
    if (!placeholder) assets.push(a);
  }
  return {
    marketGroupId: hex(data, b + MG.market_group_id, 32),
    vault: u128(data, b + MG.vault),
    insurance: u128(data, b + MG.insurance),
    cTot: u128(data, b + MG.c_tot),
    pnlPosTot: u128(data, b + MG.pnl_pos_tot),
    pnlMaturedPosTot: u128(data, b + MG.pnl_matured_pos_tot),
    materializedPortfolioCount: u64(data, b + MG.materialized_portfolio_count),
    staleCertificateCount: u64(data, b + MG.stale_certificate_count),
    bStaleAccountCount: u64(data, b + MG.b_stale_account_count),
    negativePnlAccountCount: u64(data, b + MG.negative_pnl_account_count),
    riskEpoch: u64(data, b + MG.risk_epoch),
    assetSetEpoch: u64(data, b + MG.asset_set_epoch),
    assetActivationCount: u64(data, b + MG.asset_activation_count),
    nextMarketId: u64(data, b + MG.next_market_id),
    oracleEpoch: u64(data, b + MG.oracle_epoch),
    fundingEpoch: u64(data, b + MG.funding_epoch),
    slotLast: u64(data, b + MG.slot_last),
    currentSlot: u64(data, b + MG.current_slot),
    assets,
    mode: u8(data, b + MG.mode),
    bankruptcyHlockActive: u8(data, b + MG.bankruptcy_hlock_active),
    thresholdStressActive: u8(data, b + MG.threshold_stress_active),
    lossStaleActive: u8(data, b + MG.loss_stale_active),
    resolvedSlot: u64(data, b + MG.resolved_slot),
    payoutSnapshotCaptured: u8(data, b + MG.payout_snapshot_captured),
    payoutSnapshot: u128(data, b + MG.payout_snapshot),
    payoutSnapshotPnlPosTot: u128(data, b + MG.payout_snapshot_pnl_pos_tot),
  };
}

// ---------- PortfolioLeg ----------
export interface Leg {
  index: number;
  active: number;
  side: number;            // 0 long / 1 short
  basisPosQ: bigint;       // i128
  aBasis: bigint;
  kSnap: bigint; fSnap: bigint;
  epochSnap: bigint;
  lossWeight: bigint;
  bSnap: bigint; bRem: bigint;
  bEpochSnap: bigint;
  bStale: number; stale: number;
}

export function parseLeg(data: Buffer, baseOff: number, index: number): Leg {
  const b = baseOff;
  return {
    index,
    active: u8(data, b + PL.active),
    side: u8(data, b + PL.side),
    basisPosQ: i128(data, b + PL.basis_pos_q),
    aBasis: u128(data, b + PL.a_basis),
    kSnap: i128(data, b + PL.k_snap),
    fSnap: i128(data, b + PL.f_snap),
    epochSnap: u64(data, b + PL.epoch_snap),
    lossWeight: u128(data, b + PL.loss_weight),
    bSnap: u128(data, b + PL.b_snap),
    bRem: u128(data, b + PL.b_rem),
    bEpochSnap: u64(data, b + PL.b_epoch_snap),
    bStale: u8(data, b + PL.b_stale),
    stale: u8(data, b + PL.stale),
  };
}

// ---------- PortfolioAccountV16 ----------
export interface Portfolio {
  marketGroupId: PublicKey;
  portfolioAccountId: PublicKey;
  owner: PublicKey;
  capital: bigint;
  pnl: bigint;
  reservedPnl: bigint;
  feeCredits: bigint;
  cancelDepositEscrow: bigint;
  lastFeeSlot: bigint;
  activeBitmap: bigint;     // widened to u64 in commit 5741bb9
  legs: Leg[];          // only legs flagged active=1
  staleState: number;
  bStaleState: number;
  rebalanceLock: number;
  liquidationLock: number;
}

export function parsePortfolio(data: Buffer): Portfolio {
  const b = PORTFOLIO_STATE_OFF;
  const legs: Leg[] = [];
  // The portfolio leg array is fixed at 16 (legs@19684 .. health_cert@21988 =
  // 16×144), NOT V16_MAX_MARKET_SLOTS (64) — iterating 64 overruns the buffer.
  const PORTFOLIO_LEG_COUNT = 16;
  for (let i = 0; i < PORTFOLIO_LEG_COUNT; i++) {
    const off = b + PA.legs + i * LEG_LEN;
    const l = parseLeg(data, off, i);
    if (l.active !== 0) legs.push(l);
  }
  const provBase = b + PA.provenance_header;
  return {
    marketGroupId: pk(data, provBase + PROV.market_group_id),
    portfolioAccountId: pk(data, provBase + PROV.portfolio_account_id),
    owner: pk(data, b + PA.owner),
    capital: u128(data, b + PA.capital),
    pnl: i128(data, b + PA.pnl),
    reservedPnl: u128(data, b + PA.reserved_pnl),
    feeCredits: i128(data, b + PA.fee_credits),
    cancelDepositEscrow: u128(data, b + PA.cancel_deposit_escrow),
    lastFeeSlot: u64(data, b + PA.last_fee_slot),
    activeBitmap: u64(data, b + PA.active_bitmap),    // now u64
    legs,
    staleState: u8(data, b + PA.stale_state),
    bStaleState: u8(data, b + PA.b_stale_state),
    rebalanceLock: u8(data, b + PA.rebalance_lock),
    liquidationLock: u8(data, b + PA.liquidation_lock),
  };
}
