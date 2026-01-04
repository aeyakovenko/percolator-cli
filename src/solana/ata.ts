import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, Account } from "@solana/spl-token";

/**
 * Get the associated token address for an owner and mint.
 */
export async function getAta(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(mint, owner);
}

/**
 * Fetch token account info.
 * Throws if account doesn't exist.
 */
export async function fetchTokenAccount(
  connection: Connection,
  address: PublicKey
): Promise<Account> {
  return getAccount(connection, address);
}
