/**
 * Random trading bot - 5 traders making random long/short trades
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeInitUser, encodeDepositCollateral, encodeKeeperCrank, encodeTradeCpi } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseAccount } from '../src/solana/slab.js';

const PROGRAM_ID = new PublicKey('AT2XFGzcQ2vVHkW5xpnqhs8NvfCUq5EmEcky5KE9EhnA');
const MATCHER_PROGRAM = new PublicKey('4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy');
const SLAB = new PublicKey('8CUcauuMqAiB2xnT5c8VNM4zDHfbsedz6eLTAhHjACTe');
const VAULT = new PublicKey('AkkCj9hJBKNWFgM69Z9eiPnT9hd5Db1Q9E4yjafHvmcf');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');
const MATCHER_CTX = new PublicKey('3M17wwjMsb6m9UzDSzW49GrATVtzSDNnKfLJytoZbs3W');
const LP_PDA = new PublicKey('3hbJFjxcWyn3SWtgUygMZg8R6E8fcEu2PAt85qwckcNE');
const LP_IDX = 0;

const NUM_TRADERS = 5;
const DEPOSIT_SOL = 100_000_000n; // 0.1 SOL per trader (higher risk!)
const TRADE_SIZE = 100_000_000n; // 100M units per trade - VERY HIGH RISK with small capital!
const TRADE_INTERVAL_MS = 15_000; // 15 seconds between trades (faster for more activity)

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

let traderIndices: number[] = [];

async function wrapSol(amount: bigint, ata: PublicKey): Promise<void> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  tx.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: ata,
    lamports: Number(amount),
  }));
  tx.add({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: ata, isSigner: false, isWritable: true }],
    data: Buffer.from([17]), // SyncNative
  });
  await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
}

async function initTraders(): Promise<void> {
  console.log(`=== Initializing ${NUM_TRADERS} Traders ===\n`);

  // Get wrapped SOL ATA
  const userAta = await getOrCreateAssociatedTokenAccount(connection, payer, NATIVE_MINT, payer.publicKey);

  // Check balance and wrap more if needed
  const balance = await connection.getTokenAccountBalance(userAta.address);
  const needed = Number(DEPOSIT_SOL * BigInt(NUM_TRADERS)) / 1e9 + 0.5;

  if (balance.value.uiAmount! < needed) {
    const wrapAmount = BigInt(Math.ceil((needed - balance.value.uiAmount!) * 1e9 + 500_000_000));
    console.log(`Wrapping ${Number(wrapAmount) / 1e9} SOL...`);
    await wrapSol(wrapAmount, userAta.address);
  }

  // Get current slab state to find next available index
  const slabData = await fetchSlab(connection, SLAB);

  // Find existing user accounts owned by us
  const existingIndices: number[] = [];
  for (let i = 0; i < 100; i++) {
    const account = parseAccount(slabData, i);
    if (account && account.owner.equals(payer.publicKey) && i !== LP_IDX) {
      existingIndices.push(i);
    }
  }

  if (existingIndices.length >= NUM_TRADERS) {
    console.log(`Found ${existingIndices.length} existing traders: ${existingIndices.slice(0, NUM_TRADERS).join(', ')}`);
    traderIndices = existingIndices.slice(0, NUM_TRADERS);
    return;
  }

  // Create new traders if needed
  const newCount = NUM_TRADERS - existingIndices.length;
  console.log(`Creating ${newCount} new trader accounts...`);

  for (let i = 0; i < newCount; i++) {
    console.log(`Creating trader ${existingIndices.length + i + 1}/${NUM_TRADERS}...`);

    // Init user
    const initData = encodeInitUser({ feePayment: '1000000' });
    const initKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      payer.publicKey,
      SLAB,
      userAta.address,
      VAULT,
      TOKEN_PROGRAM_ID,
    ]);

    const initTx = new Transaction();
    initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
    initTx.add(buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData }));
    await sendAndConfirmTransaction(connection, initTx, [payer], { commitment: 'confirmed' });

    await new Promise(r => setTimeout(r, 500)); // Small delay
  }

  // Refresh slab data and get all trader indices
  const newSlabData = await fetchSlab(connection, SLAB);
  traderIndices = [];
  for (let i = 0; i < 100; i++) {
    const account = parseAccount(newSlabData, i);
    if (account && account.owner.equals(payer.publicKey) && i !== LP_IDX) {
      traderIndices.push(i);
      if (traderIndices.length >= NUM_TRADERS) break;
    }
  }

  console.log(`Trader indices: ${traderIndices.join(', ')}\n`);

  // Deposit to each trader
  for (const idx of traderIndices) {
    const account = parseAccount(newSlabData, idx);
    const currentCapital = account?.capital || 0n;

    if (currentCapital < DEPOSIT_SOL / 2n) {
      console.log(`Depositing 1 SOL to trader ${idx}...`);
      const depositData = encodeDepositCollateral({ userIdx: idx, amount: DEPOSIT_SOL.toString() });
      const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
        payer.publicKey,
        SLAB,
        userAta.address,
        VAULT,
        TOKEN_PROGRAM_ID,
      ]);

      const depositTx = new Transaction();
      depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
      depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
      await sendAndConfirmTransaction(connection, depositTx, [payer], { commitment: 'confirmed' });
      await new Promise(r => setTimeout(r, 500));
    } else {
      console.log(`Trader ${idx} already funded with ${Number(currentCapital) / 1e9} SOL`);
    }
  }

  console.log('\nAll traders initialized!\n');
}

const CRANK_NO_CALLER = 65535; // u16::MAX for permissionless crank

async function runCrank(): Promise<void> {
  const crankData = encodeKeeperCrank({ callerIdx: CRANK_NO_CALLER, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,       // caller
    SLAB,                  // slab
    SYSVAR_CLOCK_PUBKEY,   // clock
    ORACLE,                // oracle
  ]);

  const crankTx = new Transaction();
  crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: 'confirmed' });
}

async function runFullCrankCycle(): Promise<void> {
  console.log('Running full crank cycle (16 steps)...');
  for (let i = 0; i < 16; i++) {
    await runCrank();
    await new Promise(r => setTimeout(r, 100));
  }
  console.log('Crank cycle complete');
}

async function executeTrade(traderIdx: number, isLong: boolean): Promise<void> {
  // Run full crank cycle to ensure sweep is fresh (16 steps)
  for (let i = 0; i < 16; i++) {
    await runCrank();
  }
  await new Promise(r => setTimeout(r, 300));

  const size = isLong ? TRADE_SIZE : -TRADE_SIZE;

  const tradeData = encodeTradeCpi({
    userIdx: traderIdx,
    lpIdx: LP_IDX,
    size: size.toString()
  });

  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey,       // user
    payer.publicKey,       // lpOwner (same wallet)
    SLAB,                  // slab
    SYSVAR_CLOCK_PUBKEY,   // clock
    ORACLE,                // oracle
    MATCHER_PROGRAM,       // matcherProg
    MATCHER_CTX,           // matcherCtx
    LP_PDA,                // lpPda
  ]);

  const tradeTx = new Transaction();
  tradeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
  tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
  await sendAndConfirmTransaction(connection, tradeTx, [payer], { commitment: 'confirmed' });
}

async function tradeLoop(): Promise<void> {
  console.log('=== Starting Random Trading Loop ===\n');

  // Run a full crank cycle to ensure sweep is fresh
  await runFullCrankCycle();

  console.log(`Trading every ${TRADE_INTERVAL_MS / 1000} seconds\n`);
  console.log(`MOMENTUM BIAS: 80% chance to continue in current direction\n`);

  let tradeCount = 0;

  while (true) {
    try {
      // Pick random trader
      const traderIdx = traderIndices[Math.floor(Math.random() * traderIndices.length)];

      // Get current position to determine momentum bias
      const preSlabData = await fetchSlab(connection, SLAB);
      const preAccount = parseAccount(preSlabData, traderIdx);
      const currentPos = preAccount?.positionSize || 0n;

      // 80% chance to continue in current direction (momentum bias)
      // If flat, random 50/50
      let isLong: boolean;
      if (currentPos > 0n) {
        isLong = Math.random() < 0.8; // 80% continue LONG
      } else if (currentPos < 0n) {
        isLong = Math.random() >= 0.8; // 80% continue SHORT (20% go LONG)
      } else {
        isLong = Math.random() > 0.5;
      }
      const direction = isLong ? 'LONG' : 'SHORT';

      console.log(`[${new Date().toISOString()}] Trade #${++tradeCount}: Trader ${traderIdx} going ${direction}...`);

      await executeTrade(traderIdx, isLong);
      console.log(`  ✓ Trade executed successfully`);

      // Fetch and show position
      const slabData = await fetchSlab(connection, SLAB);
      const account = parseAccount(slabData, traderIdx);
      if (account) {
        console.log(`  Position: ${account.positionSize}, Capital: ${Number(account.capital) / 1e9} SOL\n`);
      }
    } catch (err: any) {
      console.error(`  ✗ Trade failed: ${err.message}\n`);
    }

    await new Promise(r => setTimeout(r, TRADE_INTERVAL_MS));
  }
}

async function main() {
  console.log('Random Traders Bot\n');
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Slab: ${SLAB.toBase58()}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}\n`);

  await initTraders();
  await tradeLoop();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
