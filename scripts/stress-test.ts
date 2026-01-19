import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { encodeInitUser, encodeDepositCollateral, encodeKeeperCrank, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
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
    } catch {
      // ignore
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

async function depositToUser(userIdx: number, amount: bigint, userAta: PublicKey): Promise<void> {
  const depositData = encodeDepositCollateral({ userIdx, amount: amount.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta,
    VAULT,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
  await sendAndConfirmTransaction(conn, depositTx, [payer], { commitment: "confirmed" });
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
    console.log("Trade error:", err.message?.slice(0, 80));
    return false;
  }
}

async function main() {
  console.log("=== STRESS TEST: Deplete Insurance Fund ===\n");

  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);

  // Wrap SOL if needed
  const balance = await conn.getTokenAccountBalance(userAta.address);
  if (balance.value.uiAmount! < 20) {
    console.log("Wrapping 20 SOL...");
    const wrapTx = new Transaction();
    wrapTx.add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: userAta.address,
      lamports: 20_000_000_000,
    }));
    wrapTx.add({
      programId: TOKEN_PROGRAM_ID,
      keys: [{ pubkey: userAta.address, isSigner: false, isWritable: true }],
      data: Buffer.from([17]),
    });
    await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });
  }

  // Initial state
  let data = await fetchSlab(conn, SLAB);
  let engine = parseEngine(data);
  let params = parseParams(data);

  console.log("Initial state:");
  console.log("  Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("  Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("  Threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("  Surplus:", (Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold)) / 1e9, "SOL");
  console.log("  Initial margin BPS:", params.initialMarginBps.toString());
  console.log("");

  // Get existing user accounts
  let indices = parseUsedIndices(data);
  const users: number[] = [];
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";
    if (!isLP && acc.owner.equals(payer.publicKey)) {
      users.push(idx);
    }
  }

  console.log("User accounts:", users);

  // Run sweep cycle
  console.log("\nRunning sweep...");
  await runSweepCycle();

  // Deposit more to each user and take MAX LEVERAGE positions
  // With 10% initial margin, 1 SOL can control ~10 SOL notional
  // At oracle price ~$200, 1 SOL notional = 200M position units (if price is stored as 200e6)
  // To maximize leverage: trade size = capital * 10 (roughly)

  const TRADE_SIZE = 10_000_000_000n; // 10B units - very high leverage

  console.log("\nSetting up max leverage positions...");
  for (let i = 0; i < users.length; i++) {
    const userIdx = users[i];
    const direction = i % 2 === 0 ? 1n : -1n;
    const size = direction * TRADE_SIZE;

    await runSweepCycle();

    // Check current state
    data = await fetchSlab(conn, SLAB);
    const acc = parseAccount(data, userIdx);

    // Top up capital if needed
    if (acc.capital < 2_000_000_000n) {
      console.log("Depositing 2 SOL to user", userIdx);
      try {
        await depositToUser(userIdx, 2_000_000_000n, userAta.address);
      } catch (err: any) {
        console.log("Deposit failed:", err.message?.slice(0, 50));
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // Trade if position is small
    data = await fetchSlab(conn, SLAB);
    const accAfter = parseAccount(data, userIdx);
    const absPos = accAfter.positionSize > 0n ? accAfter.positionSize : -accAfter.positionSize;

    if (absPos < TRADE_SIZE / 2n) {
      console.log("User " + userIdx + " going " + (direction > 0n ? "LONG" : "SHORT") + " " + size + " (capital: " + (Number(accAfter.capital)/1e9).toFixed(2) + " SOL)");
      await runSweepCycle();
      const success = await trade(userIdx, size);
      if (success) {
        console.log("  Trade successful");
      }
    } else {
      console.log("User " + userIdx + " already has position:", accAfter.positionSize.toString());
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Check state with positions
  console.log("\n=== Positions Established ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);

  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    const dir = acc.positionSize > 0n ? "LONG" : acc.positionSize < 0n ? "SHORT" : "FLAT";
    console.log("User " + userIdx + ": " + dir + " " + acc.positionSize + 
                ", capital: " + (Number(acc.capital)/1e9).toFixed(2) + 
                " SOL, pnl: " + (Number(acc.pnl)/1e9).toFixed(4) + " SOL");
  }

  console.log("\nVault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");

  // Run many cranks to accumulate PnL changes
  console.log("\n=== Running cranks to accumulate PnL... ===");
  for (let i = 0; i < 30; i++) {
    try {
      await runCrank();
      if (i % 10 === 0) {
        data = await fetchSlab(conn, SLAB);
        engine = parseEngine(data);
        console.log("Crank " + i + ": insurance=" + (Number(engine.insuranceFund.balance)/1e9).toFixed(4));
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  // Check PnL distribution
  console.log("\n=== PnL Distribution ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);

  interface UserPnL {
    idx: number;
    position: bigint;
    capital: bigint;
    pnl: bigint;
  }
  const userPnLs: UserPnL[] = [];

  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    if (acc.positionSize !== 0n) {
      userPnLs.push({
        idx: userIdx,
        position: acc.positionSize,
        capital: acc.capital,
        pnl: acc.pnl,
      });
    }
  }

  // Sort by PnL descending (positive first)
  userPnLs.sort((a, b) => {
    if (a.pnl > b.pnl) return -1;
    if (a.pnl < b.pnl) return 1;
    return 0;
  });

  console.log("Users sorted by PnL (positive first):");
  for (const u of userPnLs) {
    const dir = u.position > 0n ? "LONG" : "SHORT";
    console.log("  User " + u.idx + ": " + dir + ", PnL: " + (Number(u.pnl)/1e9).toFixed(6) + " SOL");
  }

  console.log("\nVault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");

  // Close positive PnL positions FIRST
  console.log("\n=== BANK RUN: Closing Positive PnL First ===");

  const positiveUsers = userPnLs.filter(u => u.pnl > 0n);
  const negativeUsers = userPnLs.filter(u => u.pnl <= 0n);

  console.log("Positive PnL users:", positiveUsers.length);
  console.log("Negative/zero PnL users:", negativeUsers.length);

  // Close positive first
  for (const u of positiveUsers) {
    console.log("\nClosing user " + u.idx + " (PnL: " + (Number(u.pnl)/1e9).toFixed(6) + " SOL)...");
    await runSweepCycle();
    const closeSize = -u.position;
    const success = await trade(u.idx, closeSize);
    if (success) {
      console.log("  Closed successfully");
    }
    
    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    console.log("  Vault now:", Number(engine.vault) / 1e9, "SOL");
    console.log("  Insurance now:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
    await new Promise(r => setTimeout(r, 500));
  }

  // Then close negative
  console.log("\n--- Closing Negative/Zero PnL ---");
  for (const u of negativeUsers) {
    console.log("\nClosing user " + u.idx + " (PnL: " + (Number(u.pnl)/1e9).toFixed(6) + " SOL)...");
    await runSweepCycle();
    const closeSize = -u.position;
    const success = await trade(u.idx, closeSize);
    if (success) {
      console.log("  Closed successfully");
    } else {
      console.log("  FAILED - possible ADL or insufficient funds");
    }
    
    data = await fetchSlab(conn, SLAB);
    engine = parseEngine(data);
    console.log("  Vault now:", Number(engine.vault) / 1e9, "SOL");
    console.log("  Insurance now:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
    console.log("  Risk reduction mode:", engine.riskReductionOnly);
    await new Promise(r => setTimeout(r, 500));
  }

  // Final state
  console.log("\n=== FINAL STATE ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);
  params = parseParams(data);

  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("Risk reduction mode:", engine.riskReductionOnly);
  console.log("Lifetime liquidations:", engine.lifetimeLiquidations);
  console.log("Lifetime force closes:", engine.lifetimeForceCloses);
}

main().catch(console.error);
