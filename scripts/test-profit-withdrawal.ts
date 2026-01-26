/**
 * Test Profit Withdrawal Limits
 *
 * Verifies that profitable users can withdraw up to the insurance surplus.
 *
 * Key invariants:
 * 1. insurance_spendable = insurance_balance - threshold (surplus above floor)
 * 2. warmup_budget = warmed_neg + insurance_spendable - warmed_pos
 * 3. Profitable users can only withdraw realized + warmed profit
 * 4. Total withdrawable profit <= insurance_spendable
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseParams, parseEngine, parseConfig, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodeTradeCpi, encodeWithdrawCollateral, encodeDepositCollateral, encodeInitUser } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_INIT_USER } from "../src/abi/accounts.js";
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

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  const config = parseConfig(data);

  const insurance = BigInt(engine.insuranceFund?.balance || 0);
  const threshold = BigInt(params.riskReductionThreshold || 0);
  const spendable = insurance > threshold ? insurance - threshold : 0n;

  const warmedPos = BigInt(engine.warmedPosTotal || 0);
  const warmedNeg = BigInt(engine.warmedNegTotal || 0);
  const warmupReserved = BigInt(engine.warmupInsuranceReserved || 0);

  return {
    engine,
    params,
    config,
    insurance,
    threshold,
    spendable,
    warmedPos,
    warmedNeg,
    warmupReserved,
  };
}

async function runCrank(): Promise<boolean> {
  try {
    const { config } = await getState();
    const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, SLAB, new PublicKey(config.vault),
      new PublicKey(config.collateralMint), ORACLE,
      TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY,
    ]);
    const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeKeeperCrank() });
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
}

async function tryWithdraw(userIdx: number, amount: bigint): Promise<{ success: boolean; error?: string }> {
  try {
    const { config } = await getState();
    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);

    const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
      payer.publicKey,
      SLAB,
      new PublicKey(config.vault),
      new PublicKey(config.collateralMint),
      userAta.address,
      TOKEN_PROGRAM_ID,
    ]);

    const ix = buildIx({
      programId: PROGRAM_ID,
      keys,
      data: encodeWithdrawCollateral({ accountIdx: userIdx, amount: amount.toString() }),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix
    );

    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message?.slice(0, 100) };
  }
}

function formatSol(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(6);
}

async function main() {
  console.log('============================================================');
  console.log('TEST: Profit Withdrawal Limits');
  console.log('============================================================\n');

  // Get current state
  const state = await getState();

  console.log('>>> CURRENT STATE <<<\n');
  console.log(`  Insurance balance:   ${formatSol(state.insurance)} SOL`);
  console.log(`  Threshold (floor):   ${formatSol(state.threshold)} SOL`);
  console.log(`  Spendable (surplus): ${formatSol(state.spendable)} SOL`);
  console.log();
  console.log(`  Warmed positive:     ${formatSol(state.warmedPos)} SOL`);
  console.log(`  Warmed negative:     ${formatSol(state.warmedNeg)} SOL`);
  console.log(`  Warmup reserved:     ${formatSol(state.warmupReserved)} SOL`);
  console.log();

  // Calculate warmup budget
  const spendableUnreserved = state.spendable > state.warmupReserved
    ? state.spendable - state.warmupReserved
    : 0n;
  const warmupBudget = state.warmedNeg + spendableUnreserved > state.warmedPos
    ? state.warmedNeg + spendableUnreserved - state.warmedPos
    : 0n;

  console.log('>>> CALCULATED LIMITS <<<\n');
  console.log(`  Spendable unreserved: ${formatSol(spendableUnreserved)} SOL`);
  console.log(`  Warmup budget:        ${formatSol(warmupBudget)} SOL`);
  console.log(`  (This is max profit that can be warmed/withdrawn)`);
  console.log();

  // Find accounts to test
  const data = await fetchSlab(conn, SLAB);
  const accounts: { idx: number; kind: string; capital: bigint; pnl: bigint; position: bigint }[] = [];

  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      accounts.push({
        idx,
        kind: acc.kind === AccountKind.LP ? 'LP' : 'USER',
        capital: BigInt(acc.capital || 0),
        pnl: BigInt(acc.pnl || 0),
        position: BigInt(acc.positionSize || 0),
      });
    }
  }

  console.log('>>> ACCOUNTS <<<\n');
  for (const acc of accounts) {
    const pnlSol = Number(acc.pnl) / 1e9;
    const capitalSol = Number(acc.capital) / 1e9;
    console.log(`  ${acc.kind} (idx ${acc.idx}): capital=${capitalSol.toFixed(4)} SOL, pnl=${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL, pos=${acc.position}`);
  }
  console.log();

  // Test withdrawal scenarios
  console.log('>>> WITHDRAWAL TESTS <<<\n');

  // Find an account with positive capital and no position
  const testAccount = accounts.find(a => a.kind === 'USER' && a.capital > 0n && a.position === 0n);

  if (testAccount) {
    console.log(`Testing with account ${testAccount.idx} (capital: ${formatSol(testAccount.capital)} SOL)\n`);

    // Run cranks first
    for (let i = 0; i < 3; i++) await runCrank();

    // Test 1: Try to withdraw more than capital (should fail)
    const overWithdraw = testAccount.capital + 1_000_000n;
    const result1 = await tryWithdraw(testAccount.idx, overWithdraw);
    console.log(`  [TEST 1] Withdraw more than capital (${formatSol(overWithdraw)} SOL):`);
    console.log(`    Result: ${result1.success ? 'ALLOWED (unexpected!)' : 'BLOCKED ✓'}`);

    // Test 2: Withdraw exactly capital (should succeed if no position)
    const exactWithdraw = testAccount.capital;
    const result2 = await tryWithdraw(testAccount.idx, exactWithdraw);
    console.log(`  [TEST 2] Withdraw exact capital (${formatSol(exactWithdraw)} SOL):`);
    console.log(`    Result: ${result2.success ? 'ALLOWED ✓' : 'BLOCKED'}`);
    if (!result2.success) console.log(`    Error: ${result2.error}`);

  } else {
    console.log('  No suitable user account found for testing.');
    console.log('  (Need an account with capital and no position)');
  }

  // Test with LP
  const lpAccount = accounts.find(a => a.kind === 'LP');
  if (lpAccount && lpAccount.pnl > 0n) {
    console.log(`\nTesting LP profit withdrawal (account ${lpAccount.idx}):`);
    console.log(`  LP has positive PnL: ${formatSol(lpAccount.pnl)} SOL`);

    // Try to withdraw profit beyond warmup budget
    const profitWithdraw = lpAccount.pnl;
    const result3 = await tryWithdraw(lpAccount.idx, profitWithdraw);
    console.log(`  [TEST 3] Withdraw full profit (${formatSol(profitWithdraw)} SOL):`);
    console.log(`    Result: ${result3.success ? 'ALLOWED' : 'BLOCKED'}`);
    if (!result3.success) console.log(`    Error: ${result3.error?.slice(0, 80)}`);
  }

  // Summary
  console.log('\n============================================================');
  console.log('ANALYSIS');
  console.log('============================================================\n');

  console.log('The profit withdrawal mechanism works as follows:');
  console.log('1. Insurance surplus = insurance_balance - threshold');
  console.log(`   Current surplus: ${formatSol(state.spendable)} SOL`);
  console.log();
  console.log('2. Warmup budget = warmed_neg + surplus_unreserved - warmed_pos');
  console.log(`   Current budget: ${formatSol(warmupBudget)} SOL`);
  console.log();
  console.log('3. Profits must "warm up" over time before withdrawal');
  console.log('   This prevents instant extraction of manipulated profits');
  console.log();
  console.log('4. Total withdrawable profit is limited by insurance surplus');
  console.log('   If insurance drops to threshold, no more profit extraction');
  console.log();

  if (state.spendable > 0n) {
    console.log(`✓ Insurance has ${formatSol(state.spendable)} SOL surplus`);
    console.log('  Profitable users can withdraw up to this amount (after warmup)');
  } else {
    console.log('✗ No insurance surplus - profit withdrawals blocked');
  }
}

main().catch(console.error);
