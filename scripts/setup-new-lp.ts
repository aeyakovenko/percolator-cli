import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, ComputeBudgetProgram, SystemProgram, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";
import { encodeInitLP, encodeDepositCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_INIT_LP, ACCOUNTS_DEPOSIT_COLLATERAL } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseUsedIndices, parseAccount } from "../src/solana/slab.js";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX_SIZE = 320;
const DEPOSIT_AMOUNT = 50_000_000_000n; // 50 SOL

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

function deriveLpPda(slabPubkey: PublicKey, lpIndex: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), slabPubkey.toBuffer(), Buffer.from([lpIndex & 0xff, (lpIndex >> 8) & 0xff])],
    PROGRAM_ID
  );
}

async function main() {
  console.log("=== Setup New LP with Correct Matcher Context ===\n");

  // Step 1: Find the next LP index
  const slabData = await fetchSlab(conn, SLAB);
  const usedBefore = parseUsedIndices(slabData);
  console.log("Used indices before:", usedBefore);

  // Find first unused index
  let predictedIndex = 0;
  while (usedBefore.includes(predictedIndex)) {
    predictedIndex++;
  }
  console.log("Predicted new LP index:", predictedIndex);

  // Step 2: Derive LP PDA for predicted index
  const [lpPda, bump] = deriveLpPda(SLAB, predictedIndex);
  console.log("LP PDA:", lpPda.toBase58());

  // Step 3: Create matcher context account
  const matcherCtxKp = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  console.log("\nCreating matcher context:", matcherCtxKp.publicKey.toBase58());

  const createTx = new Transaction();
  createTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  createTx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: matcherCtxKp.publicKey,
    lamports: rent,
    space: MATCHER_CTX_SIZE,
    programId: MATCHER_PROGRAM,
  }));

  await sendAndConfirmTransaction(conn, createTx, [payer, matcherCtxKp], { commitment: "confirmed" });
  console.log("Created matcher context account");

  // Step 4: Initialize matcher context with LP PDA
  const initMatcherTx = new Transaction();
  initMatcherTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  initMatcherTx.add({
    programId: MATCHER_PROGRAM,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: lpPda, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });

  await sendAndConfirmTransaction(conn, initMatcherTx, [payer], { commitment: "confirmed" });
  console.log("Initialized matcher context");

  // Step 5: Get wSOL ATA
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);

  // Step 6: Init LP
  console.log("\nInitializing LP...");
  const initLpData = encodeInitLP({
    matcherProgram: MATCHER_PROGRAM,
    matcherContext: matcherCtxKp.publicKey,
    feePayment: "2000000",
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

  await sendAndConfirmTransaction(conn, initLpTx, [payer], { commitment: "confirmed" });
  console.log("LP initialized");

  // Step 7: Find the actual allocated index
  const slabDataAfter = await fetchSlab(conn, SLAB);
  const usedAfter = parseUsedIndices(slabDataAfter);
  console.log("Used indices after:", usedAfter);

  const newIndex = usedAfter.find(i => !usedBefore.includes(i));
  if (newIndex === undefined) {
    console.log("ERROR: Could not find new LP index!");
    return;
  }
  console.log("Actual LP index:", newIndex);

  if (newIndex !== predictedIndex) {
    console.log("WARNING: Index mismatch! Predicted", predictedIndex, "but got", newIndex);
    console.log("The matcher context may not work correctly.");
  }

  // Step 8: Deposit collateral
  console.log("\nDepositing", Number(DEPOSIT_AMOUNT) / 1e9, "SOL to LP at index", newIndex);

  const depositData = encodeDepositCollateral({
    userIdx: newIndex,
    amount: DEPOSIT_AMOUNT.toString(),
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

  await sendAndConfirmTransaction(conn, depositTx, [payer], { commitment: "confirmed" });
  console.log("Deposited!");

  console.log("\n=== New LP Setup Complete ===");
  console.log("LP Index:", newIndex);
  console.log("LP PDA:", lpPda.toBase58());
  console.log("Matcher Context:", matcherCtxKp.publicKey.toBase58());
  console.log("\nUpdate mass-exit.ts with:");
  console.log("  LP_IDX =", newIndex);
  console.log("  MATCHER_CTX =", matcherCtxKp.publicKey.toBase58());
}

main().catch(console.error);
