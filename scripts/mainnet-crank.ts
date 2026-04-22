/**
 * Hourly permissionless crank for the mainnet inverted-SOL market.
 *
 * Reads mainnet-market.json for the slab + oracle addresses and fires a
 * single permissionless KeeperCrank (caller_idx = 0xFFFF). Priority fee
 * is 1 microlamport/CU — rounds to effectively zero on the 300k-CU
 * transaction, so this costs only the signature fee (~5000 lamports).
 *
 * Intended to run under cron once per hour — well within the 48h
 * permissionless-resolve window and plenty of margin on the 60-second
 * Pyth staleness cap (Pyth sponsor posts every ~2 s).
 *
 * Exit codes:
 *   0 = crank landed, market still Live
 *   1 = any error (tx failed, market Resolved, RPC unreachable)
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { encodeKeeperCrank } from "../src/abi/instructions.js";
import { ACCOUNTS_KEEPER_CRANK, buildAccountMetas, WELL_KNOWN } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { parseEngine, fetchSlab } from "../src/solana/slab.js";

async function main() {
  const manifestPath = process.env.MARKET_MANIFEST
    || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "mainnet-market.json");
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const slab = new PublicKey(m.slab);
  const oracle = new PublicKey(m.oracle);
  const program = new PublicKey(m.programId);

  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");

  const now = new Date().toISOString();
  console.log(`[${now}] crank slab=${slab.toBase58()}`);

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }))
    .add(buildIx({
      programId: program,
      keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        payer.publicKey, slab, WELL_KNOWN.clock, oracle,
      ]),
      data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }),
    }));

  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed",
    skipPreflight: true,
  });

  const e = parseEngine(await fetchSlab(conn, slab));
  console.log(`[${now}] sig=${sig.slice(0, 32)}... mode=${e.marketMode === 0 ? "Live" : "Resolved"} lastOraclePrice=${e.lastOraclePrice} currentSlot=${e.currentSlot}`);

  if (e.marketMode !== 0) {
    console.error(`[${now}] FATAL: market mode is ${e.marketMode} (not Live). Cron should stop.`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] FATAL:`, e.message ?? e);
  process.exit(1);
});
