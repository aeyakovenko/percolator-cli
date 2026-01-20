/**
 * Fund LP for testing - deposit collateral to LP index 0
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { encodeDepositCollateral, encodeKeeperCrank } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseAccount, parseEngine } from "../src/solana/slab.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const VAULT = new PublicKey(marketInfo.vault);
const LP_IDX = 0;

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function runCrank(): Promise<void> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);
  const crankTx = new Transaction();
  crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
  crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: "confirmed" });
}

async function main() {
  console.log("=== Fund LP for Testing ===\n");

  // Get user ATA
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  console.log("User ATA:", userAta.address.toBase58());
  console.log("Vault:", VAULT.toBase58());
  console.log("Slab:", SLAB.toBase58());

  // Check ATA balance
  const balance = await conn.getTokenAccountBalance(userAta.address);
  console.log("ATA balance:", balance.value.uiAmount, "SOL\n");

  // Run crank to ensure fresh
  console.log("Running cranks...");
  for (let i = 0; i < 3; i++) {
    try {
      await runCrank();
      console.log("Crank " + (i + 1) + " done");
    } catch (e: any) {
      console.log("Crank failed:", e.message?.slice(0, 50));
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Check LP before
  let data = await fetchSlab(conn, SLAB);
  let lpAcc = parseAccount(data, LP_IDX);
  let engine = parseEngine(data);
  console.log("\nBefore deposit:");
  console.log("  LP capital:", Number(lpAcc.capital) / 1e9, "SOL");
  console.log("  Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");

  console.log("\nDepositing 1 SOL to LP...");
  const depositData = encodeDepositCollateral({ userIdx: LP_IDX, amount: "1000000000" }); // 1 SOL
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));

  try {
    const depSig = await sendAndConfirmTransaction(conn, depositTx, [payer], { commitment: "confirmed" });
    console.log("Deposit successful:", depSig.slice(0, 40) + "...");

    // Check after
    data = await fetchSlab(conn, SLAB);
    lpAcc = parseAccount(data, LP_IDX);
    engine = parseEngine(data);
    console.log("\nAfter deposit:");
    console.log("  LP capital:", Number(lpAcc.capital) / 1e9, "SOL");
    console.log("  Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  } catch (err: any) {
    console.log("Deposit failed:", err.message?.slice(0, 200));
    if (err.logs) {
      console.log("Logs:", err.logs.slice(-8).join("\n      "));
    }
  }
}

main();
