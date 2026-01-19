/**
 * Full stress test: Create positions in risk reduction mode and test bank run
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { encodeKeeperCrank, encodeTradeCpi, encodeDepositCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI, ACCOUNTS_DEPOSIT_COLLATERAL } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseAccount, parseUsedIndices, parseEngine, parseParams } from "../src/solana/slab.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const VAULT = new PublicKey(marketInfo.vault);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);
const LP_IDX = marketInfo.lp.index;

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

async function runCrank(): Promise<boolean> {
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
  try {
    await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: "confirmed" });
    return true;
  } catch {
    return false;
  }
}

async function runSweepCycle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      await runCrank();
      const data = await fetchSlab(conn, SLAB);
      const engine = parseEngine(data);
      const slot = await conn.getSlot();
      if (slot - Number(engine.lastSweepStartSlot) <= Number(engine.maxCrankStalenessSlots)) {
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
}

async function trade(userIdx: number, size: bigint): Promise<{ success: boolean; error?: string }> {
  const lpPda = deriveLpPda(SLAB, LP_IDX);
  const tradeData = encodeTradeCpi({
    lpIdx: LP_IDX,
    userIdx,
    size: size.toString(),
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
    await sendAndConfirmTransaction(conn, tradeTx, [payer], { commitment: "confirmed" });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message?.slice(0, 150) };
  }
}

async function main() {
  console.log("=== FULL STRESS TEST IN RISK REDUCTION MODE ===\n");

  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);

  // Check initial state
  let data = await fetchSlab(conn, SLAB);
  let engine = parseEngine(data);
  let params = parseParams(data);
  const indices = parseUsedIndices(data);

  console.log("Initial state:");
  console.log("  Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("  Threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("  Surplus:", (Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold)) / 1e9, "SOL");
  console.log("  Risk reduction mode:", engine.riskReductionOnly);
  console.log("  Vault:", Number(engine.vault) / 1e9, "SOL");

  // Find users
  const users: number[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";
    if (!isLP && acc.owner.equals(payer.publicKey)) {
      users.push(idx);
    }
  }

  console.log("\nUsers:", users);

  // LP has positive PnL - users should be SHORT to have negative PnL
  const lpAcc = parseAccount(data, LP_IDX);
  console.log(`\nLP state: ${lpAcc.positionSize > 0n ? "LONG" : "SHORT"} ${lpAcc.positionSize}, PnL: ${(Number(lpAcc.pnl)/1e9).toFixed(6)} SOL`);

  // In risk reduction mode, risk-increasing trades should be blocked
  // Risk-reducing trades should be allowed
  // The LP is SHORT with +PnL. Users going SHORT would:
  // - Increase user's risk (new position)
  // - Decrease LP's risk (reduce short)

  // Let's try different scenarios:
  console.log("\n=== TESTING TRADES IN RISK REDUCTION MODE ===\n");

  // Test 1: User tries to open LONG position (risk increasing)
  console.log("Test 1: User 6 tries to open LONG 100B (risk increasing for user)...");
  await runSweepCycle();
  let result = await trade(users[0], 100_000_000_000n);
  console.log("  Result:", result.success ? "SUCCESS" : "BLOCKED");
  if (!result.success) console.log("  Error:", result.error);

  // Test 2: User tries to open SHORT position (risk increasing for user, risk reducing for LP)
  console.log("\nTest 2: User 7 tries to open SHORT 100B...");
  await runSweepCycle();
  result = await trade(users[1], -100_000_000_000n);
  console.log("  Result:", result.success ? "SUCCESS" : "BLOCKED");
  if (!result.success) console.log("  Error:", result.error);

  // Check state after attempts
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);

  console.log("\nState after trade attempts:");
  console.log("  Risk reduction mode:", engine.riskReductionOnly);
  console.log("  Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("  Vault:", Number(engine.vault) / 1e9, "SOL");

  // Check if any positions were opened
  console.log("\nUser positions after attempts:");
  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    if (acc.positionSize !== 0n) {
      console.log(`  User ${userIdx}: ${acc.positionSize > 0n ? "LONG" : "SHORT"} ${acc.positionSize}`);
    }
  }

  // The LP has +0.46 SOL PnL from being short. If we can't open new user positions,
  // let's see what happens if we try to close the LP's positive PnL position.
  // Actually, we can't close LP positions directly - they can only trade via users.

  // Let's run more cranks and see if insurance depletes or ADL triggers
  console.log("\n=== RUNNING 20 CRANKS TO SEE SYSTEM BEHAVIOR ===\n");
  for (let i = 0; i < 20; i++) {
    await runCrank();
    if (i % 5 === 0) {
      data = await fetchSlab(conn, SLAB);
      engine = parseEngine(data);
      console.log(`Crank ${i}: insurance=${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL, ` +
                  `vault=${(Number(engine.vault)/1e9).toFixed(4)} SOL, ` +
                  `riskMode=${engine.riskReductionOnly}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Final state
  console.log("\n=== FINAL STATE ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);
  params = parseParams(data);

  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("Surplus:", (Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold)) / 1e9, "SOL");
  console.log("Risk reduction mode:", engine.riskReductionOnly);
  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Lifetime liquidations:", engine.lifetimeLiquidations);
  console.log("Lifetime force closes:", engine.lifetimeForceCloses);

  const finalLp = parseAccount(data, LP_IDX);
  console.log(`\nLP: ${finalLp.positionSize > 0n ? "LONG" : "SHORT"} ${finalLp.positionSize}, ` +
              `capital: ${(Number(finalLp.capital)/1e9).toFixed(2)} SOL, ` +
              `PnL: ${(Number(finalLp.pnl)/1e9).toFixed(6)} SOL`);
}

main().catch(console.error);
