import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitLP,
  encodeDepositCollateral,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  buildAccountMetas,
} from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";

// Load market config
const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const OLD_MATCHER_CTX = new PublicKey("Ek3EZVpyTH981GYqMqir4oFejoEYuQnUTAHpTzHFQ8yG");

const LP_DEPOSIT = 50_000_000_000n; // 50 SOL

const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

async function main() {
  console.log("=== Reinitializing LP ===\n");

  // Get user's wrapped SOL ATA
  const userAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    NATIVE_MINT,
    payer.publicKey
  );
  console.log("User ATA:", userAta.address.toBase58());

  // Step 1: Init LP
  console.log("\nStep 1: Initializing LP...");
  const initLpData = encodeInitLP({
    matcherProgram: MATCHER_PROGRAM,
    matcherContext: OLD_MATCHER_CTX,
    feePayment: "2000000", // 0.002 SOL
  });

  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
  ]);

  const initLpTx = new Transaction();
  initLpTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  initLpTx.add(buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData }));

  try {
    const sig = await sendAndConfirmTransaction(connection, initLpTx, [payer], { commitment: "confirmed" });
    console.log("  LP initialized!", sig.slice(0, 20) + "...");
  } catch (err: any) {
    console.log("  Failed:", err.message?.slice(0, 200) || err);
    console.log("  Logs:", err.logs?.slice(-5).join("\n        "));
    return;
  }

  // Check what LP index was allocated
  console.log("\nStep 1b: Finding LP index...");
  const { fetchSlab, parseUsedIndices, parseAccount, AccountKind } = await import("../src/solana/slab.js");
  const slabData = await fetchSlab(connection, SLAB);
  const indices = parseUsedIndices(slabData);
  console.log("  Used indices:", indices);

  // Find the LP by checking matcher_program
  let lpIndex = -1;
  for (const idx of indices) {
    const acc = parseAccount(slabData, idx);
    if (acc.matcherProgram && !acc.matcherProgram.equals(new PublicKey("11111111111111111111111111111111"))) {
      console.log(`  Found LP at index ${idx}`);
      lpIndex = idx;
      break;
    }
  }

  if (lpIndex === -1) {
    // Check newly allocated slot (next after max used)
    const maxUsed = Math.max(...indices);
    const potentialLp = maxUsed + 1;
    console.log(`  Checking potential LP at index ${potentialLp}...`);
    try {
      const acc = parseAccount(slabData, potentialLp);
      if (acc.matcherProgram && !acc.matcherProgram.equals(new PublicKey("11111111111111111111111111111111"))) {
        console.log(`  Found LP at index ${potentialLp}!`);
        lpIndex = potentialLp;
      }
    } catch {}
  }

  if (lpIndex === -1) {
    console.log("  ERROR: Could not find LP! InitLP may have failed.");
    return;
  }

  // Step 2: Deposit collateral
  console.log(`\nStep 2: Depositing ${Number(LP_DEPOSIT) / 1e9} SOL to LP at index ${lpIndex}...`);

  // First check ATA balance
  const balance = await connection.getTokenAccountBalance(userAta.address);
  const needed = Number(LP_DEPOSIT) / 1e9;
  if (balance.value.uiAmount! < needed) {
    console.log(`  Need to wrap ${needed - balance.value.uiAmount!} more SOL first`);
    return;
  }

  const depositData = encodeDepositCollateral({
    userIdx: lpIndex,
    amount: LP_DEPOSIT.toString(),
  });

  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));

  try {
    const sig = await sendAndConfirmTransaction(connection, depositTx, [payer], { commitment: "confirmed" });
    console.log("  Deposited!", sig.slice(0, 20) + "...");
  } catch (err: any) {
    console.log("  Failed:", err.message?.slice(0, 200) || err);
    console.log("  Logs:", err.logs?.slice(-5).join("\n        "));
    return;
  }

  console.log("\n=== LP Reinitialized Successfully! ===");
}

main().catch(console.error);
