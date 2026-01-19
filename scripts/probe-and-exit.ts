/**
 * Probe and Exit Strategy:
 * 1. Open half LONG, half SHORT
 * 2. Periodically close ONE position to probe current price
 * 3. If winner (capital increased), close rest of that side
 * 4. Keep losers open to avoid paying losses
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

async function main() {
  console.log("=== PROBE AND EXIT STRATEGY ===\n");

  let data = await fetchSlab(conn, SLAB);
  let engine = parseEngine(data);
  let params = parseParams(data);
  const indices = parseUsedIndices(data);

  console.log("Initial state:");
  console.log(`  Insurance: ${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);
  console.log(`  Threshold: ${(Number(params.riskReductionThreshold)/1e9).toFixed(4)} SOL`);

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

  // Check existing positions
  const longs: { idx: number; position: bigint; capital: bigint; entry: bigint }[] = [];
  const shorts: { idx: number; position: bigint; capital: bigint; entry: bigint }[] = [];

  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    if (acc.positionSize > 0n) {
      longs.push({ idx: userIdx, position: acc.positionSize, capital: acc.capital, entry: acc.entryPrice || 0n });
    } else if (acc.positionSize < 0n) {
      shorts.push({ idx: userIdx, position: acc.positionSize, capital: acc.capital, entry: acc.entryPrice || 0n });
    }
  }

  console.log(`\nExisting positions: ${longs.length} LONGs, ${shorts.length} SHORTs`);

  // Open positions if needed
  if (longs.length === 0 && shorts.length === 0) {
    console.log("\nOpening new positions...");
    const MAX_SIZE = 500_000_000_000n;

    for (let i = 0; i < users.length; i++) {
      const userIdx = users[i];
      const isLong = i < Math.ceil(users.length / 2);
      const size = isLong ? MAX_SIZE : -MAX_SIZE;

      await runSweepCycle();
      const preAcc = parseAccount(await fetchSlab(conn, SLAB), userIdx);
      const success = await trade(userIdx, size);

      if (success) {
        data = await fetchSlab(conn, SLAB);
        const acc = parseAccount(data, userIdx);
        const info = { idx: userIdx, position: acc.positionSize, capital: acc.capital, entry: acc.entryPrice || 0n };
        if (isLong) longs.push(info);
        else shorts.push(info);
        console.log(`  User ${userIdx}: ${isLong ? "LONG" : "SHORT"} at entry ${acc.entryPrice}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`\nLONGs: ${longs.map(l => l.idx).join(", ")} (entry ~${longs[0]?.entry})`);
  console.log(`SHORTs: ${shorts.map(s => s.idx).join(", ")} (entry ~${shorts[0]?.entry})`);

  // Now probe by closing one position at a time
  console.log("\n=== PROBING PHASE ===\n");

  // Run some cranks first
  console.log("Running initial cranks...");
  for (let i = 0; i < 20; i++) {
    await runCrank();
    await new Promise(r => setTimeout(r, 150));
  }

  // Probe: close one LONG and one SHORT to see which side profits
  console.log("\nProbing by closing one of each side...\n");

  let longProfit = 0;
  let shortProfit = 0;

  // Probe a LONG
  if (longs.length > 0) {
    const probe = longs[0];
    data = await fetchSlab(conn, SLAB);
    const preAcc = parseAccount(data, probe.idx);
    const preCapital = Number(preAcc.capital);

    console.log(`Probing LONG (User ${probe.idx})...`);
    await runSweepCycle();
    await trade(probe.idx, -probe.position);

    data = await fetchSlab(conn, SLAB);
    const postAcc = parseAccount(data, probe.idx);
    const postCapital = Number(postAcc.capital);

    longProfit = (postCapital - preCapital) / 1e9;
    console.log(`  LONG profit: ${longProfit >= 0 ? "+" : ""}${longProfit.toFixed(6)} SOL`);

    // Remove from longs list
    longs.shift();
  }

  // Probe a SHORT
  if (shorts.length > 0) {
    const probe = shorts[0];
    data = await fetchSlab(conn, SLAB);
    const preAcc = parseAccount(data, probe.idx);
    const preCapital = Number(preAcc.capital);

    console.log(`Probing SHORT (User ${probe.idx})...`);
    await runSweepCycle();
    await trade(probe.idx, -probe.position);

    data = await fetchSlab(conn, SLAB);
    const postAcc = parseAccount(data, probe.idx);
    const postCapital = Number(postAcc.capital);

    shortProfit = (postCapital - preCapital) / 1e9;
    console.log(`  SHORT profit: ${shortProfit >= 0 ? "+" : ""}${shortProfit.toFixed(6)} SOL`);

    // Remove from shorts list
    shorts.shift();
  }

  // Determine winner
  const longsWin = longProfit > shortProfit;
  const winners = longsWin ? longs : shorts;
  const losers = longsWin ? shorts : longs;
  const winnerSide = longsWin ? "LONG" : "SHORT";

  console.log(`\n${winnerSide}s are more profitable!`);
  console.log(`  LONG profit: ${longProfit.toFixed(6)} SOL`);
  console.log(`  SHORT profit: ${shortProfit.toFixed(6)} SOL`);

  // Close remaining winners
  if (winners.length > 0 && (longsWin ? longProfit : shortProfit) > -0.05) { // Only if not losing too much
    console.log(`\n=== CLOSING REMAINING ${winnerSide}S ===\n`);

    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    const preInsurance = Number(engine.insuranceFund.balance) / 1e9;

    for (const w of winners) {
      const acc = parseAccount(data, w.idx);
      if (acc.positionSize === 0n) continue;

      const preCapital = Number(acc.capital);
      console.log(`Closing ${winnerSide} User ${w.idx}...`);

      await runSweepCycle();
      await trade(w.idx, -w.position);

      data = await fetchSlab(conn, SLAB);
      const postAcc = parseAccount(data, w.idx);
      const profit = (Number(postAcc.capital) - preCapital) / 1e9;
      console.log(`  Profit: ${profit >= 0 ? "+" : ""}${profit.toFixed(6)} SOL`);

      await new Promise(r => setTimeout(r, 300));
    }

    engine = parseEngine(data);
    const postInsurance = Number(engine.insuranceFund.balance) / 1e9;
    console.log(`\nInsurance change: ${(postInsurance - preInsurance) >= 0 ? "+" : ""}${(postInsurance - preInsurance).toFixed(6)} SOL`);
  }

  // Keep losers open
  console.log(`\n=== KEEPING LOSERS OPEN ===`);
  console.log(`Remaining ${longsWin ? "SHORT" : "LONG"} positions:`);
  for (const l of losers) {
    data = await fetchSlab(conn, SLAB);
    const acc = parseAccount(data, l.idx);
    if (acc.positionSize !== 0n) {
      console.log(`  User ${l.idx}: ${acc.positionSize > 0n ? "LONG" : "SHORT"} ${acc.positionSize}`);
    }
  }

  // Final state
  console.log("\n=== FINAL STATE ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);
  params = parseParams(data);

  console.log(`Insurance: ${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);
  console.log(`Threshold: ${(Number(params.riskReductionThreshold)/1e9).toFixed(4)} SOL`);
  console.log(`Surplus: ${((Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold))/1e9).toFixed(4)} SOL`);
  console.log(`Risk reduction: ${engine.riskReductionOnly}`);
  console.log(`LP PnL: ${(Number(parseAccount(data, LP_IDX).pnl)/1e9).toFixed(4)} SOL`);
}

main().catch(console.error);
