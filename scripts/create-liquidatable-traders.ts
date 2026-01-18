/**
 * Create traders with highly leveraged positions for liquidation testing
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeInitUser, encodeDepositCollateral, encodeKeeperCrank, encodeTradeCpi } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseAccount, parseUsedIndices, parseEngine, AccountKind } from '../src/solana/slab.js';
import { deriveLpPda } from '../src/solana/pda.js';

// Load market info
const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));

const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const ORACLE = new PublicKey(marketInfo.oracle);

const LP_INDEX = marketInfo.lp.index;
const LP_MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const LP_MATCHER_CONTEXT = new PublicKey(marketInfo.lp.matcherContext);
const LP_PDA = new PublicKey(marketInfo.lp.pda);

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Trader configs - MAXIMUM LEVERAGE positions
// For INVERTED market: oracle price ~7071 (1e12/142e6)
// Position calculation: notional = abs(pos) * price_e6 / 1e6
// For 0.1 SOL (100e6) at 10% margin: max_notional = 1e9
// max_position = 1e9 * 1e6 / 7071 ≈ 141e9
// Using 135e9 (95% of max) to ensure trade goes through with trading fees
// This puts them at ~200% of maintenance (10% initial / 5% maint)
const TRADERS = [
  { deposit: 100_000_000n, positionSize: 135_000_000_000n, isLong: true },  // 0.1 SOL, 135e9 pos (max leverage)
  { deposit: 100_000_000n, positionSize: 135_000_000_000n, isLong: true },  // 0.1 SOL, 135e9 pos (max leverage)
  { deposit: 100_000_000n, positionSize: 135_000_000_000n, isLong: true },  // 0.1 SOL, 135e9 pos (max leverage)
];

async function wrapSol(amount: bigint, userAta: PublicKey) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  tx.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: userAta,
    lamports: Number(amount),
  }));
  tx.add({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: userAta, isSigner: false, isWritable: true }],
    data: Buffer.from([17]),  // SyncNative
  });
  await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
}

async function runCrank(): Promise<number> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed', skipPreflight: true });

  // Return current crank step
  const slabData = await fetchSlab(connection, SLAB);
  const engine = parseEngine(slabData);
  return engine.crankStep;
}

async function ensureFreshSweep() {
  console.log('Ensuring fresh sweep (running cranks until step 0)...');
  const slabData = await fetchSlab(connection, SLAB);
  const engine = parseEngine(slabData);
  let step = engine.crankStep;
  console.log(`  Current step: ${step}`);

  // Run cranks until we hit step 0 (which starts a new sweep)
  // Step goes 0->1->...->15->0, and step 0 sets last_full_sweep_start_slot
  // We need step to be 1 or higher after we run, meaning step 0 just ran
  let crankCount = 0;
  const maxCranks = 20; // Safety limit

  while (crankCount < maxCranks) {
    step = await runCrank();
    crankCount++;
    console.log(`  Crank ${crankCount}: step now ${step}`);

    // If step is 1, that means step 0 just ran and set last_full_sweep_start_slot
    if (step === 1) {
      console.log('  Fresh sweep started!');
      return;
    }
  }

  throw new Error('Failed to reach step 0 after max cranks');
}

async function createTrader(config: { deposit: bigint; positionSize: bigint; isLong: boolean }, traderNum: number) {
  console.log(`\n=== Creating Trader ${traderNum} ===`);

  // Get current used indices
  const slabData = await fetchSlab(connection, SLAB);
  const usedIndices = parseUsedIndices(slabData);
  const nextIndex = usedIndices.length > 0 ? Math.max(...usedIndices) + 1 : 1;

  console.log(`  Next index: ${nextIndex}`);

  // Create user ATA
  const userAta = await getOrCreateAssociatedTokenAccount(connection, payer, NATIVE_MINT, payer.publicKey);

  // Wrap SOL for deposit
  await wrapSol(config.deposit * 2n, userAta.address);  // Extra for fees

  // Initialize user
  console.log(`  Initializing user...`);
  const initUserData = encodeInitUser({ feePayment: '1000000' });  // 0.001 SOL fee
  const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
  ]);

  const initTx = new Transaction();
  initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  initTx.add(buildIx({ programId: PROGRAM_ID, keys: initUserKeys, data: initUserData }));
  await sendAndConfirmTransaction(connection, initTx, [payer], { commitment: 'confirmed' });

  // Run crank to update state
  await runCrank();

  // Get the actual index (might have changed)
  const slabDataAfterInit = await fetchSlab(connection, SLAB);
  const usedIndicesAfterInit = parseUsedIndices(slabDataAfterInit);
  const traderIdx = usedIndicesAfterInit[usedIndicesAfterInit.length - 1];
  console.log(`  Trader index: ${traderIdx}`);

  // Deposit collateral
  console.log(`  Depositing ${Number(config.deposit) / 1e9} SOL...`);
  const depositData = encodeDepositCollateral({ userIdx: traderIdx, amount: config.deposit.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta.address,
    VAULT,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
  await sendAndConfirmTransaction(connection, depositTx, [payer], { commitment: 'confirmed' });

  // Open position with crank in same transaction (to avoid staleness)
  // Positive size = long, negative size = short
  const signedSize = config.isLong ? config.positionSize : -config.positionSize;
  console.log(`  Opening ${config.isLong ? 'LONG' : 'SHORT'} position of ${Number(config.positionSize) / 1e9} units...`);

  // Build crank instruction
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
  ]);

  // Build trade instruction
  const tradeData = encodeTradeCpi({
    userIdx: traderIdx,
    lpIdx: LP_INDEX,
    size: signedSize,
  });

  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey,    // user
    payer.publicKey,    // lpOwner (same as user since we're self-trading)
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
    LP_MATCHER_PROGRAM,
    LP_MATCHER_CONTEXT,
    LP_PDA,
  ]);

  console.log(`  Trade data: ${tradeData.toString('hex')}`);
  console.log(`  LP idx: ${LP_INDEX}, User idx: ${traderIdx}, Size: ${signedSize}`);

  // Combine crank + trade in same tx to ensure crank is fresh
  const tradeTx = new Transaction();
  tradeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }));  // More CU for both
  tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
  try {
    const sig = await sendAndConfirmTransaction(connection, tradeTx, [payer], { commitment: 'confirmed', skipPreflight: true });
    console.log(`  Crank+Trade tx: ${sig}`);
  } catch (err: any) {
    console.log(`  Trade error: ${err.message}`);
    if (err.logs) {
      console.log('  Logs:', err.logs.slice(-10));
    }
    // Try to get logs
    const txSig = err.signature;
    if (txSig) {
      const status = await connection.getSignatureStatus(txSig);
      console.log('  Status:', JSON.stringify(status));
    }
    throw err;
  }

  // Verify account state
  const finalSlabData = await fetchSlab(connection, SLAB);
  const account = parseAccount(finalSlabData, traderIdx);
  console.log(`\n  Trader ${traderNum} final state:`);
  console.log(`    Capital: ${Number(account.capital) / 1e9} SOL`);
  console.log(`    Position: ${Number(account.positionSize) / 1e9} units`);
  console.log(`    Entry price: ${account.entryPrice}`);
  console.log(`    PnL: ${Number(account.pnl) / 1e9} SOL`);

  return traderIdx;
}

async function main() {
  console.log('=== Creating Liquidatable Traders ===');
  console.log(`Slab: ${SLAB.toBase58()}`);
  console.log(`LP Index: ${LP_INDEX}`);

  // Run cranks until we have a fresh sweep
  await ensureFreshSweep();

  // Create traders
  const traderIndices: number[] = [];
  for (let i = 0; i < TRADERS.length; i++) {
    const idx = await createTrader(TRADERS[i], i + 1);
    traderIndices.push(idx);
  }

  console.log('\n=== All Traders Created ===');
  console.log('Trader indices:', traderIndices);

  // Check if any are liquidatable
  const slabData = await fetchSlab(connection, SLAB);
  const engine = parseEngine(slabData);

  console.log('\n=== Liquidation Check ===');
  for (const idx of traderIndices) {
    const account = parseAccount(slabData, idx);
    const positionAbs = account.positionSize < 0n ? -account.positionSize : account.positionSize;
    const equity = account.capital + BigInt(account.pnl);
    const maintReq = positionAbs * 500n / 10000n;  // 5% maintenance

    console.log(`Trader ${idx}:`);
    console.log(`  Position: ${Number(positionAbs) / 1e9} units`);
    console.log(`  Equity: ${Number(equity) / 1e9} SOL`);
    console.log(`  Maint req (est): ${Number(maintReq) / 1e9} SOL`);
    console.log(`  Ratio: ${(Number(equity) / Number(maintReq) * 100).toFixed(2)}%`);
    console.log(`  LIQUIDATABLE: ${equity < maintReq}`);
  }
}

main().catch(console.error);
