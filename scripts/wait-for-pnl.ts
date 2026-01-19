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

async function runCrank(): Promise<void> {
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
  await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: "confirmed" });
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
  console.log("=== WAITING FOR PNL DIVERGENCE & BANK RUN ===\n");

  // Get users
  let data = await fetchSlab(conn, SLAB);
  let indices = parseUsedIndices(data);
  const users: number[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";
    if (!isLP && acc.owner.equals(payer.publicKey) && acc.positionSize !== 0n) {
      users.push(idx);
    }
  }

  console.log("Users with positions:", users);

  // Run cranks to accumulate funding and PnL
  console.log("\nRunning 50 crank cycles to accumulate PnL...");
  for (let i = 0; i < 50; i++) {
    try {
      await runCrank();
      if (i % 10 === 0) {
        data = await fetchSlab(conn, SLAB);
        const engine = parseEngine(data);

        let totalPosPnL = 0n;
        let totalNegPnL = 0n;
        for (const userIdx of users) {
          const acc = parseAccount(data, userIdx);
          if (acc.pnl > 0n) totalPosPnL += acc.pnl;
          if (acc.pnl < 0n) totalNegPnL += acc.pnl;
        }

        console.log("Crank " + i + ": posPnL=" + (Number(totalPosPnL)/1e9).toFixed(6) + 
                    ", negPnL=" + (Number(totalNegPnL)/1e9).toFixed(6) + 
                    ", insurance=" + (Number(engine.insuranceFund.balance)/1e9).toFixed(4));
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  // Check PnL distribution
  console.log("\n=== PNL DISTRIBUTION ===");
  data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);

  interface UserPnL {
    idx: number;
    position: bigint;
    capital: bigint;
    pnl: bigint;
    equity: bigint;
  }
  const userPnLs: UserPnL[] = [];

  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    if (acc.positionSize !== 0n) {
      // Effective equity = capital + max(pnl, 0) for withdrawal purposes
      // But for sorting, we use raw PnL
      userPnLs.push({
        idx: userIdx,
        position: acc.positionSize,
        capital: acc.capital,
        pnl: acc.pnl,
        equity: acc.capital + acc.pnl,
      });
    }
  }

  // Sort by PnL descending (positive first)
  userPnLs.sort((a, b) => {
    if (a.pnl > b.pnl) return -1;
    if (a.pnl < b.pnl) return 1;
    return 0;
  });

  console.log("\nUsers sorted by PnL (positive first):");
  for (const u of userPnLs) {
    const dir = u.position > 0n ? "LONG" : "SHORT";
    console.log("  User " + u.idx + ": " + dir + ", PnL: " + (Number(u.pnl)/1e9).toFixed(6) + 
                " SOL, capital: " + (Number(u.capital)/1e9).toFixed(2) + 
                ", equity: " + (Number(u.equity)/1e9).toFixed(4) + " SOL");
  }

  const lpAcc = parseAccount(data, LP_IDX);
  console.log("\nLP: PnL: " + (Number(lpAcc.pnl)/1e9).toFixed(6) + 
              " SOL, capital: " + (Number(lpAcc.capital)/1e9).toFixed(2) + " SOL");

  console.log("\nVault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("Surplus:", (Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold)) / 1e9, "SOL");

  // === BANK RUN: Close positive PnL first ===
  console.log("\n=== BANK RUN: CLOSING POSITIVE PNL FIRST ===\n");

  const positiveUsers = userPnLs.filter(u => u.pnl > 0n);
  const negativeUsers = userPnLs.filter(u => u.pnl <= 0n);

  console.log("Positive PnL users:", positiveUsers.length);
  console.log("Negative/zero PnL users:", negativeUsers.length);

  // Close positive first (they extract profits)
  for (const u of positiveUsers) {
    console.log("\nClosing user " + u.idx + " (PnL: +" + (Number(u.pnl)/1e9).toFixed(6) + " SOL)...");
    await runSweepCycle();
    const closeSize = -u.position;
    const success = await trade(u.idx, closeSize);
    
    data = await fetchSlab(conn, SLAB);
    const engine = parseEngine(data);
    const acc = parseAccount(data, u.idx);
    console.log("  Result:", success ? "CLOSED" : "FAILED");
    console.log("  New position:", acc.positionSize.toString());
    console.log("  Vault:", Number(engine.vault) / 1e9, "SOL");
    console.log("  Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
    await new Promise(r => setTimeout(r, 500));
  }

  // Then close negative (they need to pay losses)
  console.log("\n--- Closing Negative/Zero PnL (these users lost money) ---");
  for (const u of negativeUsers) {
    console.log("\nClosing user " + u.idx + " (PnL: " + (Number(u.pnl)/1e9).toFixed(6) + " SOL)...");
    await runSweepCycle();
    const closeSize = -u.position;
    const success = await trade(u.idx, closeSize);
    
    data = await fetchSlab(conn, SLAB);
    const engine = parseEngine(data);
    const acc = parseAccount(data, u.idx);
    console.log("  Result:", success ? "CLOSED" : "FAILED - possible ADL or liquidation");
    console.log("  New position:", acc.positionSize.toString());
    console.log("  Capital:", Number(acc.capital) / 1e9, "SOL");
    console.log("  Vault:", Number(engine.vault) / 1e9, "SOL");
    console.log("  Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
    console.log("  Risk reduction mode:", engine.riskReductionOnly);
    await new Promise(r => setTimeout(r, 500));
  }

  // Final state
  console.log("\n=== FINAL STATE ===");
  data = await fetchSlab(conn, SLAB);
  const finalEngine = parseEngine(data);
  const finalParams = parseParams(data);

  console.log("Vault:", Number(finalEngine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(finalEngine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Threshold:", Number(finalParams.riskReductionThreshold) / 1e9, "SOL");
  console.log("Risk reduction mode:", finalEngine.riskReductionOnly);
  console.log("Lifetime liquidations:", finalEngine.lifetimeLiquidations);
  console.log("Lifetime force closes:", finalEngine.lifetimeForceCloses);
}

main().catch(console.error);
