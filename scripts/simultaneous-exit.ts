/**
 * Continuous max leverage bank run with simultaneous winner exit
 * 1. Open half LONG, half SHORT at max leverage
 * 2. Run cranks, probe for winners
 * 3. Exit ALL winners simultaneously
 * 4. Repeat
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

async function getUsers(): Promise<number[]> {
  const data = await fetchSlab(conn, SLAB);
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

async function main() {
  console.log("=== CONTINUOUS MAX LEVERAGE BANK RUN ===");
  console.log("=== SIMULTANEOUS WINNER EXIT ===\n");

  let cycle = 0;
  let totalWinnerExits = 0;
  let maxInsuranceDrop = 0;
  let totalWinnerProfit = 0;

  while (true) {
    cycle++;
    console.log(`\n${"=".repeat(50)}`);
    console.log(`CYCLE ${cycle}`);
    console.log(`${"=".repeat(50)}`);

    let data = await fetchSlab(conn, SLAB);
    let engine = parseEngine(data);
    let params = parseParams(data);
    const users = await getUsers();

    const insurance = Number(engine.insuranceFund.balance) / 1e9;
    const threshold = Number(params.riskReductionThreshold) / 1e9;
    const surplus = insurance - threshold;

    console.log(`\nInsurance: ${insurance.toFixed(4)} SOL | Surplus: ${surplus.toFixed(4)} SOL`);

    if (engine.riskReductionOnly) {
      console.log("\n!!! RISK REDUCTION MODE - STOPPING !!!");
      break;
    }

    // Phase 1: Close any existing positions first
    console.log("\n[1] Closing existing positions...");
    for (const userIdx of users) {
      const acc = parseAccount(data, userIdx);
      if (acc.positionSize !== 0n) {
        await runSweepCycle();
        await trade(userIdx, -acc.positionSize);
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Phase 2: Open fresh positions - half LONG, half SHORT
    console.log("\n[2] Opening max leverage positions...");
    const MAX_SIZE = 500_000_000_000n;
    const longs: number[] = [];
    const shorts: number[] = [];

    for (let i = 0; i < users.length; i++) {
      const userIdx = users[i];
      const isLong = i < Math.ceil(users.length / 2);
      const size = isLong ? MAX_SIZE : -MAX_SIZE;

      await runSweepCycle();
      const success = await trade(userIdx, size);

      if (success) {
        if (isLong) longs.push(userIdx);
        else shorts.push(userIdx);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    data = await fetchSlab(conn, SLAB);
    const longEntry = longs.length > 0 ? Number(parseAccount(data, longs[0]).entryPrice) : 0;
    const shortEntry = shorts.length > 0 ? Number(parseAccount(data, shorts[0]).entryPrice) : 0;

    console.log(`  LONGs: ${longs.join(",")} @ ${longEntry}`);
    console.log(`  SHORTs: ${shorts.join(",")} @ ${shortEntry}`);

    // Phase 3: Run cranks to let price move
    console.log("\n[3] Running 30 cranks...");
    for (let i = 0; i < 30; i++) {
      await runCrank();
      await new Promise(r => setTimeout(r, 150));
    }

    // Phase 4: Probe to find winners
    console.log("\n[4] Probing for winners...");

    // Get pre-close capitals
    data = await fetchSlab(conn, SLAB);
    const preCapitals: Map<number, number> = new Map();
    for (const userIdx of [...longs, ...shorts]) {
      const acc = parseAccount(data, userIdx);
      preCapitals.set(userIdx, Number(acc.capital));
    }

    // Probe one LONG
    let longProfit = 0;
    if (longs.length > 0) {
      const probeIdx = longs[0];
      const preCap = preCapitals.get(probeIdx) || 0;
      const acc = parseAccount(data, probeIdx);

      await runSweepCycle();
      await trade(probeIdx, -acc.positionSize);

      data = await fetchSlab(conn, SLAB);
      const postCap = Number(parseAccount(data, probeIdx).capital);
      longProfit = (postCap - preCap) / 1e9;
      longs.shift(); // Remove probed
    }

    // Probe one SHORT
    let shortProfit = 0;
    if (shorts.length > 0) {
      const probeIdx = shorts[0];
      const preCap = preCapitals.get(probeIdx) || 0;
      const acc = parseAccount(data, probeIdx);

      await runSweepCycle();
      await trade(probeIdx, -acc.positionSize);

      data = await fetchSlab(conn, SLAB);
      const postCap = Number(parseAccount(data, probeIdx).capital);
      shortProfit = (postCap - preCap) / 1e9;
      shorts.shift(); // Remove probed
    }

    console.log(`  LONG probe: ${longProfit >= 0 ? "+" : ""}${longProfit.toFixed(6)} SOL`);
    console.log(`  SHORT probe: ${shortProfit >= 0 ? "+" : ""}${shortProfit.toFixed(6)} SOL`);

    // Determine winners (positive PnL or less negative)
    const winnersAreLongs = longProfit > shortProfit;
    const winnerProfit = winnersAreLongs ? longProfit : shortProfit;
    const winners = winnersAreLongs ? longs : shorts;
    const winnerSide = winnersAreLongs ? "LONG" : "SHORT";

    // Phase 5: Exit ALL winners SIMULTANEOUSLY if profitable
    if (winnerProfit > 0 && winners.length > 0) {
      console.log(`\n[5] SIMULTANEOUS EXIT: ${winners.length} ${winnerSide}s (profit: +${winnerProfit.toFixed(6)} SOL each)`);

      data = await fetchSlab(conn, SLAB);
      engine = parseEngine(data);
      const preInsurance = Number(engine.insuranceFund.balance);

      // Get positions to close
      const closeTrades: { idx: number; size: bigint }[] = [];
      for (const userIdx of winners) {
        const acc = parseAccount(data, userIdx);
        if (acc.positionSize !== 0n) {
          closeTrades.push({ idx: userIdx, size: -acc.positionSize });
        }
      }

      // Close all simultaneously (as fast as possible)
      console.log(`  Closing ${closeTrades.length} positions simultaneously...`);
      await runSweepCycle();

      const closePromises = closeTrades.map(async (ct) => {
        return trade(ct.idx, ct.size);
      });

      await Promise.all(closePromises);

      data = await fetchSlab(conn, SLAB);
      engine = parseEngine(data);
      const postInsurance = Number(engine.insuranceFund.balance);
      const insuranceChange = (postInsurance - preInsurance) / 1e9;

      console.log(`  Insurance change: ${insuranceChange >= 0 ? "+" : ""}${insuranceChange.toFixed(6)} SOL`);

      totalWinnerExits += closeTrades.length;
      totalWinnerProfit += winnerProfit * closeTrades.length;

      if (insuranceChange < maxInsuranceDrop) {
        maxInsuranceDrop = insuranceChange;
      }
    } else {
      console.log(`\n[5] No profitable side (both losing) - closing all`);

      // Close remaining positions
      for (const userIdx of [...longs, ...shorts]) {
        const acc = parseAccount(await fetchSlab(conn, SLAB), userIdx);
        if (acc.positionSize !== 0n) {
          await runSweepCycle();
          await trade(userIdx, -acc.positionSize);
          await new Promise(r => setTimeout(r, 200));
        }
      }
    }

    // Status update
    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    params = parseParams(data);

    const finalInsurance = Number(engine.insuranceFund.balance) / 1e9;
    const finalSurplus = finalInsurance - Number(params.riskReductionThreshold) / 1e9;

    console.log(`\n[CYCLE ${cycle} SUMMARY]`);
    console.log(`  Insurance: ${finalInsurance.toFixed(4)} SOL`);
    console.log(`  Surplus: ${finalSurplus.toFixed(4)} SOL`);
    console.log(`  Total winner exits: ${totalWinnerExits}`);
    console.log(`  Total winner profit: ${totalWinnerProfit.toFixed(4)} SOL`);
    console.log(`  Max insurance drop: ${maxInsuranceDrop.toFixed(6)} SOL`);
    console.log(`  Risk reduction: ${engine.riskReductionOnly}`);

    // Safety limit
    if (cycle >= 100) {
      console.log("\nReached 100 cycles, stopping.");
      break;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("\n" + "=".repeat(50));
  console.log("FINAL SUMMARY");
  console.log("=".repeat(50));
  console.log(`Total cycles: ${cycle}`);
  console.log(`Total winner exits: ${totalWinnerExits}`);
  console.log(`Total winner profit extracted: ${totalWinnerProfit.toFixed(4)} SOL`);
  console.log(`Max single insurance drop: ${maxInsuranceDrop.toFixed(6)} SOL`);
}

main().catch(console.error);
