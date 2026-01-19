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
  tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeTx }));

  try {
    await sendAndConfirmTransaction(conn, tradeTx, [payer], { commitment: "confirmed" });
    return true;
  } catch (err: any) {
    console.log("Trade error:", err.message?.slice(0, 100));
    return false;
  }
}

async function main() {
  console.log("=== IMBALANCED POSITION TEST ===\n");
  console.log("Goal: Create users that take the OTHER side of LP's existing position\n");

  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);

  let data = await fetchSlab(conn, SLAB);
  const lpAcc = parseAccount(data, LP_IDX);

  console.log("LP current state:");
  console.log("  Position:", lpAcc.positionSize.toString(), "(", lpAcc.positionSize > 0n ? "LONG" : "SHORT", ")");
  console.log("  Capital:", Number(lpAcc.capital) / 1e9, "SOL");
  console.log("  PnL:", Number(lpAcc.pnl) / 1e9, "SOL");
  console.log("  Entry price:", lpAcc.entryPrice?.toString());

  // The LP is SHORT about 1.5T units with positive PnL (price dropped since entry)
  // If users go LONG and match the LP's position, they're buying at current price
  // When LP closes its short (buys back), if price has dropped since LP entry:
  //   - LP makes profit (bought low, sells high)
  //   - Users who bought at lower price also profit? No wait...

  // Actually the LP's PnL is relative to its entry. Users who trade against the LP:
  // - User goes LONG -> LP goes more SHORT
  // - User's entry price is current oracle price
  // - If price then drops further, user loses, LP gains more

  // The LP already has 0.25 SOL PnL. If users trade against it and match its position:
  // When users close, they close at current price. If their entry was also at current price,
  // their PnL is 0.

  // What we need: users to have DIFFERENT entry prices than the close price.
  // Since we can't control oracle price, this is hard to achieve.

  // Alternative strategy: Use the LP's position against it.
  // The LP is SHORT 1.5T with entry 6936. If current price is ~6936, LP PnL is ~0.
  // But LP shows 0.25 SOL PnL, so current price must be lower than 6936.

  // Let's have ALL users go LONG (opposite of LP).
  // This increases LP's short position.
  // If price drops further, LP profits more, users lose.
  // If users become underwater (capital + pnl < 0), closing them triggers insurance.

  console.log("\nCreating all-LONG positions (opposite of LP)...\n");

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

  // Use a very large position size to maximize leverage
  const HUGE_SIZE = 500_000_000_000n; // 500B units - very large

  for (const userIdx of users) {
    await runSweepCycle();
    data = await fetchSlab(conn, SLAB);
    const acc = parseAccount(data, userIdx);

    // Skip if already has position
    if (acc.positionSize !== 0n) {
      console.log("User " + userIdx + " already has position:", acc.positionSize.toString());
      continue;
    }

    console.log("User " + userIdx + " going LONG " + HUGE_SIZE + " (capital: " + (Number(acc.capital)/1e9).toFixed(2) + " SOL)");
    await runSweepCycle();

    const lpPda = deriveLpPda(SLAB, LP_IDX);
    const tradeData = encodeTradeCpi({
      lpIdx: LP_IDX,
      userIdx,
      size: HUGE_SIZE.toString(),
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
      console.log("  Trade successful");
    } catch (err: any) {
      console.log("  Trade failed:", err.message?.slice(0, 80));
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Check final state
  console.log("\n=== FINAL STATE ===");
  data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);

  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    if (acc.positionSize !== 0n) {
      const dir = acc.positionSize > 0n ? "LONG" : "SHORT";
      console.log("User " + userIdx + ": " + dir + " " + acc.positionSize +
                  ", capital: " + (Number(acc.capital)/1e9).toFixed(2) + " SOL" +
                  ", pnl: " + (Number(acc.pnl)/1e9).toFixed(6) + " SOL" +
                  ", entry: " + (acc.entryPrice?.toString() || "N/A"));
    }
  }

  const finalLp = parseAccount(data, LP_IDX);
  console.log("\nLP: " + (finalLp.positionSize > 0n ? "LONG" : "SHORT") + " " + finalLp.positionSize +
              ", capital: " + (Number(finalLp.capital)/1e9).toFixed(2) + " SOL" +
              ", pnl: " + (Number(finalLp.pnl)/1e9).toFixed(6) + " SOL" +
              ", entry: " + (finalLp.entryPrice?.toString() || "N/A"));

  console.log("\nVault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");

  // Now the strategy: run cranks, wait for price to move, check PnL, close in order
  console.log("\n=== Run cranks and monitor PnL... ===");
  for (let i = 0; i < 20; i++) {
    await runCrank();
    if (i % 5 === 0) {
      data = await fetchSlab(conn, SLAB);
      console.log("Crank " + i + ":");
      for (const userIdx of users) {
        const acc = parseAccount(data, userIdx);
        if (acc.positionSize !== 0n) {
          console.log("  User " + userIdx + " pnl: " + (Number(acc.pnl)/1e9).toFixed(6) + " SOL");
        }
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(console.error);
