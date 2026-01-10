import { PublicKey } from "@solana/web3.js";
import {
  encU8,
  encU16,
  encU32,
  encU64,
  encU128,
  encI128,
  encPubkey,
} from "./encode.js";

/**
 * Instruction tags - exact match to Rust ix::Instruction::decode
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
  SetRiskThreshold: 11,
  UpdateAdmin: 12,
  CloseSlab: 13,
} as const;

/**
 * InitMarket instruction data (256 bytes total)
 * Layout: tag(1) + admin(32) + mint(32) + indexFeedId(32) +
 *         maxStaleSecs(8) + confFilter(2) + invert(1) + unitScale(4) +
 *         RiskParams(144)
 *
 * Note: indexFeedId is the Pyth Pull feed ID (32 bytes hex), NOT an oracle pubkey.
 * The program validates PriceUpdateV2 accounts against this feed ID at runtime.
 */
export interface InitMarketArgs {
  admin: PublicKey | string;
  collateralMint: PublicKey | string;
  indexFeedId: string;           // Pyth feed ID (hex string, 64 chars without 0x prefix)
  maxStalenessSecs: bigint | string;  // Max staleness in SECONDS (Pyth Pull uses unix timestamps)
  confFilterBps: number;
  invert: number;              // 0 = no inversion, 1 = invert oracle price (USD/SOL -> SOL/USD)
  unitScale: number;           // Lamports per unit (0 = no scaling, e.g. 1000 = 1 SOL = 1,000,000 units)
  warmupPeriodSlots: bigint | string;
  maintenanceMarginBps: bigint | string;
  initialMarginBps: bigint | string;
  tradingFeeBps: bigint | string;
  maxAccounts: bigint | string;
  newAccountFee: bigint | string;
  riskReductionThreshold: bigint | string;
  maintenanceFeePerSlot: bigint | string;
  maxCrankStalenessSlots: bigint | string;
  liquidationFeeBps: bigint | string;
  liquidationFeeCap: bigint | string;
  liquidationBufferBps: bigint | string;
  minLiquidationAbs: bigint | string;
}

/**
 * Encode a Pyth feed ID (hex string) to 32-byte buffer.
 */
function encodeFeedId(feedId: string): Buffer {
  // Remove 0x prefix if present
  const hex = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  if (hex.length !== 64) {
    throw new Error(`Invalid feed ID length: expected 64 hex chars, got ${hex.length}`);
  }
  return Buffer.from(hex, "hex");
}

export function encodeInitMarket(args: InitMarketArgs): Buffer {
  // Layout: tag(1) + admin(32) + mint(32) + index_feed_id(32) + max_staleness_secs(8) +
  //         conf_filter_bps(2) + invert(1) + unit_scale(4) + RiskParams(...)
  // Note: _reserved field is only in MarketConfig on-chain, not in instruction data
  return Buffer.concat([
    encU8(IX_TAG.InitMarket),
    encPubkey(args.admin),
    encPubkey(args.collateralMint),
    encodeFeedId(args.indexFeedId),   // index_feed_id (32 bytes)
    encU64(args.maxStalenessSecs),    // max_staleness_secs (Pyth Pull uses unix timestamps)
    encU16(args.confFilterBps),
    encU8(args.invert),
    encU32(args.unitScale),
    encU64(args.warmupPeriodSlots),
    encU64(args.maintenanceMarginBps),
    encU64(args.initialMarginBps),
    encU64(args.tradingFeeBps),
    encU64(args.maxAccounts),
    encU128(args.newAccountFee),
    encU128(args.riskReductionThreshold),
    encU128(args.maintenanceFeePerSlot),
    encU64(args.maxCrankStalenessSlots),
    encU64(args.liquidationFeeBps),
    encU128(args.liquidationFeeCap),
    encU64(args.liquidationBufferBps),
    encU128(args.minLiquidationAbs),
  ]);
}

/**
 * InitUser instruction data (9 bytes)
 */
export interface InitUserArgs {
  feePayment: bigint | string;
}

export function encodeInitUser(args: InitUserArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.InitUser), encU64(args.feePayment)]);
}

/**
 * InitLP instruction data (73 bytes)
 */
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

/**
 * DepositCollateral instruction data (11 bytes)
 */
export interface DepositCollateralArgs {
  userIdx: number;
  amount: bigint | string;
}

export function encodeDepositCollateral(args: DepositCollateralArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.DepositCollateral),
    encU16(args.userIdx),
    encU64(args.amount),
  ]);
}

/**
 * WithdrawCollateral instruction data (11 bytes)
 */
export interface WithdrawCollateralArgs {
  userIdx: number;
  amount: bigint | string;
}

export function encodeWithdrawCollateral(args: WithdrawCollateralArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.WithdrawCollateral),
    encU16(args.userIdx),
    encU64(args.amount),
  ]);
}

/**
 * KeeperCrank instruction data (4 bytes)
 * Funding rate is computed on-chain from LP inventory.
 */
export interface KeeperCrankArgs {
  callerIdx: number;
  allowPanic: boolean;
}

export function encodeKeeperCrank(args: KeeperCrankArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.KeeperCrank),
    encU16(args.callerIdx),
    encU8(args.allowPanic ? 1 : 0),
  ]);
}

/**
 * TradeNoCpi instruction data (21 bytes)
 */
export interface TradeNoCpiArgs {
  lpIdx: number;
  userIdx: number;
  size: bigint | string;
}

export function encodeTradeNoCpi(args: TradeNoCpiArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.TradeNoCpi),
    encU16(args.lpIdx),
    encU16(args.userIdx),
    encI128(args.size),
  ]);
}

/**
 * LiquidateAtOracle instruction data (3 bytes)
 */
export interface LiquidateAtOracleArgs {
  targetIdx: number;
}

export function encodeLiquidateAtOracle(args: LiquidateAtOracleArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.LiquidateAtOracle),
    encU16(args.targetIdx),
  ]);
}

/**
 * CloseAccount instruction data (3 bytes)
 */
export interface CloseAccountArgs {
  userIdx: number;
}

export function encodeCloseAccount(args: CloseAccountArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.CloseAccount), encU16(args.userIdx)]);
}

/**
 * TopUpInsurance instruction data (9 bytes)
 */
export interface TopUpInsuranceArgs {
  amount: bigint | string;
}

export function encodeTopUpInsurance(args: TopUpInsuranceArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.TopUpInsurance), encU64(args.amount)]);
}

/**
 * TradeCpi instruction data (21 bytes)
 */
export interface TradeCpiArgs {
  lpIdx: number;
  userIdx: number;
  size: bigint | string;
}

export function encodeTradeCpi(args: TradeCpiArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.TradeCpi),
    encU16(args.lpIdx),
    encU16(args.userIdx),
    encI128(args.size),
  ]);
}

/**
 * SetRiskThreshold instruction data (17 bytes)
 */
export interface SetRiskThresholdArgs {
  newThreshold: bigint | string;
}

export function encodeSetRiskThreshold(args: SetRiskThresholdArgs): Buffer {
  return Buffer.concat([
    encU8(IX_TAG.SetRiskThreshold),
    encU128(args.newThreshold),
  ]);
}

/**
 * UpdateAdmin instruction data (33 bytes)
 */
export interface UpdateAdminArgs {
  newAdmin: PublicKey | string;
}

export function encodeUpdateAdmin(args: UpdateAdminArgs): Buffer {
  return Buffer.concat([encU8(IX_TAG.UpdateAdmin), encPubkey(args.newAdmin)]);
}

/**
 * CloseSlab instruction data (1 byte)
 */
export function encodeCloseSlab(): Buffer {
  return encU8(IX_TAG.CloseSlab);
}
