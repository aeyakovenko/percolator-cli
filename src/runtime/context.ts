import { Connection, PublicKey, Commitment, Keypair } from "@solana/web3.js";
import { Config } from "../config.js";
import { loadKeypair } from "../solana/wallet.js";

/**
 * Runtime context for all commands.
 */
export interface Context {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
  commitment: Commitment;
}

/**
 * Create runtime context from config.
 */
export function createContext(config: Config): Context {
  const connection = new Connection(config.rpcUrl, config.commitment);
  const payer = loadKeypair(config.wallet);
  const programId = new PublicKey(config.programId);

  return {
    connection,
    payer,
    programId,
    commitment: config.commitment,
  };
}
