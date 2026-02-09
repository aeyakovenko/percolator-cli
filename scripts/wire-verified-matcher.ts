/**
 * wire-verified-matcher.ts
 *
 * Wires a verified credibility matcher to the existing adminless market.
 * Run AFTER deploying the verified binary and confirming the hash matches.
 *
 * Usage:
 *   WALLET_PATH=... MATCHER_PROGRAM=<program_id> npx tsx scripts/wire-verified-matcher.ts
 *
 * Environment variables:
 *   WALLET_PATH       - Path to wallet keypair JSON
 *   MATCHER_PROGRAM   - Program ID of the verified credibility matcher
 *   SOLANA_RPC_URL    - RPC URL (default: https://api.devnet.solana.com)
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, ComputeBudgetProgram, SystemProgram,
  SYSVAR_CLOCK_PUBKEY, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitLP, encodeDepositCollateral,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_LP, ACCOUNTS_DEPOSIT_COLLATERAL,
  buildAccountMetas,
} from "../src/abi/accounts.js";
import { deriveLpPda } from "../src/solana/pda.js";
import { buildIx } from "../src/runtime/tx.js";
import { parseUsedIndices } from "../src/solana/slab.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SLAB_PUBKEY = new PublicKey("75h2kF58m3ms77c8WwzQh6h4iT2XMA1F5Mk13FZ6CCUs");
const VAULT_PUBKEY = new PublicKey("8yVk7ULLjErxGAUDU6a4LGpLmCvD7K69Z7dkSBvz74Th");
const PERCOLATOR_PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");

const MATCHER_CTX_SIZE = 320;
const LP_COLLATERAL = 500_000_000n; // 0.5 SOL

// ---------------------------------------------------------------------------
const matcherProgramStr = process.env.MATCHER_PROGRAM;
if (!matcherProgramStr) {
  console.error("ERROR: Set MATCHER_PROGRAM env var to the verified matcher program ID");
  process.exit(1);
}
const MATCHER_PROGRAM_ID = new PublicKey(matcherProgramStr);

const conn = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed"
);
const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
);

function writeBigU128(buf: Buffer, offset: number, val: bigint) {
  for (let i = 0; i < 16; i++) {
    buf[offset + i] = Number((val >> BigInt(i * 8)) & 0xFFn);
  }
}

async function main() {
  console.log("=== WIRE VERIFIED CREDIBILITY MATCHER ===\n");

  const balance = await conn.getBalance(payer.publicKey);
  console.log(`Wallet:  ${payer.publicKey.toBase58()}`);
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`Slab:    ${SLAB_PUBKEY.toBase58()}`);
  console.log(`Matcher: ${MATCHER_PROGRAM_ID.toBase58()}\n`);

  // Verify matcher program exists and check authority
  const programInfo = await conn.getAccountInfo(MATCHER_PROGRAM_ID);
  if (!programInfo) {
    console.error("ERROR: Matcher program not found on-chain");
    process.exit(1);
  }
  console.log("Matcher program found on-chain\n");

  // Read slab to find next LP index
  const slabInfo = await conn.getAccountInfo(SLAB_PUBKEY);
  if (!slabInfo) {
    console.error("ERROR: Slab not found");
    process.exit(1);
  }
  const usedIndices = parseUsedIndices(slabInfo.data);
  const lpIndex = usedIndices.length;
  console.log(`Existing accounts: ${usedIndices.length}, new LP at index ${lpIndex}\n`);

  // Get wSOL ATA
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  const ataBalance = Number(adminAta.amount);
  console.log(`wSOL ATA balance: ${ataBalance / LAMPORTS_PER_SOL} SOL`);

  // Wrap more SOL if needed
  const needed = Number(LP_COLLATERAL) + 10_000_000;
  if (ataBalance < needed) {
    const wrapAmount = needed - ataBalance + 100_000_000;
    console.log(`Wrapping ${wrapAmount / LAMPORTS_PER_SOL} SOL...`);
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: adminAta.address, lamports: wrapAmount }),
      { programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: adminAta.address, isSigner: false, isWritable: true }], data: Buffer.from([17]) },
    );
    await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });
  }

  // ========================================================================
  // STEP 1: Create matcher context account
  // ========================================================================
  console.log("\n--- Step 1: Create Matcher Context ---\n");

  const matcherCtxKp = Keypair.generate();
  const matcherRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  const createCtxTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: matcherCtxKp.publicKey,
      lamports: matcherRent,
      space: MATCHER_CTX_SIZE,
      programId: MATCHER_PROGRAM_ID,
    }),
  );
  await sendAndConfirmTransaction(conn, createCtxTx, [payer, matcherCtxKp], { commitment: "confirmed" });
  console.log(`Matcher context: ${matcherCtxKp.publicKey.toBase58()}`);

  // ========================================================================
  // STEP 2: Initialize matcher context (Tag 2, 74 bytes)
  // ========================================================================
  console.log("\n--- Step 2: Init Matcher Context ---\n");

  const [lpPda] = deriveLpPda(PERCOLATOR_PROGRAM_ID, SLAB_PUBKEY, lpIndex);
  console.log(`LP PDA: ${lpPda.toBase58()}`);

  const initData = Buffer.alloc(74);
  let off = 0;
  initData.writeUInt8(2, off); off += 1;           // tag = 2
  initData.writeUInt8(2, off); off += 1;           // kind = 2 (Credibility)
  initData.writeUInt32LE(5, off); off += 4;        // base_fee_bps
  initData.writeUInt32LE(50, off); off += 4;       // min_spread_bps (0.50%)
  initData.writeUInt32LE(500, off); off += 4;      // max_spread_bps (5.00%)
  initData.writeUInt32LE(100, off); off += 4;      // imbalance_k_bps
  writeBigU128(initData, off, 1_000_000_000_000n); off += 16; // liquidity_e6
  writeBigU128(initData, off, 1_000_000_000_000n); off += 16; // max_fill
  writeBigU128(initData, off, 0n); off += 16;      // max_inventory (no limit)
  initData.writeUInt32LE(216000, off); off += 4;   // age_halflife_slots (~1 day)
  initData.writeUInt32LE(50, off); off += 4;       // insurance_weight_bps

  const initMatcherTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    { programId: MATCHER_PROGRAM_ID, keys: [
      { pubkey: lpPda, isSigner: false, isWritable: false },
      { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
    ], data: initData },
  );
  await sendAndConfirmTransaction(conn, initMatcherTx, [payer], { commitment: "confirmed" });
  console.log("Matcher context initialized");

  // ========================================================================
  // STEP 3: Create LP
  // ========================================================================
  console.log("\n--- Step 3: Init LP ---\n");

  const initLpTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PERCOLATOR_PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_INIT_LP, [
      payer.publicKey, SLAB_PUBKEY, adminAta.address, VAULT_PUBKEY, TOKEN_PROGRAM_ID,
    ]), data: encodeInitLP({
      matcherProgram: MATCHER_PROGRAM_ID,
      matcherContext: matcherCtxKp.publicKey,
      feePayment: "2000000",
    }) }),
  );
  await sendAndConfirmTransaction(conn, initLpTx, [payer], { commitment: "confirmed" });
  console.log(`LP ${lpIndex} created with verified credibility matcher`);

  // ========================================================================
  // STEP 4: Deposit collateral
  // ========================================================================
  console.log("\n--- Step 4: Fund LP ---\n");

  const depositTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PERCOLATOR_PROGRAM_ID, keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey, SLAB_PUBKEY, adminAta.address, VAULT_PUBKEY, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY,
    ]), data: encodeDepositCollateral({ userIdx: lpIndex, amount: LP_COLLATERAL.toString() }) }),
  );
  await sendAndConfirmTransaction(conn, depositTx, [payer], { commitment: "confirmed" });
  console.log(`LP funded: ${Number(LP_COLLATERAL) / 1e9} SOL`);

  // ========================================================================
  // STEP 5: Seed credibility snapshots
  // ========================================================================
  console.log("\n--- Step 5: Seed Credibility ---\n");

  const updateCredTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    { programId: MATCHER_PROGRAM_ID, keys: [
      { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: SLAB_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    ], data: Buffer.from([3]) },
  );
  await sendAndConfirmTransaction(conn, updateCredTx, [payer], { commitment: "confirmed" });
  console.log("Credibility snapshots seeded");

  // ========================================================================
  // Summary
  // ========================================================================
  console.log("\n=== DONE ===\n");
  console.log(`  Matcher Program: ${MATCHER_PROGRAM_ID.toBase58()}`);
  console.log(`  Context:         ${matcherCtxKp.publicKey.toBase58()}`);
  console.log(`  LP Index:        ${lpIndex}`);
  console.log(`  LP PDA:          ${lpPda.toBase58()}`);
  console.log("");
  console.log("NEXT STEPS:");
  console.log("  1. Verify: solana-verify verify-from-repo --url devnet --program-id " + MATCHER_PROGRAM_ID.toBase58() + " https://github.com/millw14/provenance --mount-path matcher/credibility");
  console.log("  2. Burn:   solana program set-upgrade-authority " + MATCHER_PROGRAM_ID.toBase58() + " --final --url devnet");

  const info = {
    matcherProgram: MATCHER_PROGRAM_ID.toBase58(),
    matcherContext: matcherCtxKp.publicKey.toBase58(),
    lpIndex,
    lpPda: lpPda.toBase58(),
    slab: SLAB_PUBKEY.toBase58(),
    verified: false,
    authorityBurned: false,
  };
  fs.writeFileSync("verified-matcher.json", JSON.stringify(info, null, 2));
  console.log("\nSaved to verified-matcher.json");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
