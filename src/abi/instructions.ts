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
  WithdrawInsuranceLimited: 23, // v12.19+ restored — gated on insurance_operator
  PushOraclePrice: 17,
  // 18 SetOraclePriceCap deleted in v12.21
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
  ADMIN: 0,                // header.admin
  HYPERP_MARK: 1,          // config.hyperp_authority (renamed from oracle_authority in v12.20)
  INSURANCE: 2,            // header.insurance_authority — tag 20 WithdrawInsurance (unbounded)
  // kind=3 CLOSE was deleted; close authority merged into ADMIN in v12.20.
  // No alias here on purpose: AUTHORITY_KIND.CLOSE used to map to 0 (ADMIN),
  // which silently turned a "burn close authority" call into a "rotate admin"
  // call. Better to fail at import with `undefined` than to silently rotate
  // the only authority that can still rotate every other authority.
  INSURANCE_OPERATOR: 4,   // header.insurance_operator — tag 23 WithdrawInsuranceLimited
  ORACLE: 1,               // back-compat alias for HYPERP_MARK (same field, only renamed)
} as const;

const VALID_AUTHORITY_KINDS = new Set([0, 1, 2, 4]);

/**
 * InitMarket wire layout (v12.20+):
 *   core = 144 bytes (tag + admin + mint + feed + staleness + conf + invert +
 *                     unit_scale + initial_mark + maint_fee_u128 +
 *                     min_oracle_price_cap_u64)
 *   RiskParams wire = 152 bytes (new_account_fee now in the slot formerly
 *                     used for _compat + insurance_floor; insurance_floor +
 *                     min_initial_deposit REMOVED)
 *   extended tail = 66 bytes (unchanged)
 *   Total: 362 bytes (down from 418 in v12.19).
 */
export interface InitMarketArgs {
  admin: PublicKey | string;
  collateralMint: PublicKey | string;
  indexFeedId: string;
  maxStalenessSecs: bigint | string;           // <= 600 (v12.21)
  confFilterBps: number;                        // [50, 1000] (v12.21)
  invert: number;
  unitScale: number;
  initialMarkPriceE6: bigint | string;
  maintenanceFeePerSlot: bigint | string;      // u128
  // RiskParams wire fields
  hMin: bigint | string;                       // > 0 (v12.21)
  maintenanceMarginBps: bigint | string;
  initialMarginBps: bigint | string;
  tradingFeeBps: bigint | string;
  maxAccounts: bigint | string;
  newAccountFee: bigint | string;              // u128 — insurance-destined init fee
  hMax: bigint | string;                       // >= h_min (v12.21)
  /** v12.21: discarded by wrapper but still on the wire (8 zero bytes). */
  maxCrankStalenessSlots: bigint | string;
  liquidationFeeBps: bigint | string;
  liquidationFeeCap: bigint | string;          // u128
  resolvePriceDeviationBps: bigint | string;
  minLiquidationAbs: bigint | string;          // u128
  minNonzeroMmReq: bigint | string;            // u128
  minNonzeroImReq: bigint | string;            // u128
  /** v12.21: per-slot price-move cap in bps. Must be > 0. Wrapper enforces
   *  the §1.4 solvency envelope: `max_price_move_bps_per_slot * 100 (slot
   *  envelope) + funding_part + liquidation_fee_bps <= maintenance_margin_bps`. */
  maxPriceMoveBpsPerSlot: bigint | string;
  // Extended tail (66 bytes)
  /** Top bit 0x8000 = INSURANCE_WITHDRAW_DEPOSITS_ONLY_FLAG. Low 15 bits = bps cap. */
  insuranceWithdrawMaxBps: number;
  insuranceWithdrawCooldownSlots: bigint | string;
  /** v12.21: must be 0 OR in [1, 100] (≤ MAX_ACCRUAL_DT_SLOTS). */
  permissionlessResolveStaleSlots: bigint | string;
  fundingHorizonSlots: bigint | string;
  fundingKBps: bigint | string;
  fundingMaxPremiumBps: bigint | string;       // i64
  fundingMaxE9PerSlot: bigint | string;        // i64
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
 * RiskParams wire format (160 bytes, v12.21+). Field order matches the
 * wrapper's `read_risk_params`. `max_crank_staleness_slots` is still
 * on the wire but read+discarded by the wrapper. New: `max_price_move_bps_per_slot`
 * appended at the end (must be > 0).
 */
function encodeRiskParamsWire(args: InitMarketArgs): Buffer {
  return Buffer.concat([
    encU64(args.hMin),
    encU64(args.maintenanceMarginBps),
    encU64(args.initialMarginBps),
    encU64(args.tradingFeeBps),
    encU64(args.maxAccounts),
    encU128(args.newAccountFee),
    encU64(args.hMax),
    encU64(args.maxCrankStalenessSlots),         // v12.21: read+discarded by wrapper
    encU64(args.liquidationFeeBps),
    encU128(args.liquidationFeeCap),
    encU64(args.resolvePriceDeviationBps),
    encU128(args.minLiquidationAbs),
    encU128(args.minNonzeroMmReq),
    encU128(args.minNonzeroImReq),
    encU64(args.maxPriceMoveBpsPerSlot),         // v12.21+ (NEW; must be > 0)
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
    // v12.21: min_oracle_price_cap_e2bps removed from wire
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

/**
 * WithdrawInsuranceLimited (tag 23, v12.19+): bounded live-market fee
 * extraction. Caps per-call at `config.insurance_withdraw_max_bps` of
 * insurance; enforces `config.insurance_withdraw_cooldown_slots` between
 * calls. Gated on `header.insurance_operator` (distinct from
 * `insurance_authority` which owns the unbounded tag 20 path).
 */
export function encodeWithdrawInsuranceLimited(args: { amount: bigint | string }): Buffer {
  return Buffer.concat([encU8(IX_TAG.WithdrawInsuranceLimited), encU64(args.amount)]);
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

// SetOraclePriceCap (tag 18) was deleted in v12.21 — no replacement encoder.

// ---------- Resolve ----------
/**
 * ResolveMarket (tag 19, v12.21+).
 *
 * `mode` selects the resolve flavor:
 *   - 0 = Ordinary  — normal resolution at current effective price
 *   - 1 = Degenerate — flat-market shortcut (zero net OI / flat funding)
 *
 * Older builds accepted no payload; v12.21 strictly requires the byte.
 */
export function encodeResolveMarket(args: { mode?: number } = {}): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.ResolveMarket),
    encU8(args.mode ?? 0),
  ]);
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
  kind: number; // AUTHORITY_KIND.ADMIN | HYPERP_MARK (=ORACLE) | INSURANCE | INSURANCE_OPERATOR
  newPubkey: PublicKey | string | null;
}
export function encodeUpdateAuthority(args: UpdateAuthorityArgs): Buffer {
  if (!VALID_AUTHORITY_KINDS.has(args.kind)) {
    throw new Error(
      `encodeUpdateAuthority: invalid kind ${args.kind} (expected 0=ADMIN, 1=HYPERP_MARK/ORACLE, 2=INSURANCE, 4=INSURANCE_OPERATOR; kind=3 was removed in v12.20)`
    );
  }
  return Buffer.concat([
    encU8(IX_TAG.UpdateAuthority),
    encU8(args.kind),
    args.newPubkey === null ? Buffer.alloc(32) : encPubkey(args.newPubkey),
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
