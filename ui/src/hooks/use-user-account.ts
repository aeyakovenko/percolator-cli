import { useMemo } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { SlabSnapshot } from "./use-slab";
import { AccountKind } from "@parsers/slab";

export interface UserAccountInfo {
  idx: number;
  accountId: bigint;
  capital: bigint;
  positionSize: bigint;
  entryPrice: bigint;
  pnl: bigint;
  feeCredits: bigint;
  kind: AccountKind;
  /** Margin health: capital / required margin (using initial margin) */
  marginHealthPct: number;
}

/**
 * Hook that finds the connected wallet's user account in the slab.
 * Returns null if wallet not connected or no account found.
 */
export function useUserAccount(
  data: SlabSnapshot | null,
  walletPubkey: PublicKey | null
): UserAccountInfo | null {
  return useMemo(() => {
    if (!data || !walletPubkey) return null;

    const walletStr = walletPubkey.toBase58();

    for (const { idx, account } of data.accounts) {
      if (account.owner.toBase58() === walletStr && account.kind === AccountKind.User) {
        // Compute margin health
        const absPos = account.positionSize < 0n
          ? -account.positionSize
          : account.positionSize;
        const initialMarginBps = data.params.initialMarginBps;
        const requiredMargin = (absPos * initialMarginBps) / 10_000n;
        const marginHealthPct = requiredMargin > 0n
          ? (Number(account.capital) / Number(requiredMargin)) * 100
          : account.capital > 0n ? 999 : 0;

        return {
          idx,
          accountId: account.accountId,
          capital: account.capital,
          positionSize: account.positionSize,
          entryPrice: account.entryPrice,
          pnl: account.pnl,
          feeCredits: account.feeCredits,
          kind: account.kind,
          marginHealthPct,
        };
      }
    }

    return null;
  }, [data, walletPubkey]);
}
