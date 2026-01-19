/**
 * Monitor PnL and run cranks until we see divergence
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
  console.log("=== PNL MONITOR & BANK RUN ===\n");

  let data = await fetchSlab(conn, SLAB);
  let engine = parseEngine(data);
  let params = parseParams(data);
  const indices = parseUsedIndices(data);

  console.log("State:");
  console.log("  Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("  Threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");

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

  // Check positions
  console.log("\nCurrent positions:");
  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    if (acc.positionSize !== 0n) {
      const dir = acc.positionSize > 0n ? "LONG" : "SHORT";
      console.log(`  User ${userIdx}: ${dir} ${acc.positionSize}, entry: ${acc.entryPrice}, pnl: ${(Number(acc.pnl)/1e9).toFixed(6)} SOL`);
    }
  }

  const lpAcc = parseAccount(data, LP_IDX);
  console.log(`  LP: ${lpAcc.positionSize > 0n ? "LONG" : lpAcc.positionSize < 0n ? "SHORT" : "FLAT"} ${lpAcc.positionSize}, pnl: ${(Number(lpAcc.pnl)/1e9).toFixed(6)} SOL`);

  // Check if any users have positions, if not re-open them
  const usersWithPositions = users.filter(idx => {
    const acc = parseAccount(data, idx);
    return acc.positionSize !== 0n;
  });

  if (usersWithPositions.length === 0) {
    console.log("\nNo positions found! Opening new positions...");
    const MAX_SIZE = 500_000_000_000n;

    for (let i = 0; i < users.length; i++) {
      const userIdx = users[i];
      const direction = i % 2 === 0 ? 1n : -1n;
      const size = direction * MAX_SIZE;

      await runSweepCycle();
      const dirStr = direction > 0n ? "LONG" : "SHORT";
      console.log(`Opening ${dirStr} for user ${userIdx}...`);
      const result = await trade(userIdx, size);
      console.log(`  ${result.success ? "SUCCESS" : "FAILED"}`);
      await new Promise(r => setTimeout(r, 500));
    }

    // Refresh data
    data = await fetchSlab(conn, SLAB);
    console.log("\nNew positions:");
    for (const userIdx of users) {
      const acc = parseAccount(data, userIdx);
      if (acc.positionSize !== 0n) {
        const dir = acc.positionSize > 0n ? "LONG" : "SHORT";
        console.log(`  User ${userIdx}: ${dir} ${acc.positionSize}, entry: ${acc.entryPrice}`);
      }
    }
  }

  // Run cranks and monitor PnL
  console.log("\n=== RUNNING CRANKS TO MONITOR PNL ===\n");

  const TARGET_PNL = 0.05; // Stop when any user has > 0.05 SOL PnL
  const MAX_BATCHES = 100;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    // Run cranks
    for (let i = 0; i < 5; i++) {
      await runCrank();
      await new Promise(r => setTimeout(r, 200));
    }

    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);

    // Check all PnLs
    interface PnLInfo { idx: number; pnl: number; position: bigint; entry: number }
    const pnls: PnLInfo[] = [];

    for (const userIdx of users) {
      const acc = parseAccount(data, userIdx);
      if (acc.positionSize !== 0n) {
        pnls.push({
          idx: userIdx,
          pnl: Number(acc.pnl) / 1e9,
          position: acc.positionSize,
          entry: Number(acc.entryPrice || 0),
        });
      }
    }

    const lpPnL = Number(parseAccount(data, LP_IDX).pnl) / 1e9;

    // Log every 5 batches
    if (batch % 5 === 0 || pnls.some(p => Math.abs(p.pnl) > TARGET_PNL)) {
      console.log(`Batch ${batch}:`);
      for (const p of pnls) {
        const sign = p.pnl >= 0 ? "+" : "";
        console.log(`  User ${p.idx}: ${sign}${p.pnl.toFixed(6)} SOL (entry: ${p.entry})`);
      }
      console.log(`  LP: ${lpPnL >= 0 ? "+" : ""}${lpPnL.toFixed(6)} SOL`);
      console.log(`  Insurance: ${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);
    }

    // Check if any user has significant PnL
    if (pnls.some(p => Math.abs(p.pnl) > TARGET_PNL)) {
      console.log("\n!!! SIGNIFICANT USER PNL DETECTED !!!\n");
      break;
    }
  }

  // === BANK RUN ===
  console.log("\n=== EXECUTING BANK RUN (positive PnL first) ===\n");

  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);

  interface UserState { idx: number; position: bigint; pnl: bigint; capital: bigint }
  const userStates: UserState[] = [];

  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    if (acc.positionSize !== 0n) {
      userStates.push({
        idx: userIdx,
        position: acc.positionSize,
        pnl: acc.pnl,
        capital: acc.capital,
      });
    }
  }

  // Sort by PnL descending
  userStates.sort((a, b) => {
    if (a.pnl > b.pnl) return -1;
    if (a.pnl < b.pnl) return 1;
    return 0;
  });

  console.log("Closing order:");
  for (const u of userStates) {
    const sign = u.pnl >= 0n ? "+" : "";
    console.log(`  User ${u.idx}: ${sign}${(Number(u.pnl)/1e9).toFixed(6)} SOL`);
  }

  // Close positions
  for (const u of userStates) {
    const sign = u.pnl >= 0n ? "+" : "";
    console.log(`\nClosing user ${u.idx} (PnL: ${sign}${(Number(u.pnl)/1e9).toFixed(6)} SOL)...`);

    await runSweepCycle();
    const result = await trade(u.idx, -u.position);

    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    const acc = parseAccount(data, u.idx);

    console.log(`  Result: ${result.success ? "CLOSED" : "FAILED"}`);
    console.log(`  New capital: ${(Number(acc.capital)/1e9).toFixed(4)} SOL`);
    console.log(`  Insurance: ${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);
    console.log(`  Risk reduction: ${engine.riskReductionOnly}`);

    if (engine.riskReductionOnly) {
      console.log("\n!!! RISK REDUCTION MODE TRIGGERED !!!");
    }

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
  console.log("Risk reduction:", engine.riskReductionOnly);
  console.log("Liquidations:", engine.lifetimeLiquidations);
  console.log("Force closes:", engine.lifetimeForceCloses);
}

main().catch(console.error);
