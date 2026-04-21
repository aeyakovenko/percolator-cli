import { PublicKey } from "@solana/web3.js";
import {
  encU8,
  encU16,
  encU32,
  encU64,
  encI64,
  encU128,
  encI128,
  encPubkey,
} from "./encode.js";

/**
 * Instruction tags — exact match to Rust ix::Instruction::decode.
 * Deleted: 11 SetRiskThreshold, 12 UpdateAdmin, 15 SetMaintenanceFee,
 *          16 SetOracleAuthority, 22 SetInsuranceWithdrawPolicy,
 *          23 WithdrawInsuranceLimited, 24 QueryLpFees.
 * Use UpdateAuthority (tag 32) with a `kind` discriminator to change
 * ADMIN/ORACLE/INSURANCE/CLOSE authorities.
 */
export const IX_TAG = {
  InitMarket: 0,
  InitUser: 1,
  InitLP: 2,
  DepositCollateral: 3,
  WithdrawCollateral: 4,
  KeeperCrank: 5,
  TradeNoCpi: 6,
  LiquidateAtOracle: 7,
  CloseAccount: 8,
  TopUpInsurance: 9,
  TradeCpi: 10,
  CloseSlab: 13,
  UpdateConfig: 14,
  PushOraclePrice: 17,
  SetOraclePriceCap: 18,
  ResolveMarket: 19,
  WithdrawInsurance: 20,
  AdminForceCloseAccount: 21,
  ReclaimEmptyAccount: 25,
  SettleAccount: 26,
  DepositFeeCredits: 27,
  ConvertReleasedPnl: 28,
  ResolvePermissionless: 29,
  ForceCloseResolved: 30,
  CatchupAccrue: 31,
  UpdateAuthority: 32,
} as const;

/**
 * Authority kinds for UpdateAuthority (tag 32).
 * Each role is independent — delegate or burn individually.
 */
export const AUTHORITY_KIND = {
  ADMIN: 0,
  ORACLE: 1,
  INSURANCE: 2,
  CLOSE: 3,
} as const;

/**
 * InitMarket wire layout (core = 352 bytes; full with extended tail = 418 bytes).
 *
 * Core:
 *   tag(1) + admin(32) + mint(32) + index_feed_id(32) +
 *   max_staleness_secs(8) + conf_filter_bps(2) + invert(1) + unit_scale(4) +
 *   initial_mark_price_e6(8) +
 *   maintenance_fee_per_slot(u128) + max_insurance_floor(u128) +
 *   min_oracle_price_cap_e2bps(8) +
 *   RiskParams wire (192 bytes, see encodeRiskParamsWire)
 *
 * Extended tail (66 bytes — all-or-nothing; partial tails rejected):
 *   insurance_withdraw_max_bps(2) + insurance_withdraw_cooldown_slots(8) +
 *   permissionless_resolve_stale_slots(8) +
 *   funding_horizon_slots(8) + funding_k_bps(8) +
 *   funding_max_premium_bps(i64) + funding_max_e9_per_slot(i64) +
 *   mark_min_fee(8) + force_close_delay_slots(8)
 */
export interface InitMarketArgs {
  admin: PublicKey | string;
  collateralMint: PublicKey | string;
  indexFeedId: string;           // Pyth feed ID (64 hex chars). All zeros = Hyperp.
  maxStalenessSecs: bigint | string;
  confFilterBps: number;
  invert: number;
  unitScale: number;
  initialMarkPriceE6: bigint | string;
  maintenanceFeePerSlot: bigint | string;   // u128
  maxInsuranceFloor: bigint | string;       // u128
  minOraclePriceCapE2bps: bigint | string;  // u64
  // RiskParams wire fields
  hMin: bigint | string;
  maintenanceMarginBps: bigint | string;
  initialMarginBps: bigint | string;
  tradingFeeBps: bigint | string;
  maxAccounts: bigint | string;
  insuranceFloor: bigint | string;          // u128
  hMax: bigint | string;
  maxCrankStalenessSlots: bigint | string;
  liquidationFeeBps: bigint | string;
  liquidationFeeCap: bigint | string;       // u128
  resolvePriceDeviationBps: bigint | string;
  minLiquidationAbs: bigint | string;       // u128
  minInitialDeposit: bigint | string;       // u128
  minNonzeroMmReq: bigint | string;         // u128
  minNonzeroImReq: bigint | string;         // u128
  // Extended tail (required — program rejects partial tails)
  insuranceWithdrawMaxBps: number;
  insuranceWithdrawCooldownSlots: bigint | string;
  permissionlessResolveStaleSlots: bigint | string;
  fundingHorizonSlots: bigint | string;
  fundingKBps: bigint | string;
  fundingMaxPremiumBps: bigint | string;    // i64
  fundingMaxE9PerSlot: bigint | string;    // i64
  markMinFee: bigint | string;
  forceCloseDelaySlots: bigint | string;
}

function encodeFeedId(feedId: string): Buffer {
  const hex = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  if (hex.length !== 64) {
    throw new Error(`Invalid feed ID length: expected 64 hex chars, got ${hex.length}`);
  }
  return Buffer.from(hex, "hex");
}

/**
 * RiskParams wire format (192 bytes). Field order matches `read_risk_params`.
 * Note the compat `_new_account_fee` u128 slot — still on the wire, discarded.
 */
function encodeRiskParamsWire(args: InitMarketArgs): Buffer {
  return Buffer.concat([
    encU64(args.hMin),
    encU64(args.maintenanceMarginBps),
    encU64(args.initialMarginBps),
    encU64(args.tradingFeeBps),
    encU64(args.maxAccounts),
    encU128("0"),                           // compat new_account_fee (discarded)
    encU128(args.insuranceFloor),
    encU64(args.hMax),
    encU64(args.maxCrankStalenessSlots),
    encU64(args.liquidationFeeBps),
    encU128(args.liquidationFeeCap),
    encU64(args.resolvePriceDeviationBps),  // was _liquidation_buffer_bps
    encU128(args.minLiquidationAbs),
    encU128(args.minInitialDeposit),
    encU128(args.minNonzeroMmReq),
    encU128(args.minNonzeroImReq),
  ]);
}

export function encodeInitMarket(args: InitMarketArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.InitMarket),
    encPubkey(args.admin),
    encPubkey(args.collateralMint),
    encodeFeedId(args.indexFeedId),
    encU64(args.maxStalenessSecs),
    encU16(args.confFilterBps),
    encU8(args.invert),
    encU32(args.unitScale),
    encU64(args.initialMarkPriceE6),
    encU128(args.maintenanceFeePerSlot),
    encU128(args.maxInsuranceFloor),
    encU64(args.minOraclePriceCapE2bps),
    encodeRiskParamsWire(args),
    // Extended tail (66 bytes)
    encU16(args.insuranceWithdrawMaxBps),
    encU64(args.insuranceWithdrawCooldownSlots),
    encU64(args.permissionlessResolveStaleSlots),
    encU64(args.fundingHorizonSlots),
    encU64(args.fundingKBps),
    encI64(args.fundingMaxPremiumBps),
    encI64(args.fundingMaxE9PerSlot),
    encU64(args.markMinFee),
    encU64(args.forceCloseDelaySlots),
  ]);
}

// ---------- InitUser / InitLP ----------
export interface InitUserArgs { feePayment: bigint | string; }
export function encodeInitUser(args: InitUserArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.InitUser), encU64(args.feePayment)]);
}

export interface InitLPArgs {
  matcherProgram: PublicKey | string;
  matcherContext: PublicKey | string;
  feePayment: bigint | string;
}
export function encodeInitLP(args: InitLPArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.InitLP),
    encPubkey(args.matcherProgram),
    encPubkey(args.matcherContext),
    encU64(args.feePayment),
  ]);
}

// ---------- Deposit / Withdraw ----------
export interface DepositCollateralArgs { userIdx: number; amount: bigint | string; }
export function encodeDepositCollateral(args: DepositCollateralArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.DepositCollateral), encU16(args.userIdx), encU64(args.amount)]);
}

export interface WithdrawCollateralArgs { userIdx: number; amount: bigint | string; }
export function encodeWithdrawCollateral(args: WithdrawCollateralArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.WithdrawCollateral), encU16(args.userIdx), encU64(args.amount)]);
}

// ---------- KeeperCrank (format_version=1) ----------
export interface KeeperCrankCandidate {
  idx: number;
  /** 0 = FullClose, 1 = ExactPartial (requires qCloseQ), 0xFF = touch-only */
  policyTag?: number;
  qCloseQ?: bigint | string;
}

export interface KeeperCrankArgs {
  callerIdx: number;
  candidates?: (number | KeeperCrankCandidate)[];
}

export function encodeKeeperCrank(args: KeeperCrankArgs): Buffer {
  const parts: Buffer[] = [
    encU8(IX_TAG.KeeperCrank),
    encU16(args.callerIdx),
    encU8(1), // format_version=1
  ];
  for (const c of args.candidates ?? []) {
    if (typeof c === "number") {
      parts.push(encU16(c));
      parts.push(encU8(0xFF));
      continue;
    }
    parts.push(encU16(c.idx));
    const tag = c.policyTag ?? 0xFF;
    parts.push(encU8(tag));
    if (tag === 1) {
      if (c.qCloseQ === undefined) throw new Error("qCloseQ required for ExactPartial");
      parts.push(encU128(c.qCloseQ));
    }
  }
  return Buffer.concat(parts);
}

// ---------- Trade ----------
export interface TradeNoCpiArgs { lpIdx: number; userIdx: number; size: bigint | string; }
export function encodeTradeNoCpi(args: TradeNoCpiArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.TradeNoCpi),
    encU16(args.lpIdx),
    encU16(args.userIdx),
    encI128(args.size),
  ]);
}

export interface TradeCpiArgs {
  lpIdx: number;
  userIdx: number;
  size: bigint | string;
  limitPriceE6?: bigint | string;
}
export function encodeTradeCpi(args: TradeCpiArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.TradeCpi),
    encU16(args.lpIdx),
    encU16(args.userIdx),
    encI128(args.size),
    encU64(args.limitPriceE6 ?? "0"),
  ]);
}

// ---------- Liquidation / Close ----------
export interface LiquidateAtOracleArgs { targetIdx: number; }
export function encodeLiquidateAtOracle(args: LiquidateAtOracleArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.LiquidateAtOracle), encU16(args.targetIdx)]);
}

export interface CloseAccountArgs { userIdx: number; }
export function encodeCloseAccount(args: CloseAccountArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.CloseAccount), encU16(args.userIdx)]);
}

// ---------- Insurance ----------
export interface TopUpInsuranceArgs { amount: bigint | string; }
export function encodeTopUpInsurance(args: TopUpInsuranceArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.TopUpInsurance), encU64(args.amount)]);
}

export function encodeWithdrawInsurance(): Buffer {
  return encU8(IX_TAG.WithdrawInsurance);
}

// ---------- Slab lifecycle ----------
export function encodeCloseSlab(): Buffer {
  return encU8(IX_TAG.CloseSlab);
}

// ---------- UpdateConfig (funding + TVL cap, 5 fields) ----------
export interface UpdateConfigArgs {
  fundingHorizonSlots: bigint | string;
  fundingKBps: bigint | string;
  fundingMaxPremiumBps: bigint | string;   // i64
  fundingMaxE9PerSlot: bigint | string;    // i64
  /**
   * v12.19+: admin-opt-in deposit cap. Rejects DepositCollateral if
   * post-state `c_tot > tvlInsuranceCapMult × insurance_fund.balance`.
   * 0 = disabled. Typical production value: 10–100 (20 = 20× insurance
   * coverage).
   */
  tvlInsuranceCapMult: number;             // u16
}
export function encodeUpdateConfig(args: UpdateConfigArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.UpdateConfig),
    encU64(args.fundingHorizonSlots),
    encU64(args.fundingKBps),
    encI64(args.fundingMaxPremiumBps),
    encI64(args.fundingMaxE9PerSlot),
    encU16(args.tvlInsuranceCapMult),
  ]);
}

// ---------- Oracle ----------
export interface PushOraclePriceArgs { priceE6: bigint | string; timestamp: bigint | string; }
export function encodePushOraclePrice(args: PushOraclePriceArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.PushOraclePrice),
    encU64(args.priceE6),
    encI64(args.timestamp),
  ]);
}

export interface SetOraclePriceCapArgs { maxChangeE2bps: bigint | string; }
export function encodeSetOraclePriceCap(args: SetOraclePriceCapArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.SetOraclePriceCap), encU64(args.maxChangeE2bps)]);
}

// ---------- Resolve ----------
export function encodeResolveMarket(): Buffer {
  return encU8(IX_TAG.ResolveMarket);
}

export function encodeResolvePermissionless(): Buffer {
  return encU8(IX_TAG.ResolvePermissionless);
}

export function encodeForceCloseResolved(args: { userIdx: number }): Buffer {
  return Buffer.concat([encU8(IX_TAG.ForceCloseResolved), encU16(args.userIdx)]);
}

export interface AdminForceCloseAccountArgs { userIdx: number; }
export function encodeAdminForceCloseAccount(args: AdminForceCloseAccountArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.AdminForceCloseAccount), encU16(args.userIdx)]);
}

// ---------- Account lifecycle ----------
export function encodeReclaimEmptyAccount(args: { userIdx: number }): Buffer {
  return Buffer.concat([encU8(IX_TAG.ReclaimEmptyAccount), encU16(args.userIdx)]);
}

export function encodeSettleAccount(args: { userIdx: number }): Buffer {
  return Buffer.concat([encU8(IX_TAG.SettleAccount), encU16(args.userIdx)]);
}

export function encodeDepositFeeCredits(args: { userIdx: number; amount: bigint | string }): Buffer {
  return Buffer.concat([encU8(IX_TAG.DepositFeeCredits), encU16(args.userIdx), encU64(args.amount)]);
}

export function encodeConvertReleasedPnl(args: { userIdx: number; amount: bigint | string }): Buffer {
  return Buffer.concat([encU8(IX_TAG.ConvertReleasedPnl), encU16(args.userIdx), encU64(args.amount)]);
}

// ---------- Catchup ----------
export function encodeCatchupAccrue(): Buffer {
  return encU8(IX_TAG.CatchupAccrue);
}

// ---------- Authority management (replaces UpdateAdmin, SetOracleAuthority) ----------
export interface UpdateAuthorityArgs {
  kind: number; // AUTHORITY_KIND.ADMIN | ORACLE | INSURANCE | CLOSE
  newPubkey: PublicKey | string;
}
export function encodeUpdateAuthority(args: UpdateAuthorityArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.UpdateAuthority),
    encU8(args.kind),
    encPubkey(args.newPubkey),
  ]);
}

/**
 * Back-compat shim: SetOracleAuthority was removed in favor of
 * UpdateAuthority { kind: ORACLE }. Scripts still calling this get the
 * new wire format transparently.
 */
export function encodeSetOracleAuthority(args: { newAuthority: PublicKey | string }): Buffer {
  return encodeUpdateAuthority({ kind: AUTHORITY_KIND.ORACLE, newPubkey: args.newAuthority });
}

/**
 * Back-compat shim: UpdateAdmin → UpdateAuthority { kind: ADMIN }.
 */
export function encodeUpdateAdmin(args: { newAdmin: PublicKey | string }): Buffer {
  return encodeUpdateAuthority({ kind: AUTHORITY_KIND.ADMIN, newPubkey: args.newAdmin });
}
