/**
 * Continuous max-risk trading with periodic bank runs
 * Goal: Keep traders at max leverage, accumulate PnL, attempt bank runs
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

async function getUsers(data: Buffer): Promise<number[]> {
  const indices = parseUsedIndices(data);
  const users: number[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";
    if (!isLP && acc.owner.equals(payer.publicKey)) {
      users.push(idx);
    }
  }
  return users;
}

async function openMaxPositions(users: number[], data: Buffer): Promise<void> {
  const MAX_SIZE = 500_000_000_000n; // 500B units

  for (let i = 0; i < users.length; i++) {
    const userIdx = users[i];
    const acc = parseAccount(data, userIdx);

    // Skip if already has position
    if (acc.positionSize !== 0n) continue;

    // Alternate LONG/SHORT
    const direction = i % 2 === 0 ? 1n : -1n;
    const size = direction * MAX_SIZE;

    await runSweepCycle();
    const success = await trade(userIdx, size);
    if (success) {
      console.log(`  Opened ${direction > 0n ? "LONG" : "SHORT"} for user ${userIdx}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

async function attemptBankRun(users: number[], data: Buffer): Promise<{ closed: number; insuranceChange: number }> {
  const engine = parseEngine(data);
  const startInsurance = Number(engine.insuranceFund.balance);

  // Get users with positions and their capital changes
  interface UserPos { idx: number; position: bigint; capital: bigint }
  const positions: UserPos[] = [];

  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    if (acc.positionSize !== 0n) {
      positions.push({ idx: userIdx, position: acc.positionSize, capital: acc.capital });
    }
  }

  if (positions.length === 0) return { closed: 0, insuranceChange: 0 };

  // Close all positions
  let closed = 0;
  for (const p of positions) {
    await runSweepCycle();
    const success = await trade(p.idx, -p.position);
    if (success) closed++;
    await new Promise(r => setTimeout(r, 200));
  }

  // Check insurance change
  const newData = await fetchSlab(conn, SLAB);
  const newEngine = parseEngine(newData);
  const endInsurance = Number(newEngine.insuranceFund.balance);

  return { closed, insuranceChange: (endInsurance - startInsurance) / 1e9 };
}

async function main() {
  console.log("=== CONTINUOUS STRESS TEST ===\n");
  console.log("Running continuous max-risk trading with periodic bank runs...\n");

  let cycle = 0;
  let totalBankRuns = 0;
  let maxInsuranceDrop = 0;

  while (true) {
    cycle++;
    console.log(`\n========== CYCLE ${cycle} ==========`);

    // Get current state
    let data = await fetchSlab(conn, SLAB);
    let engine = parseEngine(data);
    let params = parseParams(data);
    const users = await getUsers(data);

    const insurance = Number(engine.insuranceFund.balance) / 1e9;
    const threshold = Number(params.riskReductionThreshold) / 1e9;
    const surplus = insurance - threshold;

    console.log(`Insurance: ${insurance.toFixed(4)} SOL, Threshold: ${threshold.toFixed(4)} SOL, Surplus: ${surplus.toFixed(4)} SOL`);
    console.log(`Risk reduction: ${engine.riskReductionOnly}, LP PnL: ${(Number(parseAccount(data, LP_IDX).pnl)/1e9).toFixed(4)} SOL`);

    if (engine.riskReductionOnly) {
      console.log("!!! RISK REDUCTION MODE - stopping !!!");
      break;
    }

    // Phase 1: Open max positions
    console.log("\n[Phase 1] Opening max positions...");
    await openMaxPositions(users, data);

    // Phase 2: Run cranks to accumulate PnL (30 cranks)
    console.log("\n[Phase 2] Running 30 cranks...");
    for (let i = 0; i < 30; i++) {
      await runCrank();
      await new Promise(r => setTimeout(r, 150));
    }

    // Check positions
    data = await fetchSlab(conn, SLAB);
    let totalOI = 0n;
    for (const userIdx of users) {
      const acc = parseAccount(data, userIdx);
      if (acc.positionSize !== 0n) {
        totalOI += acc.positionSize > 0n ? acc.positionSize : -acc.positionSize;
      }
    }
    console.log(`Total user OI: ${Number(totalOI)/1e9}B`);

    // Phase 3: Attempt bank run
    console.log("\n[Phase 3] Attempting bank run...");
    const result = await attemptBankRun(users, data);
    totalBankRuns++;

    console.log(`  Closed ${result.closed} positions`);
    console.log(`  Insurance change: ${result.insuranceChange >= 0 ? "+" : ""}${result.insuranceChange.toFixed(6)} SOL`);

    if (result.insuranceChange < maxInsuranceDrop) {
      maxInsuranceDrop = result.insuranceChange;
    }

    // Check final state
    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    params = parseParams(data);

    const finalInsurance = Number(engine.insuranceFund.balance) / 1e9;
    const finalThreshold = Number(params.riskReductionThreshold) / 1e9;
    const finalSurplus = finalInsurance - finalThreshold;

    console.log(`\nEnd of cycle ${cycle}:`);
    console.log(`  Insurance: ${finalInsurance.toFixed(4)} SOL`);
    console.log(`  Surplus: ${finalSurplus.toFixed(4)} SOL`);
    console.log(`  Total bank runs: ${totalBankRuns}`);
    console.log(`  Max insurance drop: ${maxInsuranceDrop.toFixed(6)} SOL`);
    console.log(`  Liquidations: ${engine.lifetimeLiquidations}, Force closes: ${engine.lifetimeForceCloses}`);

    // Check for significant events
    if (finalSurplus < 1) {
      console.log("\n!!! LOW SURPLUS WARNING !!!");
    }

    if (engine.lifetimeForceCloses > 4n) {
      console.log("\n!!! NEW FORCE CLOSE DETECTED !!!");
    }

    // Small delay between cycles
    await new Promise(r => setTimeout(r, 1000));

    // Safety limit
    if (cycle >= 50) {
      console.log("\nReached 50 cycles, stopping.");
      break;
    }
  }

  console.log("\n=== FINAL SUMMARY ===");
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);

  console.log("Total cycles:", cycle);
  console.log("Total bank runs:", totalBankRuns);
  console.log("Max insurance drop in single run:", maxInsuranceDrop.toFixed(6), "SOL");
  console.log("Final insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Final threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("Risk reduction:", engine.riskReductionOnly);
  console.log("Liquidations:", engine.lifetimeLiquidations);
  console.log("Force closes:", engine.lifetimeForceCloses);
}

main().catch(console.error);
