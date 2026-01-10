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
 * InitMarket: 9 accounts (Pyth Pull - feed_id is in instruction data, not as accounts)
 */
export const ACCOUNTS_INIT_MARKET: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "mint", signer: false, writable: false },
  { name: "vault", signer: false, writable: false },
  { name: "tokenProgram", signer: false, writable: false },
  { name: "clock", signer: false, writable: false },
  { name: "rent", signer: false, writable: false },
  { name: "dummyAta", signer: false, writable: false },
  { name: "systemProgram", signer: false, writable: false },
] as const;

/**
 * InitUser: 5 accounts (clock/oracle removed in commit 410f947)
 */
export const ACCOUNTS_INIT_USER: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
] as const;

/**
 * InitLP: 5 accounts (clock/oracle removed in commit 410f947)
 */
export const ACCOUNTS_INIT_LP: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
] as const;

/**
 * DepositCollateral: 5 accounts
 */
export const ACCOUNTS_DEPOSIT_COLLATERAL: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
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
  { name: "oracleIdx", signer: false, writable: false },
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
export const ACCOUNTS_LIQUIDATE_AT_ORACLE: readonly AccountSpec[] = [
  { name: "unused", signer: false, writable: false },
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
 * TopUpInsurance: 5 accounts
 */
export const ACCOUNTS_TOPUP_INSURANCE: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
  { name: "userAta", signer: false, writable: true },
  { name: "vault", signer: false, writable: true },
  { name: "tokenProgram", signer: false, writable: false },
] as const;

/**
 * TradeCpi: 8 accounts
 */
export const ACCOUNTS_TRADE_CPI: readonly AccountSpec[] = [
  { name: "user", signer: true, writable: false },
  { name: "lpOwner", signer: true, writable: false },
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
 * UpdateAdmin: 2 accounts
 */
export const ACCOUNTS_UPDATE_ADMIN: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: false },
  { name: "slab", signer: false, writable: true },
] as const;

/**
 * CloseSlab: 2 accounts
 */
export const ACCOUNTS_CLOSE_SLAB: readonly AccountSpec[] = [
  { name: "admin", signer: true, writable: true },
  { name: "slab", signer: false, writable: true },
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
