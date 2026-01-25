/**
 * Admin-Free Market Test
 *
 * Simulates an admin-free market by continuously trading and monitoring:
 * - Insurance fund growth (from trading fees)
 * - Threshold auto-adjustment (scales with LP risk)
 *
 * This demonstrates the "soft burn" mechanism where insurance accumulates
 * and threshold adjusts automatically without admin intervention.
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseParams, parseEngine, parseConfig, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodeTradeCpi } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import * as fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

// State tracking
let startTime = Date.now();
let startInsurance = 0n;
let startThreshold = 0n;
let tradeCount = 0;
let crankCount = 0;

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  const config = parseConfig(data);

  // Find LP and user accounts
  let lpIdx = -1;
  let userIdx = -1;
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      if (acc.kind === AccountKind.LP && lpIdx < 0) lpIdx = idx;
      if (acc.kind === AccountKind.User && userIdx < 0) userIdx = idx;
    }
  }

  return { engine, params, config, lpIdx, userIdx };
}

async function runCrank(): Promise<boolean> {
  try {
    const { config } = await getState();

    const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey,
      SLAB,
      new PublicKey(config.vault),
      new PublicKey(config.collateralMint),
      ORACLE,
      TOKEN_PROGRAM_ID,
      SYSVAR_CLOCK_PUBKEY,
    ]);

    const ix = buildIx({
      programId: PROGRAM_ID,
      keys,
      data: encodeKeeperCrank(),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ix
    );

    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    crankCount++;
    return true;
  } catch {
    return false;
  }
}

async function executeTrade(lpIdx: number, userIdx: number, size: bigint): Promise<boolean> {
  try {
    const { config } = await getState();
    const matcherCtx = new PublicKey(marketInfo.matcherCtx);
    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);

    const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      payer.publicKey,
      SLAB,
      new PublicKey(config.vault),
      new PublicKey(config.collateralMint),
      ORACLE,
      userAta.address,
      TOKEN_PROGRAM_ID,
      SYSVAR_CLOCK_PUBKEY,
      MATCHER_PROGRAM,
      matcherCtx,
    ]);

    const ix = buildIx({
      programId: PROGRAM_ID,
      keys,
      data: encodeTradeCpi({ lpIdx, userIdx, size: size.toString() }),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    tradeCount++;
    return true;
  } catch {
    return false;
  }
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

async function printStatus() {
  const { engine, params } = await getState();

  const insurance = BigInt(engine.insuranceFund?.balance || 0);
  const threshold = BigInt(params.riskReductionThreshold || 0);
  const lpSumAbs = BigInt(engine.lpSumAbs || 0);

  const insuranceChange = insurance - startInsurance;
  const thresholdChange = threshold - startThreshold;
  const elapsed = Date.now() - startTime;

  const insurancePerHour = elapsed > 0 ? Number(insuranceChange) / (elapsed / 3600000) : 0;

  console.log('\n' + '='.repeat(70));
  console.log(`ADMIN-FREE MARKET STATUS @ ${new Date().toISOString()}`);
  console.log('='.repeat(70));
  console.log();
  console.log(`  Runtime:           ${formatDuration(elapsed)}`);
  console.log(`  Trades executed:   ${tradeCount}`);
  console.log(`  Cranks executed:   ${crankCount}`);
  console.log();
  console.log('  INSURANCE FUND (soft burn accumulator):');
  console.log(`    Current:         ${(Number(insurance) / 1e9).toFixed(6)} SOL`);
  console.log(`    Change:          +${(Number(insuranceChange) / 1e9).toFixed(6)} SOL`);
  console.log(`    Rate:            +${(insurancePerHour / 1e9).toFixed(6)} SOL/hour`);
  console.log();
  console.log('  THRESHOLD (auto-adjusting):');
  console.log(`    Current:         ${(Number(threshold) / 1e9).toFixed(6)} SOL`);
  console.log(`    Change:          ${thresholdChange >= 0n ? '+' : ''}${(Number(thresholdChange) / 1e9).toFixed(6)} SOL`);
  console.log(`    Buffer:          ${(Number(insurance - threshold) / 1e9).toFixed(4)} SOL`);
  console.log();
  console.log('  LP RISK:');
  console.log(`    LP Sum Abs:      ${lpSumAbs} units`);
  console.log(`    Notional:        ~${(Number(lpSumAbs) * 7700 / 1e6 / 1e9).toFixed(4)} SOL`);
  console.log();
}

async function main() {
  console.log('============================================================');
  console.log('ADMIN-FREE MARKET TEST');
  console.log('Simulating soft burn mechanism with continuous trading');
  console.log('============================================================\n');
  console.log('Press Ctrl+C to stop\n');

  // Get initial state
  const initial = await getState();
  startInsurance = BigInt(initial.engine.insuranceFund?.balance || 0);
  startThreshold = BigInt(initial.params.riskReductionThreshold || 0);

  console.log(`Initial insurance: ${(Number(startInsurance) / 1e9).toFixed(6)} SOL`);
  console.log(`Initial threshold: ${(Number(startThreshold) / 1e9).toFixed(6)} SOL`);
  console.log(`LP index: ${initial.lpIdx}, User index: ${initial.userIdx}`);
  console.log();

  if (initial.lpIdx < 0 || initial.userIdx < 0) {
    console.log('ERROR: Could not find LP or user account');
    return;
  }

  let iteration = 0;
  const tradeSizes = [
    10_000_000_000n,   // 10B units
    -5_000_000_000n,   // -5B units (reduce)
    20_000_000_000n,   // 20B units
    -15_000_000_000n,  // -15B units
    5_000_000_000n,    // 5B units
  ];

  // Main loop
  while (true) {
    iteration++;

    // Run crank first
    await runCrank();

    // Execute a trade
    const size = tradeSizes[iteration % tradeSizes.length];
    const traded = await executeTrade(initial.lpIdx, initial.userIdx, size);

    if (traded) {
      process.stdout.write('.');
    } else {
      process.stdout.write('x');
    }

    // Print status every 20 iterations
    if (iteration % 20 === 0) {
      await printStatus();
    }

    // Rate limit to avoid RPC throttling
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
  console.log('\n\nShutting down...');
  await printStatus();
  console.log('\nFinal status printed above.');
  process.exit(0);
});

main().catch(console.error);
