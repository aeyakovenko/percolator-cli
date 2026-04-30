import {
  PublicKey,
  AccountMeta,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

/**
 * Account spec for building instruction account metas.
 * Each instruction has a fixed ordering that matches the Rust processor.
 */
export interface AccountSpec {
  name: string;
  signer: boolean;
  writable: boolean;
}

// ============================================================================
// ACCOUNT ORDERINGS - Single source of truth
// ============================================================================

/**
 * InitMarket: 6 accounts (v12.21+; was 9).
 *   [0] admin   — signer; must equal `args.admin`
 *   [1] slab    — writable; sized exactly SLAB_LEN
 *   [2] mint    — SPL Token mint, must equal `args.collateral_mint`
 *   [3] vault   — SPL token account at the vault PDA
 *   [4] clock   — Clock sysvar
 *   [5] oracle  — Pyth/Chainlink index feed (unread for Hyperp markets)
 */
export const ACCOUNTS_INIT_MARKET: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "mint", signer: false, writable: false },
  { name: "vault", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

/**
 * InitUser: 6 accounts
 */
export const ACCOUNTS_INIT_USER: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * InitLP: 6 accounts
 */
export const ACCOUNTS_INIT_LP: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * DepositCollateral: 6 accounts
 */
export const ACCOUNTS_DEPOSIT_COLLATERAL: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * WithdrawCollateral: 8 accounts
 */
export const ACCOUNTS_WITHDRAW_COLLATERAL: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vaultPda", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

/**
 * KeeperCrank: 4 accounts
 */
export const ACCOUNTS_KEEPER_CRANK: readonly AccountSpec[] = [
  { name: "caller", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

/**
 * TradeNoCpi: 5 accounts
 */
export const ACCOUNTS_TRADE_NOCPI: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "lp", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

/**
 * LiquidateAtOracle: 4 accounts
 * Note: account[0] is unused but must be present
 */
// v12.21+: LiquidateAtOracle is permissionless (no signer) and takes 3 accts.
export const ACCOUNTS_LIQUIDATE_AT_ORACLE: readonly AccountSpec[] = [
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

/**
 * CloseAccount: 8 accounts
 */
export const ACCOUNTS_CLOSE_ACCOUNT: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vaultPda", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

/**
 * TopUpInsurance: 6 accounts
 */
export const ACCOUNTS_TOPUP_INSURANCE: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * TradeCpi: 8 accounts
 */
export const ACCOUNTS_TRADE_CPI: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "lpOwner", signer: false, writable: false },  // LP delegated to matcher - no signature needed
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
  { name: "matcherProg", signer: false, writable: false },
  { name: "matcherCtx", signer: false, writable: true },
  { name: "lpPda", signer: false, writable: false },
] as const;

/**
 * SetRiskThreshold: 2 accounts
 */
export const ACCOUNTS_SET_RISK_THRESHOLD: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
] as const;

/**
 * UpdateAuthority (kind=ADMIN): 3 accounts
 * [current_authority (signer), new_authority (signer unless burn), slab (writable)]
 */
export const ACCOUNTS_UPDATE_ADMIN: readonly AccountSpec[] = [
  { name: "current_authority", signer: true, writable: false },
  { name: "new_authority", signer: false, writable: false },
  { name: "slab", signer: false, writable: true },
] as const;

/**
 * CloseSlab: 6 accounts
 */
export const ACCOUNTS_CLOSE_SLAB: readonly AccountSpec[] = [
  { name: "dest", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "vaultAuth", signer: false, writable: false },
  { name: "destAta", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
] as const;

/**
 * UpdateConfig: 3 accounts
 */
/**
 * UpdateConfig: 4 accounts — admin, slab, clock, oracle.
 * The oracle is REQUIRED (v12.18+). Omitting it used to force accrual
 * rate to zero, which let admin retroactively erase elapsed funding.
 * Hyperp markets pass the slab itself as the oracle slot (engine-internal).
 */
export const ACCOUNTS_UPDATE_CONFIG: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

/**
 * SetMaintenanceFee: 2 accounts
 */
export const ACCOUNTS_SET_MAINTENANCE_FEE: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
] as const;

/**
 * UpdateAuthority (kind=ORACLE): 3 accounts
 * [current_authority (signer), new_authority (signer unless burn), slab (writable)]
 */
export const ACCOUNTS_SET_ORACLE_AUTHORITY: readonly AccountSpec[] = [
  { name: "current_authority", signer: true, writable: false },
  { name: "new_authority", signer: false, writable: false },
  { name: "slab", signer: false, writable: true },
] as const;

// SetOraclePriceCap (tag 18) was deleted in v12.21 — no account spec.

/**
 * PushOraclePrice: 2 accounts
 * Push oracle price (oracle authority only)
 */
export const ACCOUNTS_PUSH_ORACLE_PRICE: readonly AccountSpec[] = [
  { name: "authority", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
] as const;

/**
 * ResolveMarket: 4 accounts
 * Resolves a binary/premarket (admin only)
 */
export const ACCOUNTS_RESOLVE_MARKET: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

/**
 * WithdrawInsurance: 6 accounts
 * Withdraw insurance fund after market resolution (admin only)
 */
export const ACCOUNTS_WITHDRAW_INSURANCE: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "adminAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "vaultPda", signer: false, writable: false },
] as const;

/**
 * AdminForceCloseAccount: 8 accounts
 * Force-close an abandoned account after resolution (admin only)
 */
// v12.21+: AdminForceCloseAccount takes 7 accounts (oracle slot removed —
// resolved markets read engine.resolved_price).
export const ACCOUNTS_ADMIN_FORCE_CLOSE: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vaultPda", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * SetInsuranceWithdrawPolicy: 2 accounts
 * Set limited insurance-withdraw policy (admin only, resolved market)
 */
export const ACCOUNTS_SET_INSURANCE_WITHDRAW_POLICY: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
] as const;

/**
 * WithdrawInsuranceLimited: 7 accounts
 * Withdraw insurance under configured min/max/cooldown constraints
 */
export const ACCOUNTS_WITHDRAW_INSURANCE_LIMITED: readonly AccountSpec[] = [
  { name: "authority", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "authorityAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "vaultPda", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * QueryLpFees: 1 account
 * Query cumulative fees earned by an LP position (read-only)
 */
export const ACCOUNTS_QUERY_LP_FEES: readonly AccountSpec[] = [
  { name: "slab", signer: false, writable: false },
] as const;

/**
 * ReclaimEmptyAccount: 2 accounts
 */
export const ACCOUNTS_RECLAIM_EMPTY_ACCOUNT: readonly AccountSpec[] = [
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * SettleAccount: 3 accounts
 */
export const ACCOUNTS_SETTLE_ACCOUNT: readonly AccountSpec[] = [
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

/**
 * DepositFeeCredits: 6 accounts
 */
export const ACCOUNTS_DEPOSIT_FEE_CREDITS: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * ConvertReleasedPnl: 4 accounts
 */
export const ACCOUNTS_CONVERT_RELEASED_PNL: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

/**
 * ForceCloseResolved: 7 accounts
 */
// v12.21+: ForceCloseResolved (permissionless) takes 6 accounts; the
// trailing `oracle` slot was removed (resolved markets read engine.resolved_price).
export const ACCOUNTS_FORCE_CLOSE_RESOLVED: readonly AccountSpec[] = [
  { name: "slab", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "ownerAta", signer: false, writable: true },
  { name: "vaultPda", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * ResolvePermissionless: 2 accounts.
 * Wrapper enforces `expect_len(accounts, 2)` — no oracle account. The
 * instruction settles at engine.last_oracle_price; liveness is judged
 * by stored slots, not by submitting a fresh feed.
 */
export const ACCOUNTS_RESOLVE_PERMISSIONLESS: readonly AccountSpec[] = [
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
] as const;

/**
 * CatchupAccrue: 3 accounts (slab, clock, oracle).
 * Requires a LIVE oracle — proves the market is live before advancing
 * the engine's market clock. Dead-oracle markets must route through
 * ResolvePermissionless instead.
 */
export const ACCOUNTS_CATCHUP_ACCRUE: readonly AccountSpec[] = [
  { name: "slab", signer: false, writable: true },
  { name: "clock", signer: false, writable: false },
  { name: "oracle", signer: false, writable: false },
] as const;

// ============================================================================
// ACCOUNT META BUILDERS
// ============================================================================

/**
 * Build AccountMeta array from spec and provided pubkeys.
 * Keys must be provided in the same order as the spec.
 */
export function buildAccountMetas(
  spec: readonly AccountSpec[],
  keys: PublicKey[]
): AccountMeta[] {
  if (keys.length !== spec.length) {
    throw new Error(
      `Account count mismatch: expected ${spec.length}, got ${keys.length}`
    );
  }
  return spec.map((s, i) => ({
    pubkey: keys[i],
    isSigner: s.signer,
    isWritable: s.writable,
  }));
}

// ============================================================================
// WELL-KNOWN PROGRAM/SYSVAR KEYS
// ============================================================================

export const WELL_KNOWN = {
  tokenProgram: TOKEN_PROGRAM_ID,
  clock: SYSVAR_CLOCK_PUBKEY,
  rent: SYSVAR_RENT_PUBKEY,
  systemProgram: SystemProgram.programId,
} as const;
