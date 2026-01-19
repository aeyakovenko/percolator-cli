import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { encodeDepositCollateral, encodeKeeperCrank } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseAccount } from "../src/solana/slab.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const ORACLE = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const VAULT = new PublicKey("6E7UhxdyMBmLAGrzTEBGLWg7AQvA5iPygbFEwWYtNBm"); // Correct vault for OLD slab!
const USER_IDX = 6;

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
  console.log("=== Debug Deposit (with correct vault) ===\n");

  // Get user ATA
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  console.log("User ATA:", userAta.address.toBase58());
  console.log("Vault:", VAULT.toBase58());

  // Check ATA balance
  const balance = await conn.getTokenAccountBalance(userAta.address);
  console.log("ATA balance:", balance.value.uiAmount, "SOL\n");

  // Run crank to ensure fresh
  console.log("Running cranks...");
  for (let i = 0; i < 3; i++) {
    try {
      await runCrank();
      console.log("Crank " + (i + 1) + " done");
    } catch {
      // ignore
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // Check user before
  let data = await fetchSlab(conn, SLAB);
  let userAcc = parseAccount(data, USER_IDX);
  console.log("\nBefore deposit:");
  console.log("  User 6 capital:", Number(userAcc.capital) / 1e9, "SOL");

  console.log("\nTrying deposit...");
  const depositData = encodeDepositCollateral({ userIdx: USER_IDX, amount: "1000000000" }); // 1 SOL
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
    console.log("Deposit successful:", depSig.slice(0, 20) + "...");

    // Check after
    data = await fetchSlab(conn, SLAB);
    userAcc = parseAccount(data, USER_IDX);
    console.log("\nAfter deposit:");
    console.log("  User 6 capital:", Number(userAcc.capital) / 1e9, "SOL");
  } catch (err) {
    console.log("Deposit failed:", (err as any).message?.slice(0, 200));
    if ((err as any).logs) {
      console.log("Logs:", (err as any).logs.slice(-8).join("\n      "));
    }
  }
}

main();
