import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { encodeTradeCpi, encodeKeeperCrank, encodeDepositCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_TRADE_CPI, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_DEPOSIT_COLLATERAL } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseAccount, parseEngine } from "../src/solana/slab.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const ORACLE = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const MATCHER_CTX = new PublicKey("AY7GbUGzEsdQfiPqHuu8H8KAghvxow5KLWHMfHWxqtLM");
const VAULT = new PublicKey("AJoTRUUwAb8nB2pwqKhNSKxvbE3GdHHiM9VxpoaBLhVj");
const LP_IDX = 0;
const USER_IDX = 6;

function deriveLpPda(slabPubkey: PublicKey, lpIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), slabPubkey.toBuffer(), Buffer.from([lpIndex & 0xff, (lpIndex >> 8) & 0xff])],
    PROGRAM_ID
  );
  return pda;
}

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
  console.log("=== Test Trade on OLD Slab ===\n");

  // Get user ATA
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);

  // First deposit more capital to user 6 (1 SOL)
  console.log("Depositing 1 SOL to user 6...");
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
    console.log("Deposit successful:", depSig.slice(0, 20) + "...\n");
  } catch (err) {
    console.log("Deposit failed:", (err as any).message?.slice(0, 100));
    console.log("Continuing with existing capital...\n");
  }

  // Run cranks
  console.log("Running cranks...");
  for (let i = 0; i < 5; i++) {
    try {
      await runCrank();
      console.log("Crank " + (i + 1) + " done");
    } catch {
      // ignore
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // Check current state
  let data = await fetchSlab(conn, SLAB);
  let engine = parseEngine(data);
  let userAcc = parseAccount(data, USER_IDX);
  let lpAcc = parseAccount(data, LP_IDX);

  console.log("\nBefore trade:");
  console.log("  Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("  User 6 capital:", Number(userAcc.capital) / 1e9, "SOL");
  console.log("  User 6 position:", userAcc.positionSize.toString());
  console.log("  LP 0 position:", lpAcc.positionSize.toString());
  console.log("  LP 0 capital:", Number(lpAcc.capital) / 1e9, "SOL");

  // Execute a smaller trade (100M units instead of 1B)
  const tradeSize = 100_000_000n; // 100M units LONG - more conservative
  console.log("\nExecuting trade: user " + USER_IDX + " going LONG " + tradeSize + " via LP " + LP_IDX + "...");

  const lpPda = deriveLpPda(SLAB, LP_IDX);
  console.log("LP PDA:", lpPda.toBase58());

  const tradeData = encodeTradeCpi({
    lpIdx: LP_IDX,
    userIdx: USER_IDX,
    size: tradeSize.toString(),
  });

  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey,
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
    MATCHER_PROGRAM,
    MATCHER_CTX,
    lpPda,
  ]);

  const tradeTx = new Transaction();
  tradeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
  tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));

  try {
    const sig = await sendAndConfirmTransaction(conn, tradeTx, [payer], { commitment: "confirmed" });
    console.log("Trade successful:", sig.slice(0, 20) + "...");

    // Check after trade
    data = await fetchSlab(conn, SLAB);
    userAcc = parseAccount(data, USER_IDX);
    lpAcc = parseAccount(data, LP_IDX);

    console.log("\nAfter trade:");
    console.log("  User 6 capital:", Number(userAcc.capital) / 1e9, "SOL");
    console.log("  User 6 position:", userAcc.positionSize.toString());
    console.log("  User 6 pnl:", Number(userAcc.pnl) / 1e9, "SOL");
    console.log("  LP 0 position:", lpAcc.positionSize.toString());
  } catch (err) {
    console.log("Trade failed:", (err as any).message?.slice(0, 200));
    if ((err as any).logs) {
      console.log("Logs:", (err as any).logs.slice(-5).join("\n      "));
    }
  }
}

main();
