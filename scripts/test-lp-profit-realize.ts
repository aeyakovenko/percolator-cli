/**
 * Test LP Profit Realization and Withdrawal
 *
 * Tests that LP can:
 * 1. Close position to realize PnL
 * 2. Withdraw realized profit up to insurance surplus
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseParams, parseEngine, parseConfig, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodeTradeCpi, encodeWithdrawCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI, ACCOUNTS_WITHDRAW_COLLATERAL } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
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

interface AccountState {
  idx: number;
  kind: string;
  capital: bigint;
  pnl: bigint;
  position: bigint;
  entryPrice: number;
}

async function getFullState() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  const config = parseConfig(data);

  const insurance = BigInt(engine.insuranceFund?.balance || 0);
  const threshold = BigInt(params.riskReductionThreshold || 0);
  const surplus = insurance > threshold ? insurance - threshold : 0n;

  const accounts: AccountState[] = [];
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      accounts.push({
        idx,
        kind: acc.kind === AccountKind.LP ? 'LP' : 'USER',
        capital: BigInt(acc.capital || 0),
        pnl: BigInt(acc.pnl || 0),
        position: BigInt(acc.positionSize || 0),
        entryPrice: acc.entryPriceE6 || 0,
      });
    }
  }

  return { engine, params, config, insurance, threshold, surplus, accounts };
}

async function runCranks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    try {
      const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
      ]);
      const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }) });
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix
      );
      await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
}

async function closePosition(lpIdx: number, userIdx: number, size: bigint): Promise<boolean> {
  try {
    const matcherCtx = new PublicKey(marketInfo.lp.matcherContext);
    const lpPda = new PublicKey(marketInfo.lp.pda);

    const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      payer.publicKey,       // user
      payer.publicKey,       // lpOwner
      SLAB,                  // slab
      SYSVAR_CLOCK_PUBKEY,   // clock
      ORACLE,                // oracle
      MATCHER_PROGRAM,       // matcherProg
      matcherCtx,            // matcherCtx
      lpPda,                 // lpPda
    ]);

    const ix = buildIx({
      programId: PROGRAM_ID,
      keys,
      data: encodeTradeCpi({ lpIdx, userIdx: lpIdx, size: size.toString() }),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix
    );

    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e: any) {
    console.log(`    Close error: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function tryWithdraw(accountIdx: number, amount: bigint): Promise<{ success: boolean; error?: string }> {
  try {
    const { config } = await getFullState();
    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
    const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, SLAB);

    const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
      payer.publicKey,
      SLAB,
      config.vaultPubkey,
      userAta.address,
      vaultPda,
      TOKEN_PROGRAM_ID,
      SYSVAR_CLOCK_PUBKEY,
      config.indexFeedId,
    ]);

    const ix = buildIx({
      programId: PROGRAM_ID,
      keys,
      data: encodeWithdrawCollateral({ userIdx: accountIdx, amount: amount.toString() }),
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
  console.log('TEST: LP Profit Realization and Withdrawal');
  console.log('============================================================\n');

  // Get initial state
  console.log('>>> INITIAL STATE <<<\n');
  const initial = await getFullState();

  console.log(`  Insurance: ${formatSol(initial.insurance)} SOL`);
  console.log(`  Threshold: ${formatSol(initial.threshold)} SOL`);
  console.log(`  Surplus:   ${formatSol(initial.surplus)} SOL`);
  console.log();

  const lp = initial.accounts.find(a => a.kind === 'LP');
  if (!lp) {
    console.log('ERROR: No LP account found');
    return;
  }

  console.log(`  LP Account (idx ${lp.idx}):`);
  console.log(`    Capital:  ${formatSol(lp.capital)} SOL`);
  console.log(`    PnL:      ${formatSol(lp.pnl)} SOL`);
  console.log(`    Position: ${lp.position} units`);
  console.log(`    Entry:    ${lp.entryPrice}`);
  console.log();

  // Run cranks to ensure fresh state
  console.log('>>> RUNNING CRANKS <<<\n');
  await runCranks(5);
  console.log('  Cranks complete\n');

  // Check state after cranks
  const afterCranks = await getFullState();
  const lpAfterCranks = afterCranks.accounts.find(a => a.kind === 'LP')!;

  console.log('>>> STATE AFTER CRANKS <<<\n');
  console.log(`  LP Capital: ${formatSol(lpAfterCranks.capital)} SOL`);
  console.log(`  LP PnL:     ${formatSol(lpAfterCranks.pnl)} SOL`);
  console.log(`  LP Position: ${lpAfterCranks.position} units`);
  console.log();

  // If LP has a position, try to close part of it
  if (lpAfterCranks.position !== 0n) {
    console.log('>>> CLOSING PART OF LP POSITION <<<\n');

    // Close 10% of position to realize some PnL
    const closeSize = -lpAfterCranks.position / 10n;
    console.log(`  Attempting to close ${closeSize} units (10% of position)`);

    const closed = await closePosition(lp.idx, lp.idx, closeSize);
    if (closed) {
      console.log('  Position partially closed ✓');

      // Run cranks to settle
      await runCranks(3);

      const afterClose = await getFullState();
      const lpAfterClose = afterClose.accounts.find(a => a.kind === 'LP')!;

      console.log(`\n  After close:`);
      console.log(`    Capital:  ${formatSol(lpAfterClose.capital)} SOL`);
      console.log(`    PnL:      ${formatSol(lpAfterClose.pnl)} SOL`);
      console.log(`    Position: ${lpAfterClose.position} units`);

      const capitalChange = lpAfterClose.capital - lpAfterCranks.capital;
      console.log(`    Capital change: ${capitalChange >= 0n ? '+' : ''}${formatSol(capitalChange)} SOL`);
    } else {
      console.log('  Could not close position (may need counterparty)');
    }
    console.log();
  }

  // Now test withdrawal
  console.log('>>> TESTING WITHDRAWAL <<<\n');

  const currentState = await getFullState();
  const currentLp = currentState.accounts.find(a => a.kind === 'LP')!;

  console.log(`  Current LP capital: ${formatSol(currentLp.capital)} SOL`);
  console.log(`  Current LP position: ${currentLp.position} units`);
  console.log(`  Insurance surplus: ${formatSol(currentState.surplus)} SOL`);
  console.log();

  // If LP has no position, try to withdraw
  if (currentLp.position === 0n) {
    console.log('  LP has no position - can attempt full withdrawal');

    // Test 1: Withdraw capital
    const withdrawAmount = currentLp.capital;
    console.log(`\n  [TEST 1] Withdraw full capital: ${formatSol(withdrawAmount)} SOL`);
    const result1 = await tryWithdraw(currentLp.idx, withdrawAmount);
    console.log(`    Result: ${result1.success ? 'SUCCESS ✓' : 'BLOCKED'}`);
    if (!result1.success) console.log(`    Error: ${result1.error}`);

    if (result1.success) {
      const afterWithdraw = await getFullState();
      const lpAfterWithdraw = afterWithdraw.accounts.find(a => a.kind === 'LP');
      if (lpAfterWithdraw) {
        console.log(`    LP capital after: ${formatSol(lpAfterWithdraw.capital)} SOL`);
      }
    }

  } else {
    console.log('  LP still has position - testing partial withdrawal');

    // Calculate max safe withdrawal (leave enough for margin)
    const positionNotional = (currentLp.position < 0n ? -currentLp.position : currentLp.position) * 8000n / 1_000_000n;
    const requiredMargin = positionNotional * 10n / 100n; // 10% initial margin
    const maxWithdraw = currentLp.capital > requiredMargin ? currentLp.capital - requiredMargin : 0n;

    console.log(`  Position notional: ~${formatSol(positionNotional)} SOL`);
    console.log(`  Required margin:   ~${formatSol(requiredMargin)} SOL`);
    console.log(`  Max withdrawable:  ~${formatSol(maxWithdraw)} SOL`);

    if (maxWithdraw > 0n) {
      // Try small withdrawal
      const smallWithdraw = maxWithdraw / 2n;
      console.log(`\n  [TEST] Withdraw ${formatSol(smallWithdraw)} SOL (50% of max)`);
      const result = await tryWithdraw(currentLp.idx, smallWithdraw);
      console.log(`    Result: ${result.success ? 'SUCCESS ✓' : 'BLOCKED'}`);
      if (!result.success) console.log(`    Error: ${result.error}`);

      if (result.success) {
        const afterWithdraw = await getFullState();
        const lpAfterWithdraw = afterWithdraw.accounts.find(a => a.kind === 'LP')!;
        console.log(`    LP capital after: ${formatSol(lpAfterWithdraw.capital)} SOL`);
        console.log(`    Insurance after:  ${formatSol(afterWithdraw.insurance)} SOL`);
      }
    } else {
      console.log('  Cannot withdraw - need more margin for position');
    }
  }

  // Final state
  console.log('\n>>> FINAL STATE <<<\n');
  const final = await getFullState();
  const finalLp = final.accounts.find(a => a.kind === 'LP')!;

  console.log(`  Insurance: ${formatSol(final.insurance)} SOL`);
  console.log(`  Surplus:   ${formatSol(final.surplus)} SOL`);
  console.log(`  LP Capital: ${formatSol(finalLp.capital)} SOL`);
  console.log(`  LP Position: ${finalLp.position} units`);
  console.log();

  // Verification
  console.log('============================================================');
  console.log('VERIFICATION');
  console.log('============================================================\n');

  const insuranceChange = final.insurance - initial.insurance;
  const capitalChange = finalLp.capital - lp.capital;

  console.log(`  Insurance change: ${insuranceChange >= 0n ? '+' : ''}${formatSol(insuranceChange)} SOL`);
  console.log(`  LP capital change: ${capitalChange >= 0n ? '+' : ''}${formatSol(capitalChange)} SOL`);

  if (capitalChange < 0n && insuranceChange >= 0n) {
    console.log('\n  ✓ LP was able to withdraw');
    console.log('  ✓ Insurance fund remained healthy');
  }
}

main().catch(console.error);
