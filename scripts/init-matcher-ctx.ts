import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram
} from "@solana/web3.js";
import fs from "fs";

const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const MATCHER_PROGRAM = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const MATCHER_CTX_SIZE = 320;
const LP_INDEX = 8;

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
  console.log("=== Initialize Matcher Context ===\n");

  // Derive LP PDA
  const [lpPda, bump] = deriveLpPda(SLAB, LP_INDEX);
  console.log("LP PDA:", lpPda.toBase58());
  console.log("LP PDA bump:", bump);

  // Create matcher context account
  const matcherCtxKp = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  console.log("\nCreating matcher context:", matcherCtxKp.publicKey.toBase58());
  console.log("Rent:", rent / 1e9, "SOL");

  // Step 1: Create the account owned by matcher program
  const createTx = new Transaction();
  createTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  createTx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: matcherCtxKp.publicKey,
    lamports: rent,
    space: MATCHER_CTX_SIZE,
    programId: MATCHER_PROGRAM,
  }));

  try {
    const sig1 = await sendAndConfirmTransaction(conn, createTx, [payer, matcherCtxKp], { commitment: "confirmed" });
    console.log("Created account:", sig1.slice(0, 20) + "...");
  } catch (err: any) {
    console.log("Failed to create:", err.message?.slice(0, 200));
    return;
  }

  // Step 2: Initialize matcher context with LP PDA
  const initTx = new Transaction();
  initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  initTx.add({
    programId: MATCHER_PROGRAM,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },  // owner
      { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },  // matcher_ctx
      { pubkey: lpPda, isSigner: false, isWritable: false },  // lp_pda
    ],
    data: Buffer.from([1]),  // Init instruction (0x01)
  });

  try {
    const sig2 = await sendAndConfirmTransaction(conn, initTx, [payer], { commitment: "confirmed" });
    console.log("Initialized:", sig2.slice(0, 20) + "...");
  } catch (err: any) {
    console.log("Failed to initialize:", err.message?.slice(0, 200));
    if (err.logs) {
      console.log("Logs:", err.logs.slice(-5).join("\n      "));
    }
    return;
  }

  console.log("\n=== Update devnet-market.json ===");
  console.log("New matcher context:", matcherCtxKp.publicKey.toBase58());
  console.log("LP PDA:", lpPda.toBase58());
}

main().catch(console.error);
