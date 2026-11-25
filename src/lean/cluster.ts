/**
 * Cluster guard: the operator wallet holds mainnet SOL, and the lean programs are
 * devnet-only. Every signing lean script must call `assertDevnet` before sending.
 */
import { Connection } from "@solana/web3.js";

export const GENESIS = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
} as const;

export async function assertDevnet(conn: Connection): Promise<void> {
  const g = await conn.getGenesisHash();
  if (g !== GENESIS.devnet) {
    const name = Object.entries(GENESIS).find(([, h]) => h === g)?.[0] ?? "unknown";
    throw new Error(`refusing to sign: RPC ${conn.rpcEndpoint} is ${name} (genesis ${g}), not devnet`);
  }
}
