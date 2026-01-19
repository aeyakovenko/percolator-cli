import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { encodeDepositCollateral, encodeKeeperCrank, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
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
    } catch {}
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
    console.log("Trade error:", err.message?.slice(0, 100));
    return false;
  }
}

async function main() {
  console.log("=== EXTREME LEVERAGE TEST ===\n");

  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);

  // Get users
  let data = await fetchSlab(conn, SLAB);
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

  console.log("Users:", users);

  // Try increasingly large position sizes until we hit the collateral limit
  // Goal: find the max position we can take that still passes initial margin check

  // With 1000 BPS (10%) initial margin, for 1 SOL collateral:
  // max_notional = capital / (initial_margin_bps / 10000) = 1 / 0.1 = 10 SOL
  // At oracle price ~7000 (0.007 SOL/unit), 10 SOL notional = 10/0.007 = ~1428 units
  // Wait that doesn't seem right. Let me check the actual price scaling.

  // Actually looking at entry_price=6936, this is likely price_e6 = 6936 means 0.006936 SOL per unit
  // No wait, price_e6 means price * 1e6, so 6936 = 0.000006936 SOL per unit
  // That's 144,092 units per SOL of notional

  // For 1 SOL collateral with 10% margin, max notional = 10 SOL
  // Max position = 10 SOL / 0.000006936 = ~1.44M units per SOL collateral

  // Actually let's just try different sizes and see what works
  const testUser = users[0];

  await runSweepCycle();

  // Check current state
  data = await fetchSlab(conn, SLAB);
  let acc = parseAccount(data, testUser);
  console.log("\nUser " + testUser + " current state:");
  console.log("  Capital:", Number(acc.capital) / 1e9, "SOL");
  console.log("  Position:", acc.positionSize.toString());
  console.log("  PnL:", Number(acc.pnl) / 1e9, "SOL");

  // If has position, close it first
  if (acc.positionSize !== 0n) {
    console.log("\nClosing existing position...");
    await runSweepCycle();
    await trade(testUser, -acc.positionSize);
  }

  // Deposit more capital
  console.log("\nDepositing 5 SOL...");
  await depositToUser(testUser, 5_000_000_000n, userAta.address);

  // Try increasingly large positions
  const sizes = [100_000_000_000n, 500_000_000_000n, 1_000_000_000_000n, 2_000_000_000_000n];

  for (const size of sizes) {
    console.log("\nTrying position size:", size.toString());
    await runSweepCycle();

    data = await fetchSlab(conn, SLAB);
    acc = parseAccount(data, testUser);
    console.log("  Capital:", Number(acc.capital) / 1e9, "SOL");

    const success = await trade(testUser, size);
    if (success) {
      data = await fetchSlab(conn, SLAB);
      acc = parseAccount(data, testUser);
      console.log("  SUCCESS! Position:", acc.positionSize.toString());
      console.log("  PnL:", Number(acc.pnl) / 1e9, "SOL");

      // Close position for next test
      await runSweepCycle();
      await trade(testUser, -acc.positionSize);
    } else {
      console.log("  FAILED - hit margin limit");
      break;
    }
  }

  console.log("\n=== Now let's create max leverage positions for all users ===\n");

  // Use the largest size that worked
  const maxSize = 100_000_000_000n; // 100B units as baseline

  for (let i = 0; i < users.length; i++) {
    const userIdx = users[i];
    const direction = i % 2 === 0 ? 1n : -1n;
    const size = direction * maxSize;

    await runSweepCycle();

    data = await fetchSlab(conn, SLAB);
    acc = parseAccount(data, userIdx);

    // Top up if needed
    if (acc.capital < 3_000_000_000n) {
      console.log("Depositing 3 SOL to user", userIdx);
      try {
        await depositToUser(userIdx, 3_000_000_000n, userAta.address);
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    // Close existing position if any
    data = await fetchSlab(conn, SLAB);
    acc = parseAccount(data, userIdx);
    if (acc.positionSize !== 0n) {
      console.log("Closing existing position for user", userIdx);
      await runSweepCycle();
      await trade(userIdx, -acc.positionSize);
      await new Promise(r => setTimeout(r, 500));
    }

    // Open new max leverage position
    console.log("User " + userIdx + " opening " + (direction > 0n ? "LONG" : "SHORT") + " " + size);
    await runSweepCycle();
    const success = await trade(userIdx, size);
    console.log("  Result:", success ? "SUCCESS" : "FAILED");
    await new Promise(r => setTimeout(r, 500));
  }

  // Check final positions
  console.log("\n=== Positions After Setup ===");
  data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);

  for (const userIdx of users) {
    acc = parseAccount(data, userIdx);
    const dir = acc.positionSize > 0n ? "LONG" : acc.positionSize < 0n ? "SHORT" : "FLAT";
    console.log("User " + userIdx + ": " + dir + " " + acc.positionSize +
                ", capital: " + (Number(acc.capital)/1e9).toFixed(2) + " SOL" +
                ", pnl: " + (Number(acc.pnl)/1e9).toFixed(6) + " SOL");
  }

  // Check LP
  const lpAcc = parseAccount(data, LP_IDX);
  console.log("\nLP " + LP_IDX + ": " + (lpAcc.positionSize > 0n ? "LONG" : "SHORT") + " " + lpAcc.positionSize +
              ", capital: " + (Number(lpAcc.capital)/1e9).toFixed(2) + " SOL" +
              ", pnl: " + (Number(lpAcc.pnl)/1e9).toFixed(6) + " SOL");

  console.log("\nVault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
}

main().catch(console.error);
