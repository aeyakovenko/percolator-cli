/**
 * Selective exit strategy:
 * 1. Open half LONG, half SHORT positions
 * 2. Wait for price movement to create winners/losers
 * 3. Only exit profitable positions when PnL > insurance surplus
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

async function trade(userIdx: number, size: bigint): Promise<boolean> {
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
    return true;
  } catch {
    return false;
  }
}

// Calculate unrealized PnL based on position and entry vs current price
function calcUnrealizedPnL(position: bigint, entryPrice: bigint, currentPrice: number): number {
  // PnL = position * (current - entry) / 1e6
  const pnl = Number(position) * (currentPrice - Number(entryPrice)) / 1e6;
  return pnl / 1e9; // Convert to SOL
}

async function main() {
  console.log("=== SELECTIVE EXIT STRATEGY ===\n");
  console.log("Goal: Wait for profitable positions, exit only winners when PnL > insurance surplus\n");

  let data = await fetchSlab(conn, SLAB);
  let engine = parseEngine(data);
  let params = parseParams(data);
  const indices = parseUsedIndices(data);

  const insurance = Number(engine.insuranceFund.balance) / 1e9;
  const threshold = Number(params.riskReductionThreshold) / 1e9;
  const surplus = insurance - threshold;

  console.log("Initial state:");
  console.log(`  Insurance: ${insurance.toFixed(4)} SOL`);
  console.log(`  Threshold: ${threshold.toFixed(4)} SOL`);
  console.log(`  Surplus: ${surplus.toFixed(4)} SOL`);
  console.log(`  Target: Wait for winner PnL > ${surplus.toFixed(2)} SOL\n`);

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

  // Phase 1: Open positions - half LONG, half SHORT
  console.log("=== PHASE 1: OPENING POSITIONS ===\n");

  const MAX_SIZE = 500_000_000_000n; // 500B units
  const longs: number[] = [];
  const shorts: number[] = [];

  for (let i = 0; i < users.length; i++) {
    const userIdx = users[i];
    data = await fetchSlab(conn, SLAB);
    const acc = parseAccount(data, userIdx);

    // Skip if already has position
    if (acc.positionSize !== 0n) {
      if (acc.positionSize > 0n) longs.push(userIdx);
      else shorts.push(userIdx);
      console.log(`User ${userIdx}: already has ${acc.positionSize > 0n ? "LONG" : "SHORT"} position`);
      continue;
    }

    // Alternate: first half LONG, second half SHORT
    const isLong = i < users.length / 2;
    const size = isLong ? MAX_SIZE : -MAX_SIZE;

    await runSweepCycle();
    const success = await trade(userIdx, size);

    if (success) {
      if (isLong) longs.push(userIdx);
      else shorts.push(userIdx);

      data = await fetchSlab(conn, SLAB);
      const newAcc = parseAccount(data, userIdx);
      console.log(`User ${userIdx}: Opened ${isLong ? "LONG" : "SHORT"} at entry ${newAcc.entryPrice}`);
    } else {
      console.log(`User ${userIdx}: Failed to open position`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nLONGs: ${longs.join(", ")}`);
  console.log(`SHORTs: ${shorts.join(", ")}`);

  // Get entry prices
  data = await fetchSlab(conn, SLAB);
  const positions: Map<number, { position: bigint; entry: bigint; capital: bigint }> = new Map();

  for (const userIdx of [...longs, ...shorts]) {
    const acc = parseAccount(data, userIdx);
    positions.set(userIdx, {
      position: acc.positionSize,
      entry: acc.entryPrice || 0n,
      capital: acc.capital,
    });
  }

  // Phase 2: Monitor and wait for price movement
  console.log("\n=== PHASE 2: WAITING FOR PRICE MOVEMENT ===\n");
  console.log("Running cranks and monitoring unrealized PnL...\n");

  let iteration = 0;
  const MAX_ITERATIONS = 1000; // Safety limit

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    // Run some cranks
    for (let i = 0; i < 5; i++) {
      await runCrank();
      await new Promise(r => setTimeout(r, 200));
    }

    // Check current state
    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    params = parseParams(data);

    // Get current oracle price estimate from LP entry (approximation)
    const lpAcc = parseAccount(data, LP_IDX);
    // Use a rough estimate - check the last entry prices
    let estimatedPrice = 6950; // Default estimate

    // Calculate unrealized PnL for each position
    let totalLongPnL = 0;
    let totalShortPnL = 0;
    const pnlDetails: { idx: number; pnl: number; isLong: boolean }[] = [];

    for (const userIdx of longs) {
      const pos = positions.get(userIdx);
      if (pos && pos.position !== 0n) {
        // For LONGs: profit if price > entry
        // We need to estimate current price from recent trades
        const acc = parseAccount(data, userIdx);
        // Use capital change as proxy for realized PnL during position
        const unrealizedPnL = Number(acc.pnl) / 1e9;
        totalLongPnL += unrealizedPnL;
        pnlDetails.push({ idx: userIdx, pnl: unrealizedPnL, isLong: true });
      }
    }

    for (const userIdx of shorts) {
      const pos = positions.get(userIdx);
      if (pos && pos.position !== 0n) {
        const acc = parseAccount(data, userIdx);
        const unrealizedPnL = Number(acc.pnl) / 1e9;
        totalShortPnL += unrealizedPnL;
        pnlDetails.push({ idx: userIdx, pnl: unrealizedPnL, isLong: false });
      }
    }

    const currentSurplus = (Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold)) / 1e9;

    // Log progress every 10 iterations
    if (iteration % 10 === 1) {
      console.log(`Iteration ${iteration}:`);
      console.log(`  Long PnL: ${totalLongPnL.toFixed(6)} SOL`);
      console.log(`  Short PnL: ${totalShortPnL.toFixed(6)} SOL`);
      console.log(`  Insurance surplus: ${currentSurplus.toFixed(4)} SOL`);
      console.log(`  LP PnL: ${(Number(lpAcc.pnl)/1e9).toFixed(4)} SOL`);

      // Show individual positions
      for (const d of pnlDetails) {
        if (d.pnl !== 0) {
          console.log(`    User ${d.idx} (${d.isLong ? "LONG" : "SHORT"}): ${d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(6)} SOL`);
        }
      }
    }

    // Check if either side has significant profit
    const winnerPnL = Math.max(totalLongPnL, totalShortPnL);
    const winnerSide = totalLongPnL > totalShortPnL ? "LONG" : "SHORT";

    if (winnerPnL > currentSurplus * 0.5) { // Exit when winners have > 50% of surplus
      console.log(`\n!!! ${winnerSide}s are profitable: ${winnerPnL.toFixed(4)} SOL !!!`);
      console.log(`Insurance surplus: ${currentSurplus.toFixed(4)} SOL`);
      console.log(`Proceeding to selective exit...\n`);
      break;
    }

    // Check for risk reduction
    if (engine.riskReductionOnly) {
      console.log("\n!!! RISK REDUCTION MODE - stopping !!!");
      break;
    }
  }

  // Phase 3: Selective exit - only close profitable positions
  console.log("\n=== PHASE 3: SELECTIVE EXIT (WINNERS ONLY) ===\n");

  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);

  // Determine which side won
  let totalLongPnL = 0;
  let totalShortPnL = 0;

  for (const userIdx of longs) {
    const acc = parseAccount(data, userIdx);
    totalLongPnL += Number(acc.pnl) / 1e9;
  }
  for (const userIdx of shorts) {
    const acc = parseAccount(data, userIdx);
    totalShortPnL += Number(acc.pnl) / 1e9;
  }

  const winners = totalLongPnL > totalShortPnL ? longs : shorts;
  const losers = totalLongPnL > totalShortPnL ? shorts : longs;
  const winnerSide = totalLongPnL > totalShortPnL ? "LONG" : "SHORT";
  const winnerPnL = Math.max(totalLongPnL, totalShortPnL);

  console.log(`Winners: ${winnerSide}s with total PnL: ${winnerPnL.toFixed(6)} SOL`);
  console.log(`Losers: ${winnerSide === "LONG" ? "SHORT" : "LONG"}s (keeping open)\n`);

  const preInsurance = Number(engine.insuranceFund.balance) / 1e9;
  console.log(`Pre-exit insurance: ${preInsurance.toFixed(4)} SOL`);

  // Close only winning positions
  for (const userIdx of winners) {
    const acc = parseAccount(data, userIdx);
    if (acc.positionSize === 0n) continue;

    console.log(`\nClosing winner User ${userIdx} (${winnerSide})...`);
    console.log(`  Pre-close capital: ${(Number(acc.capital)/1e9).toFixed(4)} SOL`);

    await runSweepCycle();
    const success = await trade(userIdx, -acc.positionSize);

    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    const newAcc = parseAccount(data, userIdx);

    const capitalChange = (Number(newAcc.capital) - Number(acc.capital)) / 1e9;
    console.log(`  Result: ${success ? "CLOSED" : "FAILED"}`);
    console.log(`  Capital change: ${capitalChange >= 0 ? "+" : ""}${capitalChange.toFixed(6)} SOL`);
    console.log(`  Insurance: ${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);
    console.log(`  Risk reduction: ${engine.riskReductionOnly}`);

    await new Promise(r => setTimeout(r, 300));
  }

  // Final state
  console.log("\n=== FINAL STATE ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);
  params = parseParams(data);

  const postInsurance = Number(engine.insuranceFund.balance) / 1e9;
  const insuranceChange = postInsurance - preInsurance;

  console.log(`Insurance: ${postInsurance.toFixed(4)} SOL (${insuranceChange >= 0 ? "+" : ""}${insuranceChange.toFixed(4)})`);
  console.log(`Threshold: ${(Number(params.riskReductionThreshold)/1e9).toFixed(4)} SOL`);
  console.log(`Surplus: ${((Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold))/1e9).toFixed(4)} SOL`);
  console.log(`Risk reduction: ${engine.riskReductionOnly}`);

  console.log("\nRemaining positions (losers):");
  for (const userIdx of losers) {
    const acc = parseAccount(data, userIdx);
    if (acc.positionSize !== 0n) {
      console.log(`  User ${userIdx}: ${acc.positionSize > 0n ? "LONG" : "SHORT"} ${acc.positionSize}`);
    }
  }
}

main().catch(console.error);
