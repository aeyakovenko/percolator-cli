/**
 * v16 instruction encoders. Tags + wire format match the decoder in
 * percolator-prog/src/v16_program.rs (commit 95250b3).
 */
import { PublicKey } from "@solana/web3.js";

// ---------- LE encoders ----------
const u8 = (v: number): Buffer => { const b = Buffer.alloc(1); b.writeUInt8(v, 0); return b; };
const u16le = (v: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; };
const u32le = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; };
const u64le = (v: bigint | number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; };
const i64le = (v: bigint | number): Buffer => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v), 0); return b; };
const u128le = (v: bigint): Buffer => {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(v & ((1n << 64n) - 1n), 0);
  b.writeBigUInt64LE(v >> 64n, 8);
  return b;
};
const i128le = (v: bigint): Buffer => u128le(v < 0n ? (1n << 128n) + v : v);
const pkLE = (p: PublicKey | string): Buffer => (typeof p === "string" ? new PublicKey(p) : p).toBuffer();

// ---------- Tags ----------
export const TAG = {
  InitMarket: 0,
  InitPortfolio: 1,
  Deposit: 3,
  Withdraw: 4,
  PermissionlessCrank: 5,
  TradeNoCpi: 6,
  ClosePortfolio: 8,
  TopUpInsurance: 9,
  TradeCpi: 10,
  CloseSlab: 13,
  ResolveMarket: 19,
  WithdrawInsuranceLimited: 23,
  TopUpBackingBucket: 24,
  ConvertReleasedPnl: 28,
  CloseResolved: 30,
  UpdateAuthority: 32,
  UpdateInsurancePolicy: 33,
  ConfigureHybridOracle: 34,
  // Renamed in program 7144d9b: ConfigureEwmaMark / PushEwmaMark. Both names
  // are exported as aliases below for source-compat with older call sites.
  // Same wire / same opcode — tags 35/36 are still very much active.
  ConfigureEwmaMark: 35,
  PushEwmaMark: 36,
  ConfigureHyperpMark: 35,    // deprecated alias
  PushHyperpMark: 36,         // deprecated alias
  UpdateLiquidationFeePolicy: 37,
  ConfigurePermissionlessResolve: 38,
  ResolveStalePermissionless: 39,
  UpdateAssetLifecycle: 40,
  WithdrawInsurance: 41,
  CureAndCancelClose: 42,
  ForfeitRecoveryLeg: 43,
  RebalanceReduce: 44,
  FinalizeResetSide: 45,
  ClaimResolvedPayoutTopup: 46,
  RefineResolvedUnreceiptedBound: 47,
  SyncMaintenanceFee: 48,
  UpdateMaintenanceFeePolicy: 49,
  WithdrawBackingBucket: 50,
  // ---- added in commits acbc883 / 05a8f84 / ea7ef40 ----
  UpdateBackingFeePolicy: 51,
  WithdrawBackingBucketEarnings: 52,
  SyncBackingDomainLedger: 53,
  SyncInsuranceLedger: 54,
  UpdateTradeFeePolicy: 55,
  TopUpInsuranceDomain: 56,
  WithdrawInsuranceDomain: 57,
  UpdateFeeRedirectPolicy: 58,
  UpdateMarketInitFeePolicy: 59,
  UpdateBaseUnitMints: 60,
  SwapSecondaryForPrimary: 61,
  // ConfigureAuthMark/PushAuthMark are a DIFFERENT oracle mode (AUTH_MARK,
  // oracle_mode 3) used when a designated oracle_authority externally pushes
  // marks. The EWMA mode at 35/36 is the engine-walked target mark — both
  // tags remain live in the deployed wrapper.
  ConfigureAuthMark: 62,
  PushAuthMark: 63,
  ForceCloseAbandonedAsset: 64,
  BatchTradeNoCpi: 66,
  BatchTradeCpi: 67,
  // 7144d9b — renamed from SetMatcherAuthorization, no longer takes a separate
  // auth PDA; writes a 104-byte PortfolioMatcherConfigV16 tail directly on the
  // LP portfolio. Enables TradeCpi without the LP owner co-signing each fill.
  SetMatcherConfig: 68,
  // RestartAsset0Oracle — market-authority recovery to re-arm asset 0 after a
  // RECOVERY trip; preserves the insurance budget across the reset.
  RestartAsset0Oracle: 69,
} as const;

// ---------- Encoders ----------

export interface InitMarketArgs {
  maxPortfolioAssets: number;            // u16 (1..=16) — widened to u16 in commit 5741bb9
  hMin: bigint; hMax: bigint;
  initialPrice: bigint;
  minNonzeroMmReq: bigint; minNonzeroImReq: bigint;
  maintenanceMarginBps: bigint; initialMarginBps: bigint;
  maxTradingFeeBps: bigint; tradeFeeBaseBps: bigint;
  liquidationFeeBps: bigint; liquidationFeeCap: bigint;
  minLiquidationAbs: bigint;
  maxPriceMoveBpsPerSlot: bigint; maxAccrualDtSlots: bigint;
  maxAbsFundingE9PerSlot: bigint; minFundingLifetimeSlots: bigint;
  maxAccountBSettlementChunks: bigint; maxBankruptCloseChunks: bigint;
  maxBankruptCloseLifetimeSlots: bigint;  // NEW in commit 27ec3c2
  publicBChunkAtoms: bigint; maintenanceFeePerSlot: bigint;
}
export function encInitMarket(a: InitMarketArgs): Buffer {
  return Buffer.concat([
    u8(TAG.InitMarket),
    u16le(a.maxPortfolioAssets),
    u64le(a.hMin), u64le(a.hMax), u64le(a.initialPrice),
    u128le(a.minNonzeroMmReq), u128le(a.minNonzeroImReq),
    u64le(a.maintenanceMarginBps), u64le(a.initialMarginBps),
    u64le(a.maxTradingFeeBps), u64le(a.tradeFeeBaseBps),
    u64le(a.liquidationFeeBps), u128le(a.liquidationFeeCap),
    u128le(a.minLiquidationAbs),
    u64le(a.maxPriceMoveBpsPerSlot), u64le(a.maxAccrualDtSlots),
    u64le(a.maxAbsFundingE9PerSlot), u64le(a.minFundingLifetimeSlots),
    u64le(a.maxAccountBSettlementChunks), u64le(a.maxBankruptCloseChunks),
    u64le(a.maxBankruptCloseLifetimeSlots),
    u128le(a.publicBChunkAtoms), u128le(a.maintenanceFeePerSlot),
  ]);
}

// UpdateAssetLifecycle (tag 40) — added in commit be92fe9 / d6033e5.
// `action` indexes encode_asset_lifecycle: 0=Disabled, 1=PendingActivation,
// 2=Active, 3=DrainOnly, 4=Retired, 5=Recovery. The wrapper restricts which
// transitions are publicly callable; admin/asset_authority gates the rest.
export interface UpdateAssetLifecycleArgs {
  action: number;
  assetIndex: number;          // u16 since commit 5741bb9
  nowSlot: bigint;
  initialPrice: bigint;
  // Per-asset domain authorities, appended in commit 05a8f84. The decoder
  // requires all four (32 B each) and rejects trailing bytes. Pass the system
  // program / default pubkey to leave one unset.
  insuranceAuthority: PublicKey | string;
  insuranceOperator: PublicKey | string;
  backingBucketAuthority: PublicKey | string;
  oracleAuthority: PublicKey | string;
}
export function encUpdateAssetLifecycle(a: UpdateAssetLifecycleArgs): Buffer {
  return Buffer.concat([
    u8(TAG.UpdateAssetLifecycle),
    u8(a.action),
    u16le(a.assetIndex),
    u64le(a.nowSlot),
    u64le(a.initialPrice),
    pkLE(a.insuranceAuthority),
    pkLE(a.insuranceOperator),
    pkLE(a.backingBucketAuthority),
    pkLE(a.oracleAuthority),
  ]);
}

// ============================================================================
// New ixs (commits 5741bb9, ee3d082, b4ff060)
// ============================================================================

// 41 WithdrawInsurance (unbounded) — admin path on a Resolved market.
// Accounts: [authority, market, dest_token, vault_token, vault_authority, token_program]
export function encWithdrawInsurance(amount: bigint): Buffer {
  return Buffer.concat([u8(TAG.WithdrawInsurance), u128le(amount)]);
}

// 42 CureAndCancelClose — owner cures a portfolio (e.g., cancels a close).
// Accounts: [owner, market, portfolio] + (optional [source_token, vault_token, token_program])
export function encCureAndCancelClose(optionalDeposit: bigint): Buffer {
  return Buffer.concat([u8(TAG.CureAndCancelClose), u128le(optionalDeposit)]);
}

// 43 ForfeitRecoveryLeg — permissionless recovery on a portfolio's leg.
// Accounts: [signer, market, portfolio]
export interface ForfeitRecoveryLegArgs { assetIndex: number; bDeltaBudget: bigint; }
export function encForfeitRecoveryLeg(a: ForfeitRecoveryLegArgs): Buffer {
  return Buffer.concat([u8(TAG.ForfeitRecoveryLeg), u16le(a.assetIndex), u128le(a.bDeltaBudget)]);
}

// 44 RebalanceReduce — permissionless reduce of a portfolio position.
// Accounts: [signer, market, portfolio]
export interface RebalanceReduceArgs { assetIndex: number; reduceQ: bigint; }
export function encRebalanceReduce(a: RebalanceReduceArgs): Buffer {
  return Buffer.concat([u8(TAG.RebalanceReduce), u16le(a.assetIndex), u128le(a.reduceQ)]);
}

// 45 FinalizeResetSide — finalize a per-side reset after engine recovery.
// Accounts: [signer, market]
export interface FinalizeResetSideArgs { assetIndex: number; side: number; }
export function encFinalizeResetSide(a: FinalizeResetSideArgs): Buffer {
  return Buffer.concat([u8(TAG.FinalizeResetSide), u16le(a.assetIndex), u8(a.side)]);
}

// 46 ClaimResolvedPayoutTopup — post-resolve payout claim.
// Accounts: [signer, market, portfolio]
export function encClaimResolvedPayoutTopup(): Buffer {
  return u8(TAG.ClaimResolvedPayoutTopup);
}

// 47 RefineResolvedUnreceiptedBound — narrow the unreceipted bound during resolve.
// Accounts: [signer, market]
export function encRefineResolvedUnreceiptedBound(decreaseNum: bigint): Buffer {
  return Buffer.concat([u8(TAG.RefineResolvedUnreceiptedBound), u128le(decreaseNum)]);
}

// 48 SyncMaintenanceFee — permissionless maintenance-fee sync for a portfolio.
// Accounts: [market, portfolio]   (no signer required)
// Optional 3rd account = cranker portfolio (commit 689b90e). When supplied
// and maintenance_cranker_fee_share_bps != 0, the configured share of the
// charged maintenance is reclassified from insurance into the cranker's
// capital (no SPL transfer). Cranker may be the same portfolio.
export function encSyncMaintenanceFee(nowSlot: bigint): Buffer {
  return Buffer.concat([u8(TAG.SyncMaintenanceFee), u64le(nowSlot)]);
}

export function encInitPortfolio(): Buffer { return u8(TAG.InitPortfolio); }
export function encDeposit(amount: bigint): Buffer { return Buffer.concat([u8(TAG.Deposit), u128le(amount)]); }
export function encWithdraw(amount: bigint): Buffer { return Buffer.concat([u8(TAG.Withdraw), u128le(amount)]); }
export function encClosePortfolio(): Buffer { return u8(TAG.ClosePortfolio); }
export function encCloseSlab(): Buffer { return u8(TAG.CloseSlab); }
export function encResolveMarket(): Buffer { return u8(TAG.ResolveMarket); }
export function encTopUpInsurance(amount: bigint): Buffer { return Buffer.concat([u8(TAG.TopUpInsurance), u128le(amount)]); }
export function encWithdrawInsuranceLimited(amount: bigint): Buffer { return Buffer.concat([u8(TAG.WithdrawInsuranceLimited), u128le(amount)]); }
export function encConvertReleasedPnl(amount: bigint): Buffer { return Buffer.concat([u8(TAG.ConvertReleasedPnl), u128le(amount)]); }
export function encCloseResolved(feeRatePerSlot: bigint): Buffer { return Buffer.concat([u8(TAG.CloseResolved), u128le(feeRatePerSlot)]); }

// NOTE: asset_index widened from u8 to u16 across all trade/crank ixs
// (commit 5741bb9 + ee3d082 — alongside max_portfolio_assets in InitMarket).
export interface TradeNoCpiArgs {
  assetIndex: number;          // u16
  sizeQ: bigint;
  execPrice: bigint;
  feeBps: bigint;
}
export function encTradeNoCpi(a: TradeNoCpiArgs): Buffer {
  return Buffer.concat([
    u8(TAG.TradeNoCpi),
    u16le(a.assetIndex),
    i128le(a.sizeQ),
    u64le(a.execPrice),
    u64le(a.feeBps),
  ]);
}

export interface TradeCpiArgs {
  assetIndex: number;          // u16
  sizeQ: bigint;
  feeBps: bigint;
  limitPrice: bigint;
}
export function encTradeCpi(a: TradeCpiArgs): Buffer {
  return Buffer.concat([
    u8(TAG.TradeCpi),
    u16le(a.assetIndex),
    i128le(a.sizeQ),
    u64le(a.feeBps),
    u64le(a.limitPrice),
  ]);
}

// BatchTradeNoCpi (tag 66) — atomic multi-leg bilateral trade, up to 16 legs
// against a single counterparty pair.  Each leg's signed `sizeQ` sets direction,
// so a single batch can carry mixed long/short. Wire:
//   [66, n:u8, [u16 asset_index, i128 size_q, u64 exec_price, u64 fee_bps] × n]
// Accounts mirror TradeNoCpi: [signer_a, signer_b, market, account_a, account_b]
export interface BatchTradeLeg {
  assetIndex: number; sizeQ: bigint; execPrice: bigint; feeBps: bigint;
}
export function encBatchTradeNoCpi(legs: BatchTradeLeg[]): Buffer {
  if (legs.length === 0 || legs.length > 16) throw new Error("BatchTradeNoCpi: 1..=16 legs");
  return Buffer.concat([
    u8(TAG.BatchTradeNoCpi),
    u8(legs.length),
    ...legs.flatMap(l => [u16le(l.assetIndex), i128le(l.sizeQ), u64le(l.execPrice), u64le(l.feeBps)]),
  ]);
}

// BatchTradeCpi (tag 67) — matcher batch fill, up to 16 legs against a single
// LP via matcher CPI (matcher tag 3).  Each leg's signed `sizeQ` sets direction.
// Wire: [67, n:u8, [u16 asset_index, i128 size_q, u64 fee_bps, u64 limit_price] × n]
// Accounts mirror TradeCpi (7 fixed under 7144d9b):
//   [signer_a, market, account_a, account_b, matcher_program, matcher_context, matcher_delegate, …tail]
export interface BatchTradeCpiLeg {
  assetIndex: number; sizeQ: bigint; feeBps: bigint; limitPrice: bigint;
}
export function encBatchTradeCpi(legs: BatchTradeCpiLeg[]): Buffer {
  if (legs.length === 0 || legs.length > 16) throw new Error("BatchTradeCpi: 1..=16 legs");
  return Buffer.concat([
    u8(TAG.BatchTradeCpi),
    u8(legs.length),
    ...legs.flatMap(l => [u16le(l.assetIndex), i128le(l.sizeQ), u64le(l.feeBps), u64le(l.limitPrice)]),
  ]);
}

// RestartAsset0Oracle (tag 69) — market-authority recovery primitive.  Re-arms
// asset 0 (which must be in RECOVERY with no open positions) at a fresh
// `initialPrice`, preserving its insurance budget.  Accounts:
//   [admin(signer), market]
// Wire: [69, u64 now_slot, u64 initial_price]
export interface RestartAsset0OracleArgs { nowSlot: bigint; initialPrice: bigint; }
export function encRestartAsset0Oracle(a: RestartAsset0OracleArgs): Buffer {
  return Buffer.concat([u8(TAG.RestartAsset0Oracle), u64le(a.nowSlot), u64le(a.initialPrice)]);
}

export interface PermissionlessCrankArgs {
  action: number;
  assetIndex: number;        // u16 since commit 5741bb9
  nowSlot: bigint;
  fundingRateE9: bigint;
  closeQ: bigint;
  feeBps: bigint;
  recoveryReason: number;
}
// `effective_price` was REMOVED from the wire in commit 4c93b82
// ("Remove public crank price input") — the crank now reads price from the
// asset's oracle/mark, not a caller-supplied value.
export function encPermissionlessCrank(a: PermissionlessCrankArgs): Buffer {
  return Buffer.concat([
    u8(TAG.PermissionlessCrank),
    u8(a.action),
    u16le(a.assetIndex),
    u64le(a.nowSlot),
    i128le(a.fundingRateE9),
    u128le(a.closeQ),
    u64le(a.feeBps),
    u8(a.recoveryReason),
  ]);
}

export interface TopUpBackingBucketArgs {
  domain: number; amount: bigint; expirySlot: bigint;
}
export function encTopUpBackingBucket(a: TopUpBackingBucketArgs): Buffer {
  return Buffer.concat([
    u8(TAG.TopUpBackingBucket),
    u8(a.domain),
    u128le(a.amount),
    u64le(a.expirySlot),
  ]);
}

// UpdateAuthority (tag 32): rotates the market-wide `marketauth` key
// (post-792256b authority collapse). No `kind` discriminator — only one
// market-level authority exists. Per-asset oracle authority rotation is now
// handled by `UpdateAssetAuthority` (tag 65) which carries asset_index + kind.
// `kind` is preserved on the interface for source compat with old call sites
// but is unused on the wire — every market-level rotation hits `marketauth`.
export interface UpdateAuthorityArgs { kind?: number; newPubkey: PublicKey | string; }
export function encUpdateAuthority(a: UpdateAuthorityArgs): Buffer {
  return Buffer.concat([u8(TAG.UpdateAuthority), pkLE(a.newPubkey)]);
}
// UpdateAssetAuthority (tag 65) — rotates a per-asset authority slot.
// `kind` is the per-asset authority kind code (defined by the program).
export interface UpdateAssetAuthorityArgs { assetIndex: number; kind: number; newPubkey: PublicKey | string; }
export function encUpdateAssetAuthority(a: UpdateAssetAuthorityArgs): Buffer {
  return Buffer.concat([u8(65), u16le(a.assetIndex), u8(a.kind), pkLE(a.newPubkey)]);
}

export interface UpdateInsurancePolicyArgs {
  maxBps: number;
  depositsOnly: number;
  cooldownSlots: bigint;
}
export function encUpdateInsurancePolicy(a: UpdateInsurancePolicyArgs): Buffer {
  return Buffer.concat([
    u8(TAG.UpdateInsurancePolicy),
    u16le(a.maxBps), u8(a.depositsOnly), u64le(a.cooldownSlots),
  ]);
}

export function encUpdateLiquidationFeePolicy(crankerShareBps: number): Buffer {
  return Buffer.concat([u8(TAG.UpdateLiquidationFeePolicy), u16le(crankerShareBps)]);
}

// 49 UpdateMaintenanceFeePolicy (commit 689b90e) — admin sets cranker share
// of the maintenance fee. Validated cranker_share_bps <= 10_000.
// Accounts: [admin, market]
export function encUpdateMaintenanceFeePolicy(crankerShareBps: number): Buffer {
  return Buffer.concat([u8(TAG.UpdateMaintenanceFeePolicy), u16le(crankerShareBps)]);
}

// 50 WithdrawBackingBucket (commit 55e53d0) — backing-bucket authority drains
// an outstanding backing-bucket reserve (symmetric to TopUpBackingBucket).
// Accounts: [authority(signer), market, dest_token, vault_token, vault_authority, token_program]
export interface WithdrawBackingBucketArgs { domain: number; amount: bigint; }
export function encWithdrawBackingBucket(a: WithdrawBackingBucketArgs): Buffer {
  return Buffer.concat([u8(TAG.WithdrawBackingBucket), u8(a.domain), u128le(a.amount)]);
}

export interface ConfigurePermissionlessResolveArgs {
  staleSlots: bigint; forceCloseDelaySlots: bigint;
}
export function encConfigurePermissionlessResolve(a: ConfigurePermissionlessResolveArgs): Buffer {
  return Buffer.concat([
    u8(TAG.ConfigurePermissionlessResolve),
    u64le(a.staleSlots), u64le(a.forceCloseDelaySlots),
  ]);
}

export function encResolveStalePermissionless(nowSlot: bigint): Buffer {
  return Buffer.concat([u8(TAG.ResolveStalePermissionless), u64le(nowSlot)]);
}

// Per-asset oracle ixs (commit 62fe9de): each now takes asset_index:u16 first.
export interface ConfigureHybridOracleArgs {
  assetIndex: number;
  nowSlot: bigint;
  nowUnixTs: bigint;
  oracleLegCount: number;
  oracleLegFlags: number;
  maxStalenessSecs: bigint;
  hybridSoftStaleSlots: bigint;
  markEwmaHalflifeSlots: bigint;
  markMinFee: bigint;
  invert: number;
  unitScale: number;
  confFilterBps: number;
  oracleLegFeeds: [string, string, string];
}
export function encConfigureHybridOracle(a: ConfigureHybridOracleArgs): Buffer {
  const leg = (h: string) => {
    const b = Buffer.from(h.replace(/^0x/, ""), "hex");
    if (b.length !== 32) throw new Error(`leg feed must be 32 bytes hex, got ${b.length}`);
    return b;
  };
  return Buffer.concat([
    u8(TAG.ConfigureHybridOracle),
    u16le(a.assetIndex),
    u64le(a.nowSlot), i64le(a.nowUnixTs),
    u8(a.oracleLegCount), u8(a.oracleLegFlags),
    u64le(a.maxStalenessSecs), u64le(a.hybridSoftStaleSlots),
    u64le(a.markEwmaHalflifeSlots), u64le(a.markMinFee),
    u8(a.invert), u32le(a.unitScale), u16le(a.confFilterBps),
    leg(a.oracleLegFeeds[0]), leg(a.oracleLegFeeds[1]), leg(a.oracleLegFeeds[2]),
  ]);
}

// ConfigureEwmaMark (tag 35) — set an asset to EWMA-MARK oracle mode with a
// starting mark + halflife.  Authority = market admin for asset 0.
// (Wrapper 7144d9b renamed this from `ConfigureHyperpMark`; same wire format.)
export interface ConfigureEwmaMarkArgs {
  assetIndex: number;
  nowSlot: bigint;
  initialMarkE6: bigint;
  markEwmaHalflifeSlots: bigint;
  markMinFee: bigint;
}
export function encConfigureEwmaMark(a: ConfigureEwmaMarkArgs): Buffer {
  return Buffer.concat([
    u8(TAG.ConfigureEwmaMark),
    u16le(a.assetIndex),
    u64le(a.nowSlot), u64le(a.initialMarkE6),
    u64le(a.markEwmaHalflifeSlots), u64le(a.markMinFee),
  ]);
}
// Deprecated alias for older call sites — same wire, same opcode.
export type ConfigureHyperpMarkArgs = ConfigureEwmaMarkArgs;
export const encConfigureHyperpMark = encConfigureEwmaMark;

// PushEwmaMark (tag 36) — push a new mark target; engine walks effective_price
// toward it bounded by max_price_move_bps_per_slot and the EWMA halflife.
export interface PushEwmaMarkArgs { assetIndex: number; nowSlot: bigint; markE6: bigint; }
export function encPushEwmaMark(a: PushEwmaMarkArgs): Buffer {
  return Buffer.concat([
    u8(TAG.PushEwmaMark),
    u16le(a.assetIndex),
    u64le(a.nowSlot), u64le(a.markE6),
  ]);
}
export type PushHyperpMarkArgs = PushEwmaMarkArgs;
export const encPushHyperpMark = encPushEwmaMark;

// 62 ConfigureAuthMark — set an asset to AUTH_MARK oracle mode with an initial
// mark. Authority = market admin for asset 0, else the per-asset oracle_authority.
// Accounts: [authority(signer), market(w)]. Wire: asset_index:u16, now_slot:u64,
// initial_mark_e6:u64. (Replaces the retired ConfigureHyperpMark.)
export interface ConfigureAuthMarkArgs { assetIndex: number; nowSlot: bigint; initialMarkE6: bigint; }
export function encConfigureAuthMark(a: ConfigureAuthMarkArgs): Buffer {
  return Buffer.concat([
    u8(TAG.ConfigureAuthMark),
    u16le(a.assetIndex),
    u64le(a.nowSlot), u64le(a.initialMarkE6),
  ]);
}

// 63 PushAuthMark — push a new mark to an AUTH_MARK asset (the oracle target the
// engine walks effective_price toward, bounded by max_price_move_bps_per_slot).
// Accounts: [authority(signer), market(w)]. Wire: asset_index:u16, now_slot:u64, mark_e6:u64.
export interface PushAuthMarkArgs { assetIndex: number; nowSlot: bigint; markE6: bigint; }
export function encPushAuthMark(a: PushAuthMarkArgs): Buffer {
  return Buffer.concat([
    u8(TAG.PushAuthMark),
    u16le(a.assetIndex),
    u64le(a.nowSlot), u64le(a.markE6),
  ]);
}

// ============================================================================
// Collateral-accounting + base-unit-custody ixs (commits 05a8f84, ea7ef40)
// Wire formats verified against the tag decoder in v16_program.rs (HEAD ea7ef40).
// ============================================================================

// 51 UpdateBackingFeePolicy — admin sets per-domain backing-trade-fee policy.
// Accounts: [admin(signer), market]
export interface UpdateBackingFeePolicyArgs {
  domain: number;            // u8 (asset_index*2 + side)
  feeBps: number;            // u16
  insuranceShareBps: number; // u16
}
export function encUpdateBackingFeePolicy(a: UpdateBackingFeePolicyArgs): Buffer {
  return Buffer.concat([
    u8(TAG.UpdateBackingFeePolicy),
    u8(a.domain), u16le(a.feeBps), u16le(a.insuranceShareBps),
  ]);
}

// 52 WithdrawBackingBucketEarnings — backing authority draws accrued earnings.
// Accounts: [authority(signer), market, dest_token, vault_token, vault_authority, token_program]
export interface WithdrawBackingBucketEarningsArgs { domain: number; amount: bigint; }
export function encWithdrawBackingBucketEarnings(a: WithdrawBackingBucketEarningsArgs): Buffer {
  return Buffer.concat([u8(TAG.WithdrawBackingBucketEarnings), u8(a.domain), u128le(a.amount)]);
}

// 53 SyncBackingDomainLedger — refresh a BackingDomainLedger account's counters.
// Accounts: [market, ledger]
export function encSyncBackingDomainLedger(domain: number): Buffer {
  return Buffer.concat([u8(TAG.SyncBackingDomainLedger), u8(domain)]);
}

// 54 SyncInsuranceLedger — refresh an InsuranceLedger account's counters.
// Accounts: [market, ledger]
export function encSyncInsuranceLedger(): Buffer { return u8(TAG.SyncInsuranceLedger); }

// 68 SetMatcherConfig (commit 7144d9b — replaces SetMatcherAuthorization) —
// LP owner installs/clears a matcher binding directly on the LP portfolio.
// Accounts (enabled=1): [lp_owner(signer), market, lp_portfolio(writable),
//                        matcher_program, matcher_context, matcher_delegate]
// Accounts (enabled=0): [lp_owner(signer), market, lp_portfolio(writable)]
// The wrapper rejects the call if data_len < PORTFOLIO_ACCOUNT_LEN; existing
// portfolios may need to be (re)allocated to the post-7144d9b size (9,299 B).
export function encSetMatcherConfig(enabled: number): Buffer {
  return Buffer.concat([u8(TAG.SetMatcherConfig), u8(enabled)]);
}

// 55 UpdateTradeFeePolicy — admin sets the base trade fee.
// Accounts: [admin(signer), market]
export function encUpdateTradeFeePolicy(tradeFeeBaseBps: bigint): Buffer {
  return Buffer.concat([u8(TAG.UpdateTradeFeePolicy), u64le(tradeFeeBaseBps)]);
}

// 56 TopUpInsuranceDomain — credit insurance budget to a specific domain.
// Accounts: [signer, market, source_token, vault_token, token_program, (opt) ledger]
export interface TopUpInsuranceDomainArgs { domain: number; amount: bigint; }
export function encTopUpInsuranceDomain(a: TopUpInsuranceDomainArgs): Buffer {
  return Buffer.concat([u8(TAG.TopUpInsuranceDomain), u8(a.domain), u128le(a.amount)]);
}

// 57 WithdrawInsuranceDomain — withdraw from a specific domain's insurance budget.
// Accounts: [authority(signer), market, dest_token, vault_token, vault_authority, token_program]
export interface WithdrawInsuranceDomainArgs { domain: number; amount: bigint; }
export function encWithdrawInsuranceDomain(a: WithdrawInsuranceDomainArgs): Buffer {
  return Buffer.concat([u8(TAG.WithdrawInsuranceDomain), u8(a.domain), u128le(a.amount)]);
}

// 58 UpdateFeeRedirectPolicy — admin sets fee_redirect_to_market_0_bps (0..=10_000).
// Accounts: [admin(signer), market]
export function encUpdateFeeRedirectPolicy(redirectBps: number): Buffer {
  return Buffer.concat([u8(TAG.UpdateFeeRedirectPolicy), u16le(redirectBps)]);
}

// 59 UpdateMarketInitFeePolicy — admin sets permissionless_market_init_fee.
// Accounts: [admin(signer), market]
export function encUpdateMarketInitFeePolicy(minInitFee: bigint): Buffer {
  return Buffer.concat([u8(TAG.UpdateMarketInitFeePolicy), u128le(minInitFee)]);
}

// 60 UpdateBaseUnitMints — base_unit_authority sets primary + secondary mints.
// Accounts: [authority(signer), market, primary_mint, secondary_mint]
// Constraints: both non-zero and distinct.
export interface UpdateBaseUnitMintsArgs {
  primaryMint: PublicKey | string;
  secondaryMint: PublicKey | string;
}
export function encUpdateBaseUnitMints(a: UpdateBaseUnitMintsArgs): Buffer {
  return Buffer.concat([u8(TAG.UpdateBaseUnitMints), pkLE(a.primaryMint), pkLE(a.secondaryMint)]);
}

// 64 ForceCloseAbandonedAsset — permissionless force-close of abandoned positions
// in a SHUT-DOWN asset, once the shutdown force_close_delay timer has elapsed.
// Closes the matched exposure between two counterparty portfolios at the frozen
// mark. The cranker signs; the position owners do NOT.
// Accounts: [cranker(signer), market, account_a, account_b]
export interface ForceCloseAbandonedAssetArgs { assetIndex: number; nowSlot: bigint; closeQ: bigint; }
export function encForceCloseAbandonedAsset(a: ForceCloseAbandonedAssetArgs): Buffer {
  return Buffer.concat([u8(TAG.ForceCloseAbandonedAsset), u16le(a.assetIndex), u64le(a.nowSlot), u128le(a.closeQ)]);
}

// 61 SwapSecondaryForPrimary — atomically swap primary in / secondary out from vaults.
// Accounts: [authority(signer), market, primary_source, primary_vault,
//            secondary_dest, secondary_vault, vault_authority, token_program]
export function encSwapSecondaryForPrimary(amount: bigint): Buffer {
  return Buffer.concat([u8(TAG.SwapSecondaryForPrimary), u128le(amount)]);
}
