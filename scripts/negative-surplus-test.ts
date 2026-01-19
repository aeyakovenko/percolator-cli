/**
 * Test trading and liquidation behavior with negative insurance surplus
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { encodeKeeperCrank, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseAccount, parseUsedIndices, parseEngine, parseParams } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey(marketInfo.programId);
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
  } catch (err: any) {
    console.log("Crank error:", err.message?.slice(0, 100));
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
  console.log("=== NEGATIVE SURPLUS STRESS TEST ===\n");

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

  // Find users with positions
  const users: { idx: number; position: bigint; capital: bigint; pnl: bigint }[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";
    if (!isLP && acc.owner.equals(payer.publicKey)) {
      users.push({ idx, position: acc.positionSize, capital: acc.capital, pnl: acc.pnl });
    }
  }

  console.log("\nUsers:");
  for (const u of users) {
    const dir = u.position > 0n ? "LONG" : u.position < 0n ? "SHORT" : "FLAT";
    console.log(`  User ${u.idx}: ${dir} ${u.position}, capital: ${(Number(u.capital)/1e9).toFixed(2)} SOL, pnl: ${(Number(u.pnl)/1e9).toFixed(6)} SOL`);
  }

  const lpAcc = parseAccount(data, LP_IDX);
  console.log(`  LP ${LP_IDX}: ${lpAcc.positionSize > 0n ? "LONG" : "SHORT"} ${lpAcc.positionSize}, pnl: ${(Number(lpAcc.pnl)/1e9).toFixed(6)} SOL`);

  // Run cranks to see if risk reduction mode activates
  console.log("\n=== RUNNING CRANKS ===\n");
  for (let i = 0; i < 10; i++) {
    await runCrank();
    await new Promise(r => setTimeout(r, 300));
  }

  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);
  console.log("After cranks:");
  console.log("  Risk reduction mode:", engine.riskReductionOnly);
  console.log("  Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");

  // Try to close positions - starting with users that have positions
  console.log("\n=== ATTEMPTING TO CLOSE POSITIONS ===\n");

  for (const u of users) {
    if (u.position === 0n) continue;

    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);

    console.log(`Attempting to close user ${u.idx} position (${u.position})...`);
    console.log(`  Pre-trade vault: ${(Number(engine.vault)/1e9).toFixed(4)} SOL`);
    console.log(`  Pre-trade insurance: ${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);
    console.log(`  Risk reduction: ${engine.riskReductionOnly}`);

    await runSweepCycle();
    const result = await trade(u.idx, -u.position);

    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    const acc = parseAccount(data, u.idx);

    console.log(`  Result: ${result.success ? "SUCCESS" : "FAILED"}`);
    if (!result.success) {
      console.log(`  Error: ${result.error}`);
    }
    console.log(`  New position: ${acc.positionSize}`);
    console.log(`  New capital: ${(Number(acc.capital)/1e9).toFixed(4)} SOL`);
    console.log(`  Post-trade vault: ${(Number(engine.vault)/1e9).toFixed(4)} SOL`);
    console.log(`  Post-trade insurance: ${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);
    console.log(`  Risk reduction: ${engine.riskReductionOnly}`);
    console.log("");

    await new Promise(r => setTimeout(r, 500));
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

  // Check remaining positions
  console.log("\nRemaining positions:");
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc.positionSize !== 0n) {
      const matcher = acc.matcherProgram?.toBase58() || "null";
      const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";
      const type = isLP ? "LP" : "USER";
      console.log(`  ${type} ${idx}: ${acc.positionSize > 0n ? "LONG" : "SHORT"} ${acc.positionSize}`);
    }
  }
}

main().catch(console.error);
