import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { encodeKeeperCrank, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseAccount, parseUsedIndices, parseEngine, parseParams, parseConfig } from "../src/solana/slab.js";
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
  } catch (err: any) {
    console.log("Trade error:", err.message?.slice(0, 100));
    return false;
  }
}

async function main() {
  console.log("=== FUNDING RATE STRESS TEST ===\n");
  console.log("Goal: Accumulate funding-based PnL until positive PnL users can drain insurance\n");

  // Get initial state
  let data = await fetchSlab(conn, SLAB);
  const config = parseConfig(data);
  let engine = parseEngine(data);
  const params = parseParams(data);
  const indices = parseUsedIndices(data);

  console.log("Funding config:");
  console.log("  Horizon slots:", config.fundingHorizonSlots?.toString());
  console.log("  K BPS:", config.fundingKBps?.toString());
  console.log("  Max premium BPS:", config.fundingMaxPremiumBps?.toString());
  console.log("  Max BPS per slot:", config.fundingMaxBpsPerSlot?.toString());

  console.log("\nInitial state:");
  console.log("  Funding index:", engine.fundingIndexQpbE6.toString());
  console.log("  Insurance fund:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("  Threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("  Surplus:", (Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold)) / 1e9, "SOL");

  // Find users with positions
  const users: number[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";
    if (!isLP && acc.owner.equals(payer.publicKey) && acc.positionSize !== 0n) {
      users.push(idx);
    }
  }

  console.log("\nUsers with positions:", users);

  // Show initial positions
  console.log("\n=== INITIAL POSITIONS ===");
  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    const dir = acc.positionSize > 0n ? "LONG" : "SHORT";
    console.log("User " + userIdx + ": " + dir + " " + acc.positionSize +
                ", PnL: " + (Number(acc.pnl)/1e9).toFixed(6) + " SOL" +
                ", funding idx: " + acc.fundingIndex?.toString());
  }
  const lpAcc = parseAccount(data, LP_IDX);
  console.log("LP: " + (lpAcc.positionSize > 0n ? "LONG" : "SHORT") + " " + lpAcc.positionSize +
              ", PnL: " + (Number(lpAcc.pnl)/1e9).toFixed(6) + " SOL");

  // Run many cranks to accumulate funding
  console.log("\n=== RUNNING CRANKS TO ACCUMULATE FUNDING ===\n");

  const TARGET_POSITIVE_PNL = 0.5; // Target 0.5 SOL positive PnL to trigger bank run
  const MAX_CRANKS = 500;
  let totalCranks = 0;
  let maxPositivePnL = 0;

  for (let batch = 0; batch < 50; batch++) {
    // Run 10 cranks
    for (let i = 0; i < 10; i++) {
      const success = await runCrank();
      if (success) totalCranks++;
      await new Promise(r => setTimeout(r, 200));
    }

    // Check state
    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);

    let totalPosPnL = 0n;
    let totalNegPnL = 0n;
    const userPnLs: { idx: number; pnl: bigint; position: bigint }[] = [];

    for (const userIdx of users) {
      const acc = parseAccount(data, userIdx);
      if (acc.pnl > 0n) totalPosPnL += acc.pnl;
      if (acc.pnl < 0n) totalNegPnL += acc.pnl;
      userPnLs.push({ idx: userIdx, pnl: acc.pnl, position: acc.positionSize });
    }

    const lpAcc = parseAccount(data, LP_IDX);
    if (lpAcc.pnl > 0n) totalPosPnL += lpAcc.pnl;
    if (lpAcc.pnl < 0n) totalNegPnL += lpAcc.pnl;

    const positivePnLSol = Number(totalPosPnL) / 1e9;
    if (positivePnLSol > maxPositivePnL) maxPositivePnL = positivePnLSol;

    console.log("Batch " + batch + " (" + totalCranks + " cranks): " +
                "pos=" + positivePnLSol.toFixed(6) + " SOL, " +
                "neg=" + (Number(totalNegPnL)/1e9).toFixed(6) + " SOL, " +
                "funding idx=" + engine.fundingIndexQpbE6.toString());

    // Check if we have enough positive PnL
    if (positivePnLSol >= TARGET_POSITIVE_PNL) {
      console.log("\nTarget positive PnL reached! Starting bank run...");
      break;
    }

    // Also check if oracle price has moved (PnL from price movement)
    const anyLargePnL = userPnLs.some(u => Math.abs(Number(u.pnl)) > 100_000_000); // > 0.1 SOL
    if (anyLargePnL) {
      console.log("\nLarge PnL detected from price movement! Starting bank run...");
      break;
    }
  }

  // Final state before bank run
  console.log("\n=== STATE BEFORE BANK RUN ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);

  interface UserState {
    idx: number;
    position: bigint;
    capital: bigint;
    pnl: bigint;
  }
  const userStates: UserState[] = [];

  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    userStates.push({
      idx: userIdx,
      position: acc.positionSize,
      capital: acc.capital,
      pnl: acc.pnl,
    });
    const dir = acc.positionSize > 0n ? "LONG" : "SHORT";
    console.log("User " + userIdx + ": " + dir + " " + acc.positionSize +
                ", capital: " + (Number(acc.capital)/1e9).toFixed(2) + " SOL" +
                ", PnL: " + (Number(acc.pnl)/1e9).toFixed(6) + " SOL" +
                ", equity: " + (Number(acc.capital + acc.pnl)/1e9).toFixed(4) + " SOL");
  }

  const finalLp = parseAccount(data, LP_IDX);
  console.log("LP: " + (finalLp.positionSize > 0n ? "LONG" : "SHORT") + " " + finalLp.positionSize +
              ", capital: " + (Number(finalLp.capital)/1e9).toFixed(2) + " SOL" +
              ", PnL: " + (Number(finalLp.pnl)/1e9).toFixed(6) + " SOL");

  console.log("\nVault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");

  // Sort by PnL - positive first
  userStates.sort((a, b) => {
    if (a.pnl > b.pnl) return -1;
    if (a.pnl < b.pnl) return 1;
    return 0;
  });

  // === BANK RUN ===
  console.log("\n=== BANK RUN: POSITIVE PNL EXITS FIRST ===\n");

  for (const u of userStates) {
    if (u.position === 0n) continue;

    const pnlStr = u.pnl >= 0n ? "+" + (Number(u.pnl)/1e9).toFixed(6) : (Number(u.pnl)/1e9).toFixed(6);
    console.log("Closing user " + u.idx + " (PnL: " + pnlStr + " SOL)...");

    await runSweepCycle();
    const closeSize = -u.position;
    const success = await trade(u.idx, closeSize);

    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    const acc = parseAccount(data, u.idx);

    console.log("  Result: " + (success ? "CLOSED" : "FAILED"));
    console.log("  Position: " + acc.positionSize.toString());
    console.log("  Capital: " + (Number(acc.capital)/1e9).toFixed(4) + " SOL");
    console.log("  Vault: " + (Number(engine.vault)/1e9).toFixed(4) + " SOL");
    console.log("  Insurance: " + (Number(engine.insuranceFund.balance)/1e9).toFixed(4) + " SOL");
    console.log("  Risk reduction: " + engine.riskReductionOnly);

    await new Promise(r => setTimeout(r, 500));
  }

  // Final state
  console.log("\n=== FINAL STATE ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);
  const finalParams = parseParams(data);

  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Threshold:", Number(finalParams.riskReductionThreshold) / 1e9, "SOL");
  console.log("Risk reduction mode:", engine.riskReductionOnly);
  console.log("Lifetime liquidations:", engine.lifetimeLiquidations);
  console.log("Lifetime force closes:", engine.lifetimeForceCloses);
  console.log("Total cranks run:", totalCranks);
  console.log("Max positive PnL achieved:", maxPositivePnL.toFixed(6), "SOL");
}

main().catch(console.error);
