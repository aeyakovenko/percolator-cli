import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeInitUser, encodeDepositCollateral, encodeKeeperCrank, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);
const LP_PDA = new PublicKey(marketInfo.lp.pda);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function delay(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("=== Setting up trading market ===\n");

  // Step 1: Run keeper crank
  console.log("Step 1: Running keeper crank...");
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const crankTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData })
  );
  try {
    await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: "confirmed" });
    console.log("  Crank successful");
  } catch (e: any) {
    console.log("  Crank:", e.message?.slice(0, 50));
  }
  await delay(2000);

  // Step 2: Check if user exists, if not create one
  console.log("\nStep 2: Checking for user account...");
  let data = await fetchSlab(conn, SLAB);
  let userIdx = -1;
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc && acc.kind === AccountKind.User) {
      userIdx = idx;
      console.log("  Found user at index", idx);
      break;
    }
  }

  if (userIdx < 0) {
    console.log("  No user found, creating one...");
    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
    const initData = encodeInitUser({ feePayment: 1000000n });
    const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID,
    ]);
    const initTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
      buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData })
    );
    await sendAndConfirmTransaction(conn, initTx, [payer], { commitment: "confirmed" });
    console.log("  User created");
    await delay(2000);

    // Find the new user index
    data = await fetchSlab(conn, SLAB);
    for (const idx of parseUsedIndices(data)) {
      const acc = parseAccount(data, idx);
      if (acc && acc.kind === AccountKind.User) {
        userIdx = idx;
        break;
      }
    }
    console.log("  User index:", userIdx);
  }

  // Step 3: Deposit collateral if needed
  console.log("\nStep 3: Checking user collateral...");
  data = await fetchSlab(conn, SLAB);
  const userAcc = parseAccount(data, userIdx);
  console.log("  Current capital:", (Number(userAcc.capital) / 1e9).toFixed(6), "SOL");

  if (userAcc.capital < 100_000_000n) {
    console.log("  Depositing 0.5 SOL...");
    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
    const depositData = encodeDepositCollateral({ userIdx, amount: 500_000_000n });
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey, SLAB, userAta.address, VAULT, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY,
    ]);
    const depositTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
      buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData })
    );
    await sendAndConfirmTransaction(conn, depositTx, [payer], { commitment: "confirmed" });
    console.log("  Deposited");
    await delay(2000);
  }

  // Step 4: Run crank again before trading
  console.log("\nStep 4: Running crank before trade...");
  try {
    await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: "confirmed" });
    console.log("  Crank successful");
  } catch (e: any) {
    console.log("  Crank:", e.message?.slice(0, 50));
  }
  await delay(2000);

  // Step 5: Execute a test trade
  console.log("\nStep 5: Executing test trade (LONG 100000 units)...");
  const tradeData = encodeTradeCpi({ userIdx, lpIdx: 0, size: 100000n });
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
    MATCHER_PROGRAM, MATCHER_CTX, LP_PDA,
  ]);
  const tradeTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
    buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData })
  );
  try {
    await sendAndConfirmTransaction(conn, tradeTx, [payer], { commitment: "confirmed" });
    console.log("  Trade successful!");
  } catch (e: any) {
    console.log("  Trade failed:", e.message?.slice(0, 100));
  }
  await delay(2000);

  // Final state
  console.log("\n=== Final Market State ===");
  data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const vaultInfo = await conn.getAccountInfo(VAULT);

  console.log("Vault:", (vaultInfo?.lamports || 0) / 1e9, "SOL");
  console.log("Insurance:", (Number(engine.insuranceFund.balance) / 1e9).toFixed(6), "SOL");
  console.log("Last Crank Slot:", Number(engine.lastCrankSlot));
  console.log("\nAccounts:");
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
      console.log("  [" + idx + "] " + kind + ": capital=" + (Number(acc.capital) / 1e9).toFixed(6) + " pos=" + acc.positionSize);
    }
  }
}

main().catch(console.error);
