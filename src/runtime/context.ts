import { Connection, PublicKey, Commitment, Keypair } from "@solana/web3.js";
import { Config } from "../config.js";
import { loadKeypair } from "../solana/wallet.js";

/**
 * Runtime context for read-only commands.
 */
export interface ReadOnlyContext {
  connection: Connection;
  programId: PublicKey;
  commitment: Commitment;
}

/**
 * Runtime context for commands that need a signer.
 */
export interface Context extends ReadOnlyContext {
  payer: Keypair;
}

/**
 * Create read-only runtime context from config without touching a wallet file.
 */
export function createReadOnlyContext(config: Config): ReadOnlyContext {
  const connection = new Connection(config.rpcUrl, config.commitment);
  const programId = new PublicKey(config.programId);

  return {
    connection,
    programId,
    commitment: config.commitment,
  };
}

/**
 * Create signer runtime context from config.
 */
export function createContext(config: Config): Context {
  const readOnly = createReadOnlyContext(config);
  const payer = loadKeypair(config.wallet);

  return {
    ...readOnly,
    payer,
  };
}
