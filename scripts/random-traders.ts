/**
 * Random trading bot - 5 traders making random long/short trades
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeInitUser, encodeDepositCollateral, encodeKeeperCrank, encodeTradeCpi } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseAccount, parseUsedIndices, AccountKind } from '../src/solana/slab.js';

const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const VAULT = new PublicKey('AJoTRUUwAb8nB2pwqKhNSKxvbE3GdHHiM9VxpoaBLhVj');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');

interface LpInfo {
  index: number;
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
  lpPda: PublicKey;
  capital: bigint;
  position: bigint;
}

const NUM_TRADERS = 5;
const DEPOSIT_SOL = 100_000_000n; // 0.1 SOL per trader
const TRADE_SIZE = 10_000_000_000n; // 10B units per trade - MAX LEVERAGE MODE!
const TRADE_INTERVAL_MS = 5_000; // 5 seconds between trades

// Fixed direction for each trader (assigned at startup)
const traderDirections: Map<number, boolean> = new Map(); // true = LONG, false = SHORT

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

let traderIndices: number[] = [];

/**
 * Derive LP PDA from slab and LP index
 */
function deriveLpPda(slabPubkey: PublicKey, lpIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp'), slabPubkey.toBuffer(), Buffer.from([lpIndex & 0xff, (lpIndex >> 8) & 0xff])],
    PROGRAM_ID
  );
  return pda;
}

/**
 * Find all LPs in the market
 */
async function findAllLps(slabData: Buffer): Promise<LpInfo[]> {
  const usedIndices = parseUsedIndices(slabData);
  const lps: LpInfo[] = [];

  for (const idx of usedIndices) {
    const account = parseAccount(slabData, idx);
    if (!account) continue;

    // LP detection: kind === LP or matcher_program is non-zero
    const isLp = account.kind === AccountKind.LP ||
      (account.matcherProgram && !account.matcherProgram.equals(PublicKey.default));

    if (isLp) {
      lps.push({
        index: idx,
        matcherProgram: account.matcherProgram,
        matcherContext: account.matcherContext,
        lpPda: deriveLpPda(SLAB, idx),
        capital: account.capital,
        position: account.positionSize,
      });
    }
  }

  return lps;
}

/**
 * Find the best LP for a trade (currently picks randomly, can be enhanced later)
 * For buys (isLong=true), prefer LPs with lower ask (more capital, willing to sell)
 * For sells (isLong=false), prefer LPs with higher bid (more capital, willing to buy)
 */
function findBestLp(lps: LpInfo[], isLong: boolean): LpInfo | null {
  if (lps.length === 0) return null;

  // Simple heuristic: prefer LPs with more capital and opposite position
  // For long: prefer LPs that are short or flat (willing to sell)
  // For short: prefer LPs that are long or flat (willing to buy)
  const scored = lps.map(lp => {
    let score = Number(lp.capital) / 1e9; // Base score is capital in SOL
    if (isLong && lp.position < 0n) score *= 1.5; // Prefer short LPs for longs
    if (!isLong && lp.position > 0n) score *= 1.5; // Prefer long LPs for shorts
    return { lp, score };
  });

  // Sort by score descending and pick the best
  scored.sort((a, b) => b.score - a.score);
  return scored[0].lp;
}

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

  // Find all LPs to exclude them from trader list
  const lps = await findAllLps(slabData);
  const lpIndices = new Set(lps.map(lp => lp.index));

  // Find existing user accounts owned by us (exclude LPs)
  const existingIndices: number[] = [];
  for (let i = 0; i < 100; i++) {
    if (lpIndices.has(i)) continue; // Skip LPs
    const account = parseAccount(slabData, i);
    if (account && account.owner.equals(payer.publicKey)) {
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
  const newLps = await findAllLps(newSlabData);
  const newLpIndices = new Set(newLps.map(lp => lp.index));

  traderIndices = [];
  for (let i = 0; i < 100; i++) {
    if (newLpIndices.has(i)) continue; // Skip LPs
    const account = parseAccount(newSlabData, i);
    if (account && account.owner.equals(payer.publicKey)) {
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

async function executeTrade(traderIdx: number, isLong: boolean, lp: LpInfo): Promise<void> {
  // Run full crank cycle to ensure sweep is fresh (16 steps)
  for (let i = 0; i < 16; i++) {
    await runCrank();
  }
  await new Promise(r => setTimeout(r, 300));

  const size = isLong ? TRADE_SIZE : -TRADE_SIZE;

  const tradeData = encodeTradeCpi({
    userIdx: traderIdx,
    lpIdx: lp.index,
    size: size.toString()
  });

  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey,       // user
    payer.publicKey,       // lpOwner (same wallet)
    SLAB,                  // slab
    SYSVAR_CLOCK_PUBKEY,   // clock
    ORACLE,                // oracle
    lp.matcherProgram,     // matcherProg (dynamic)
    lp.matcherContext,     // matcherCtx (dynamic)
    lp.lpPda,              // lpPda (dynamic)
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

  console.log(`Trading every ${TRADE_INTERVAL_MS / 1000} seconds`);
  console.log(`MAX LEVERAGE MODE: Always INCREASE current position direction!\n`);

  let tradeCount = 0;

  while (true) {
    try {
      // Pick random trader
      const traderIdx = traderIndices[Math.floor(Math.random() * traderIndices.length)];

      // Fetch current state
      const slabData = await fetchSlab(connection, SLAB);
      const account = parseAccount(slabData, traderIdx);
      const currentPos = account?.positionSize || 0n;

      // Always INCREASE current position (if long->more long, if short->more short)
      // If flat, random 50/50
      let isLong: boolean;
      if (currentPos > 0n) {
        isLong = true; // Already LONG, go MORE LONG
      } else if (currentPos < 0n) {
        isLong = false; // Already SHORT, go MORE SHORT
      } else {
        isLong = Math.random() > 0.5;
      }
      const direction = isLong ? 'LONG' : 'SHORT';

      // Find best LP for this trade direction
      const lps = await findAllLps(slabData);
      if (lps.length === 0) {
        console.log(`[${new Date().toISOString()}] No LPs found, skipping trade\n`);
        await new Promise(r => setTimeout(r, TRADE_INTERVAL_MS));
        continue;
      }

      const bestLp = findBestLp(lps, isLong);
      if (!bestLp) {
        console.log(`[${new Date().toISOString()}] Could not find best LP, skipping trade\n`);
        await new Promise(r => setTimeout(r, TRADE_INTERVAL_MS));
        continue;
      }

      console.log(`[${new Date().toISOString()}] Trade #${++tradeCount}: Trader ${traderIdx} going ${direction} via LP ${bestLp.index}...`);

      await executeTrade(traderIdx, isLong, bestLp);
      console.log(`  ✓ Trade executed successfully (LP ${bestLp.index})`);

      // Fetch and show position
      const postSlabData = await fetchSlab(connection, SLAB);
      const postAccount = parseAccount(postSlabData, traderIdx);
      if (postAccount) {
        console.log(`  Position: ${postAccount.positionSize}, Capital: ${Number(postAccount.capital) / 1e9} SOL\n`);
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
