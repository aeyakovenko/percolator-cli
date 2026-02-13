/**
 * Test Profitable Trader Withdrawal
 *
 * Tests that profitable traders can withdraw realized profits up to insurance surplus.
 * Uses existing accounts if available, or creates new ones.
 */
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT, createSyncNativeInstruction } from "@solana/spl-token";
import { fetchSlab, parseParams, parseEngine, parseConfig, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
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

  return { engine, params, config, insurance, threshold, surplus, accounts, data };
}

async function runCrank(): Promise<boolean> {
  try {
    // ACCOUNTS_KEEPER_CRANK: caller, slab, clock, oracle
    const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey,
      SLAB,
      SYSVAR_CLOCK_PUBKEY,
      ORACLE,
    ]);
    const ix = buildIx({ programId: PROGRAM_ID, keys, data: encodeKeeperCrank() });
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix
    );
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
}

async function initUser(): Promise<number | null> {
  try {
    const beforeState = await getFullState();
    const beforeIndices = new Set(parseUsedIndices(beforeState.data));

    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
    const feePayment = "1000000";

    const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      payer.publicKey,
      SLAB,
      userAta.address,
      beforeState.config.vaultPubkey,
      TOKEN_PROGRAM_ID,
    ]);

    const ix = buildIx({
      programId: PROGRAM_ID,
      keys,
      data: encodeInitUser({ feePayment }),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix
    );

    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });

    // Find the new index
    const afterState = await getFullState();
    const afterIndices = parseUsedIndices(afterState.data);

    for (const idx of afterIndices) {
      if (!beforeIndices.has(idx)) {
        return idx;
      }
    }
    return null;
  } catch (e: any) {
    console.log(`  Init user error: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

async function depositCollateral(accountIdx: number, amount: bigint): Promise<boolean> {
  try {
    const { config } = await getFullState();
    const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);

    // Wrap SOL
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: userAta.address,
        lamports: amount,
      }),
      createSyncNativeInstruction(userAta.address)
    );
    await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });

    const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey,
      SLAB,
      userAta.address,
      config.vaultPubkey,
      TOKEN_PROGRAM_ID,
      SYSVAR_CLOCK_PUBKEY,
    ]);

    const ix = buildIx({
      programId: PROGRAM_ID,
      keys,
      data: encodeDepositCollateral({ userIdx: accountIdx, amount: amount.toString() }),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix
    );

    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e: any) {
    console.log(`  Deposit error: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function executeTrade(lpIdx: number, userIdx: number, size: bigint): Promise<boolean> {
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
      data: encodeTradeCpi({ lpIdx, userIdx, size: size.toString() }),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix
    );

    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e: any) {
    console.log(`    Trade error: ${e.message?.slice(0, 200)}`);
    if (e.logs) console.log(`    Logs: ${e.logs?.slice(-3).join('\n    ')}`);
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
      ORACLE,
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
  console.log('TEST: Profitable Trader Withdrawal');
  console.log('============================================================\n');

  const initial = await getFullState();

  console.log('>>> INITIAL STATE <<<\n');
  console.log(`  Insurance: ${formatSol(initial.insurance)} SOL`);
  console.log(`  Threshold: ${formatSol(initial.threshold)} SOL`);
  console.log(`  Surplus:   ${formatSol(initial.surplus)} SOL`);
  console.log();

  const lp = initial.accounts.find(a => a.kind === 'LP');
  if (!lp) {
    console.log('ERROR: No LP account found');
    return;
  }
  console.log(`  LP (idx ${lp.idx}): capital=${formatSol(lp.capital)}, pos=${lp.position}`);

  let userAccounts = initial.accounts.filter(a => a.kind === 'USER');
  console.log(`  User accounts: ${userAccounts.length}`);
  console.log();

  // Need 2 traders - create if necessary
  console.log('>>> SETTING UP TRADERS <<<\n');

  while (userAccounts.length < 2) {
    console.log(`  Creating user account ${userAccounts.length + 1}...`);
    const idx = await initUser();
    if (idx === null) {
      console.log('  ERROR: Could not create user account');
      return;
    }
    console.log(`  Created user account idx ${idx}`);

    // Deposit collateral
    console.log(`  Depositing 0.1 SOL to account ${idx}...`);
    const deposited = await depositCollateral(idx, 100_000_000n);
    if (!deposited) {
      console.log('  ERROR: Could not deposit collateral');
      return;
    }
    console.log(`  Deposit successful`);

    userAccounts.push({
      idx,
      kind: 'USER',
      capital: 100_000_000n,
      pnl: 0n,
      position: 0n,
      entryPrice: 0,
    });

    await new Promise(r => setTimeout(r, 1000));
  }

  const trader1 = userAccounts[0];
  const trader2 = userAccounts[1];
  console.log(`\n  Trader 1 (idx ${trader1.idx}): will go LONG`);
  console.log(`  Trader 2 (idx ${trader2.idx}): will go SHORT`);
  console.log();

  // Open positions
  console.log('>>> OPENING POSITIONS <<<\n');

  // Max leverage: 10x with 0.1 SOL capital = 1 SOL notional
  // At price ~8000, position = 1e9 * 1e6 / 8000 ≈ 125B units
  // Use 100B for some margin safety
  const tradeSize = 100_000_000_000n; // 100B units (near max leverage)

  console.log(`  Opening LONG on trader ${trader1.idx} (size: +${tradeSize})...`);
  const trade1Ok = await executeTrade(lp.idx, trader1.idx, tradeSize);
  console.log(`  Result: ${trade1Ok ? 'SUCCESS' : 'FAILED'}`);

  console.log(`  Opening SHORT on trader ${trader2.idx} (size: -${tradeSize})...`);
  const trade2Ok = await executeTrade(lp.idx, trader2.idx, -tradeSize);
  console.log(`  Result: ${trade2Ok ? 'SUCCESS' : 'FAILED'}`);

  const longOk = trade1Ok;
  const shortOk = trade2Ok;

  if (!longOk && !shortOk) {
    console.log('\n  ERROR: Could not open any positions');
    console.log('  Note: Both traders must have their own owner signature.');
    console.log('  This test requires different keypairs for each trader.');
    return;
  }

  // Run cranks
  console.log('\n  Running cranks...');
  for (let i = 0; i < 5; i++) {
    await runCrank();
    await new Promise(r => setTimeout(r, 500));
  }

  // Check positions
  console.log('\n>>> STATE AFTER TRADES <<<\n');
  const afterTrades = await getFullState();

  for (const trader of [trader1, trader2]) {
    const acc = afterTrades.accounts.find(a => a.idx === trader.idx);
    if (acc) {
      const pnl = Number(acc.pnl) / 1e9;
      console.log(`  Trader ${acc.idx}: pos=${acc.position}, capital=${formatSol(acc.capital)}, pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)}`);
    }
  }

  // Wait for price movement / funding
  console.log('\n>>> WAITING FOR FUNDING <<<\n');
  console.log('  Running cranks for 20 seconds...');
  for (let i = 0; i < 10; i++) {
    await runCrank();
    await new Promise(r => setTimeout(r, 2000));
    process.stdout.write('.');
  }
  console.log(' done\n');

  // Check profitability
  const afterWait = await getFullState();
  console.log('>>> PROFITABILITY CHECK <<<\n');

  let profitable: AccountState | null = null;
  for (const trader of [trader1, trader2]) {
    const acc = afterWait.accounts.find(a => a.idx === trader.idx);
    if (acc) {
      const pnl = Number(acc.pnl) / 1e9;
      const status = acc.pnl > 0n ? 'PROFIT' : acc.pnl < 0n ? 'LOSS' : 'FLAT';
      console.log(`  Trader ${acc.idx}: pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} [${status}]`);
      if (acc.pnl > 0n && (!profitable || acc.pnl > profitable.pnl)) {
        profitable = acc;
      }
    }
  }

  console.log(`\n  Insurance surplus: ${formatSol(afterWait.surplus)} SOL`);

  if (!profitable) {
    console.log('\n  No profitable trader found. Testing withdrawal of capital instead.');
    profitable = afterWait.accounts.find(a => a.idx === trader1.idx) || null;
  }

  // Test withdrawal
  console.log('\n>>> WITHDRAWAL TEST <<<\n');

  if (profitable && profitable.capital > 0n) {
    // Try to close position first if open
    if (profitable.position !== 0n) {
      console.log(`  Closing position for trader ${profitable.idx}...`);
      const closeOk = await executeTrade(lp.idx, profitable.idx, -profitable.position);
      console.log(`  Result: ${closeOk ? 'SUCCESS' : 'FAILED'}`);
      await runCrank();
    }

    // Refresh state
    const refreshed = await getFullState();
    const acc = refreshed.accounts.find(a => a.idx === profitable!.idx);

    if (acc && acc.position === 0n && acc.capital > 0n) {
      console.log(`\n  Withdrawing ${formatSol(acc.capital)} SOL from trader ${acc.idx}...`);
      const result = await tryWithdraw(acc.idx, acc.capital);

      if (result.success) {
        console.log(`  SUCCESS!`);
        const final = await getFullState();
        const finalAcc = final.accounts.find(a => a.idx === acc.idx);
        console.log(`  Remaining capital: ${formatSol(finalAcc?.capital || 0n)} SOL`);
        console.log(`  Insurance after: ${formatSol(final.insurance)} SOL`);
      } else {
        console.log(`  BLOCKED: ${result.error}`);

        // Try smaller amounts
        console.log('\n  Trying smaller amounts...');
        for (const pct of [50, 25, 10]) {
          const amt = acc.capital * BigInt(pct) / 100n;
          const r = await tryWithdraw(acc.idx, amt);
          console.log(`    ${pct}% (${formatSol(amt)}): ${r.success ? 'OK' : 'BLOCKED'}`);
          if (r.success) break;
        }
      }
    } else {
      console.log('  Cannot withdraw - position still open or no capital');
    }
  } else {
    console.log('  No trader available for withdrawal test');
  }

  // Summary
  console.log('\n============================================================');
  console.log('SUMMARY');
  console.log('============================================================\n');

  const final = await getFullState();
  console.log(`  Insurance: ${formatSol(final.insurance)} SOL`);
  console.log(`  Surplus:   ${formatSol(final.surplus)} SOL`);
  console.log();
  console.log('  Accounts:');
  for (const acc of final.accounts) {
    console.log(`    ${acc.kind} ${acc.idx}: capital=${formatSol(acc.capital)}, pos=${acc.position}`);
  }
}

main().catch(console.error);
