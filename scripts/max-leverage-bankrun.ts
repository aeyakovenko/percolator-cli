/**
 * Max leverage positions + bank run stress test
 * Goal: Create PnL divergence and have positive PnL traders exit first
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
  console.log("=== MAX LEVERAGE BANK RUN TEST ===\n");

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

  // === PHASE 1: CREATE MAX LEVERAGE POSITIONS ===
  console.log("\n=== PHASE 1: CREATING MAX LEVERAGE POSITIONS ===\n");

  // Max position size that should work with ~3 SOL capital at 10% margin
  // With price ~7000, notional = size * price / 1e6
  // 500B * 7000 / 1e6 = 3.5M SOL notional, which is way more than 10x leverage
  // Let's use 100B which gives ~700 SOL notional for ~70x leverage
  const MAX_SIZE = 500_000_000_000n; // 500B units - will be capped by margin

  for (let i = 0; i < users.length; i++) {
    const userIdx = users[i];
    // Alternate directions to create opposing positions
    const direction = i % 2 === 0 ? 1n : -1n;
    const size = direction * MAX_SIZE;

    await runSweepCycle();
    data = await fetchSlab(conn, SLAB);
    const acc = parseAccount(data, userIdx);

    // Skip if already has position
    if (acc.positionSize !== 0n) {
      console.log(`User ${userIdx}: already has position ${acc.positionSize}`);
      continue;
    }

    const dirStr = direction > 0n ? "LONG" : "SHORT";
    console.log(`Opening ${dirStr} ${MAX_SIZE} for user ${userIdx} (capital: ${(Number(acc.capital)/1e9).toFixed(2)} SOL)...`);

    const result = await trade(userIdx, size);
    if (result.success) {
      data = await fetchSlab(conn, SLAB);
      const newAcc = parseAccount(data, userIdx);
      console.log(`  SUCCESS: position=${newAcc.positionSize}, entry=${newAcc.entryPrice}`);
    } else {
      console.log(`  FAILED: ${result.error?.slice(0, 80)}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Check positions after opening
  console.log("\n=== POSITIONS AFTER OPENING ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);

  interface UserState {
    idx: number;
    position: bigint;
    capital: bigint;
    pnl: bigint;
    entry: number;
  }
  let userStates: UserState[] = [];

  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    const dir = acc.positionSize > 0n ? "LONG" : acc.positionSize < 0n ? "SHORT" : "FLAT";
    console.log(`User ${userIdx}: ${dir} ${acc.positionSize}, capital: ${(Number(acc.capital)/1e9).toFixed(2)} SOL, entry: ${acc.entryPrice}`);
    userStates.push({
      idx: userIdx,
      position: acc.positionSize,
      capital: acc.capital,
      pnl: acc.pnl,
      entry: Number(acc.entryPrice || 0),
    });
  }

  const lpAcc = parseAccount(data, LP_IDX);
  console.log(`LP: ${lpAcc.positionSize > 0n ? "LONG" : lpAcc.positionSize < 0n ? "SHORT" : "FLAT"} ${lpAcc.positionSize}`);
  console.log(`  capital: ${(Number(lpAcc.capital)/1e9).toFixed(2)} SOL, pnl: ${(Number(lpAcc.pnl)/1e9).toFixed(6)} SOL`);

  // === PHASE 2: RUN CRANKS TO ACCUMULATE PNL ===
  console.log("\n=== PHASE 2: RUNNING CRANKS (waiting for price movement/funding) ===\n");

  let maxPosPnL = 0;
  let maxNegPnL = 0;

  for (let batch = 0; batch < 30; batch++) {
    // Run 10 cranks per batch
    for (let i = 0; i < 10; i++) {
      await runCrank();
      await new Promise(r => setTimeout(r, 200));
    }

    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);

    let totalPosPnL = 0n;
    let totalNegPnL = 0n;

    for (const userIdx of users) {
      const acc = parseAccount(data, userIdx);
      if (acc.pnl > 0n) totalPosPnL += acc.pnl;
      if (acc.pnl < 0n) totalNegPnL += acc.pnl;
    }

    const lpPnL = parseAccount(data, LP_IDX).pnl;
    if (lpPnL > 0n) totalPosPnL += lpPnL;
    if (lpPnL < 0n) totalNegPnL += lpPnL;

    const posSol = Number(totalPosPnL) / 1e9;
    const negSol = Number(totalNegPnL) / 1e9;

    if (posSol > maxPosPnL) maxPosPnL = posSol;
    if (negSol < maxNegPnL) maxNegPnL = negSol;

    console.log(`Batch ${batch}: posPnL=${posSol.toFixed(6)} SOL, negPnL=${negSol.toFixed(6)} SOL, ` +
                `insurance=${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);

    // Check if we have significant PnL
    if (Math.abs(posSol) > 0.1 || Math.abs(negSol) > 0.1) {
      console.log("\nSignificant PnL detected! Proceeding to bank run...");
      break;
    }
  }

  // === PHASE 3: BANK RUN ===
  console.log("\n=== PHASE 3: BANK RUN (positive PnL exits first) ===\n");

  // Refresh state
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);

  userStates = [];
  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    userStates.push({
      idx: userIdx,
      position: acc.positionSize,
      capital: acc.capital,
      pnl: acc.pnl,
      entry: Number(acc.entryPrice || 0),
    });
  }

  // Sort by PnL descending (positive first)
  userStates.sort((a, b) => {
    if (a.pnl > b.pnl) return -1;
    if (a.pnl < b.pnl) return 1;
    return 0;
  });

  console.log("Closing order (positive PnL first):");
  for (const u of userStates) {
    if (u.position !== 0n) {
      const pnlStr = u.pnl >= 0n ? "+" : "";
      console.log(`  User ${u.idx}: PnL ${pnlStr}${(Number(u.pnl)/1e9).toFixed(6)} SOL`);
    }
  }

  console.log("");

  // Close positions in order
  for (const u of userStates) {
    if (u.position === 0n) continue;

    const pnlStr = u.pnl >= 0n ? "+" : "";
    console.log(`Closing user ${u.idx} (PnL: ${pnlStr}${(Number(u.pnl)/1e9).toFixed(6)} SOL)...`);

    await runSweepCycle();
    const closeSize = -u.position;
    const result = await trade(u.idx, closeSize);

    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    const acc = parseAccount(data, u.idx);

    console.log(`  Result: ${result.success ? "CLOSED" : "FAILED"}`);
    if (!result.success) console.log(`  Error: ${result.error?.slice(0, 80)}`);
    console.log(`  Position: ${acc.positionSize}`);
    console.log(`  Capital: ${(Number(acc.capital)/1e9).toFixed(4)} SOL`);
    console.log(`  Vault: ${(Number(engine.vault)/1e9).toFixed(4)} SOL`);
    console.log(`  Insurance: ${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);
    console.log(`  Risk reduction: ${engine.riskReductionOnly}`);
    console.log("");

    // Check if insurance dropped or risk reduction triggered
    if (engine.riskReductionOnly) {
      console.log("!!! RISK REDUCTION MODE TRIGGERED !!!");
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // === FINAL STATE ===
  console.log("\n=== FINAL STATE ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);
  params = parseParams(data);

  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("Surplus:", (Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold)) / 1e9, "SOL");
  console.log("Risk reduction mode:", engine.riskReductionOnly);
  console.log("Lifetime liquidations:", engine.lifetimeLiquidations);
  console.log("Lifetime force closes:", engine.lifetimeForceCloses);

  console.log("\nMax positive PnL observed:", maxPosPnL.toFixed(6), "SOL");
  console.log("Max negative PnL observed:", maxNegPnL.toFixed(6), "SOL");
}

main().catch(console.error);
