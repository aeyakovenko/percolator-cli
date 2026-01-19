/**
 * Execute bank run: close positions and monitor realized PnL
 * Since LONGs entered at 6989 and SHORTs at 6919,
 * the realized PnL depends on current price at close time.
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
  console.log("=== EXECUTE BANK RUN ===\n");

  let data = await fetchSlab(conn, SLAB);
  let engine = parseEngine(data);
  let params = parseParams(data);
  const indices = parseUsedIndices(data);

  console.log("Initial state:");
  console.log("  Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("  Threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("  Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("  Risk reduction:", engine.riskReductionOnly);

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

  console.log("\n=== CURRENT POSITIONS ===");
  interface UserInfo {
    idx: number;
    position: bigint;
    entry: number;
    capital: bigint;
    expectedDir: string;
  }
  const userInfos: UserInfo[] = [];

  for (const userIdx of users) {
    const acc = parseAccount(data, userIdx);
    const dir = acc.positionSize > 0n ? "LONG" : "SHORT";
    const entry = Number(acc.entryPrice || 0);
    console.log(`User ${userIdx}: ${dir} ${acc.positionSize}, entry: ${entry}, capital: ${(Number(acc.capital)/1e9).toFixed(2)} SOL`);
    userInfos.push({
      idx: userIdx,
      position: acc.positionSize,
      entry,
      capital: acc.capital,
      expectedDir: dir,
    });
  }

  const lpAcc = parseAccount(data, LP_IDX);
  console.log(`LP: ${lpAcc.positionSize > 0n ? "LONG" : lpAcc.positionSize < 0n ? "SHORT" : "FLAT"} ${lpAcc.positionSize}, pnl: ${(Number(lpAcc.pnl)/1e9).toFixed(6)} SOL`);

  // Strategy: Close SHORTs first (entered at 6919), then LONGs (entered at 6989)
  // If current price is around 6950:
  // - SHORTs closing: realized loss = (6950-6919)*(-500B)/1e6 = -0.0155 SOL per SHORT
  // - LONGs closing: realized loss = (6950-6989)*(500B)/1e6 = -0.0195 SOL per LONG

  // Sort: SHORTs first (lower entry = better for shorts if price > entry)
  userInfos.sort((a, b) => {
    // Put SHORTs (negative position) first
    if (a.position < 0n && b.position > 0n) return -1;
    if (a.position > 0n && b.position < 0n) return 1;
    return 0;
  });

  console.log("\n=== BANK RUN ORDER (SHORTs first) ===");
  for (const u of userInfos) {
    console.log(`  User ${u.idx}: ${u.expectedDir} at entry ${u.entry}`);
  }

  console.log("\n=== EXECUTING CLOSES ===\n");

  for (const u of userInfos) {
    const preBal = await conn.getBalance(payer.publicKey);

    // Get pre-close state
    data = await fetchSlab(conn, SLAB);
    const preAcc = parseAccount(data, u.idx);
    const preEngine = parseEngine(data);

    console.log(`Closing User ${u.idx} (${u.expectedDir} at entry ${u.entry})...`);
    console.log(`  Pre-close capital: ${(Number(preAcc.capital)/1e9).toFixed(4)} SOL`);
    console.log(`  Pre-close insurance: ${(Number(preEngine.insuranceFund.balance)/1e9).toFixed(4)} SOL`);

    await runSweepCycle();
    const result = await trade(u.idx, -u.position);

    // Get post-close state
    data = await fetchSlab(conn, SLAB);
    const postAcc = parseAccount(data, u.idx);
    engine = parseEngine(data);

    const capitalChange = Number(postAcc.capital) - Number(preAcc.capital);
    const insuranceChange = Number(engine.insuranceFund.balance) - Number(preEngine.insuranceFund.balance);

    console.log(`  Result: ${result.success ? "CLOSED" : "FAILED"}`);
    if (!result.success) console.log(`  Error: ${result.error?.slice(0, 80)}`);
    console.log(`  Post-close capital: ${(Number(postAcc.capital)/1e9).toFixed(4)} SOL (${capitalChange >= 0 ? "+" : ""}${(capitalChange/1e9).toFixed(6)})`);
    console.log(`  Post-close insurance: ${(Number(engine.insuranceFund.balance)/1e9).toFixed(4)} SOL (${insuranceChange >= 0 ? "+" : ""}${(insuranceChange/1e9).toFixed(6)})`);
    console.log(`  Position: ${postAcc.positionSize}`);
    console.log(`  Risk reduction: ${engine.riskReductionOnly}`);
    console.log("");

    await new Promise(r => setTimeout(r, 500));
  }

  // Final state
  console.log("=== FINAL STATE ===");
  data = await fetchSlab(conn, SLAB);
  engine = parseEngine(data);
  params = parseParams(data);

  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Threshold:", Number(params.riskReductionThreshold) / 1e9, "SOL");
  console.log("Surplus:", (Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold)) / 1e9, "SOL");
  console.log("Risk reduction:", engine.riskReductionOnly);
  console.log("Liquidations:", engine.lifetimeLiquidations);
  console.log("Force closes:", engine.lifetimeForceCloses);

  // Check LP final state
  const finalLp = parseAccount(data, LP_IDX);
  console.log("\nLP final state:");
  console.log("  Position:", finalLp.positionSize.toString());
  console.log("  Capital:", Number(finalLp.capital) / 1e9, "SOL");
  console.log("  PnL:", Number(finalLp.pnl) / 1e9, "SOL");
}

main().catch(console.error);
