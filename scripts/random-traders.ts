/**
 * Random trading bot - 5 traders making random long/short trades
 */
import { Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import * as fs from 'fs';
import { encodeInitUser, encodeDepositCollateral, encodeKeeperCrank, encodeTradeCpi, encodeWithdrawCollateral } from '../src/abi/instructions.js';
import { buildAccountMetas, ACCOUNTS_INIT_USER, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TRADE_CPI, ACCOUNTS_WITHDRAW_COLLATERAL } from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseAccount, parseUsedIndices, AccountKind } from '../src/solana/slab.js';

// Load market config from devnet-market.json
const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const VAULT = new PublicKey(marketInfo.vault);
const ORACLE = new PublicKey(marketInfo.oracle);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const LP_MATCHER_CONTEXT = new PublicKey(marketInfo.lp.matcherContext);
const LP_PDA = new PublicKey(marketInfo.lp.pda);
const LP_INDEX = marketInfo.lp.index;

interface LpInfo {
  index: number;
  matcherProgram: PublicKey;
  matcherContext: PublicKey;
  lpPda: PublicKey;
  capital: bigint;
  position: bigint;
}

const NUM_TRADERS = 5;
const DEPOSIT_SOL = 1_000_000_000n; // 1 SOL per trader
const TRADE_SIZE = 100_000_000_000n; // 100B units per trade - MAX LEVERAGE MODE!
const TRADE_INTERVAL_MS = 10_000; // 10 seconds between trades (rate limit protection)

// Fixed direction for each trader (assigned at startup)
const traderDirections: Map<number, boolean> = new Map(); // true = LONG, false = SHORT

const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8'))));
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

let traderIndices: number[] = [];

/**
 * Derive vault authority PDA
 */
function deriveVaultAuthority(slabPubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), slabPubkey.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

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
        SYSVAR_CLOCK_PUBKEY,
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
  console.log('Running crank cycle (4 steps)...');
  for (let i = 0; i < 4; i++) {
    try {
      await runCrank();
      await new Promise(r => setTimeout(r, 500)); // Longer delay for rate limiting
    } catch {
      // Ignore crank errors
    }
  }
  console.log('Crank cycle complete');
}

/**
 * Withdraw collateral from a trader account
 */
async function executeWithdraw(traderIdx: number, amount: bigint, userAta: PublicKey): Promise<void> {
  // Run crank to ensure state is fresh (reduced for rate limiting)
  for (let i = 0; i < 2; i++) {
    try { await runCrank(); } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  const vaultPda = deriveVaultAuthority(SLAB);

  const withdrawData = encodeWithdrawCollateral({
    userIdx: traderIdx,
    amount: amount.toString()
  });

  const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
    payer.publicKey,       // user
    SLAB,                  // slab
    VAULT,                 // vault
    userAta,               // userAta
    vaultPda,              // vaultPda
    TOKEN_PROGRAM_ID,      // tokenProgram
    SYSVAR_CLOCK_PUBKEY,   // clock
    ORACLE,                // oracle
  ]);

  const withdrawTx = new Transaction();
  withdrawTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  withdrawTx.add(buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData }));
  await sendAndConfirmTransaction(connection, withdrawTx, [payer], { commitment: 'confirmed' });
}

/**
 * Deposit collateral to a trader account
 */
async function executeDeposit(traderIdx: number, amount: bigint, userAta: PublicKey): Promise<void> {
  const depositData = encodeDepositCollateral({ userIdx: traderIdx, amount: amount.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    payer.publicKey,
    SLAB,
    userAta,
    VAULT,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  depositTx.add(buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData }));
  await sendAndConfirmTransaction(connection, depositTx, [payer], { commitment: 'confirmed' });
}

/**
 * Simulate a bank run - profitable traders withdraw FIRST (before losers)
 * This tests if winners can drain liquidity before losers exit
 */
async function simulateBankRun(userAta: PublicKey): Promise<{ success: number; failed: number; totalWithdrawn: bigint }> {
  console.log('\n🏃 === BANK RUN SIMULATION (WINNERS FIRST) === 🏃\n');

  let success = 0;
  let failed = 0;
  let totalWithdrawn = 0n;

  const slabData = await fetchSlab(connection, SLAB);

  // Build list of traders with their PnL for sorting
  const traderData: { idx: number; capital: bigint; pnl: bigint; position: bigint }[] = [];
  for (const traderIdx of traderIndices) {
    const account = parseAccount(slabData, traderIdx);
    if (!account) continue;
    traderData.push({
      idx: traderIdx,
      capital: account.capital,
      pnl: account.pnl,
      position: account.positionSize,
    });
  }

  // Sort by PnL descending (most positive first, then losers)
  traderData.sort((a, b) => {
    const pnlA = Number(a.pnl);
    const pnlB = Number(b.pnl);
    return pnlB - pnlA; // Descending: winners first
  });

  console.log('Withdrawal order (winners first):');
  traderData.forEach(t => {
    const pnlStr = Number(t.pnl) >= 0 ? `+${(Number(t.pnl)/1e9).toFixed(4)}` : `${(Number(t.pnl)/1e9).toFixed(4)}`;
    console.log(`  Trader ${t.idx}: pnl=${pnlStr} SOL, capital=${(Number(t.capital)/1e9).toFixed(3)} SOL`);
  });
  console.log('');

  for (const trader of traderData) {
    const { idx: traderIdx, capital, pnl, position } = trader;
    const pnlStr = Number(pnl) >= 0 ? `+${(Number(pnl)/1e9).toFixed(4)}` : `${(Number(pnl)/1e9).toFixed(4)}`;

    console.log(`Trader ${traderIdx} (pnl=${pnlStr}): capital=${Number(capital)/1e9} SOL, pos=${position}`);

    if (capital <= 0n) {
      console.log(`  → No capital to withdraw`);
      continue;
    }

    // If has position, can only withdraw excess margin
    // For simplicity, try to withdraw all - let the program reject if insufficient margin
    try {
      // Try withdrawing all capital
      await executeWithdraw(traderIdx, capital, userAta);
      console.log(`  ✓ Withdrew ${Number(capital)/1e9} SOL`);
      totalWithdrawn += capital;
      success++;
    } catch (err: any) {
      // If full withdraw fails, try withdrawing half
      try {
        const halfAmount = capital / 2n;
        if (halfAmount > 0n) {
          await executeWithdraw(traderIdx, halfAmount, userAta);
          console.log(`  ⚠ Partial withdraw: ${Number(halfAmount)/1e9} SOL (had position)`);
          totalWithdrawn += halfAmount;
          success++;
        }
      } catch (err2: any) {
        console.log(`  ✗ Withdraw failed: ${err.message?.slice(0, 50)}`);
        failed++;
      }
    }

    // Longer delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`\n🏃 Bank Run Complete: ${success} succeeded, ${failed} failed`);
  console.log(`   Total withdrawn: ${Number(totalWithdrawn)/1e9} SOL\n`);

  return { success, failed, totalWithdrawn };
}

/**
 * Re-fund all traders after a bank run
 */
async function refundAllTraders(userAta: PublicKey): Promise<void> {
  console.log('\n💰 === REFUNDING ALL TRADERS === 💰\n');

  const slabData = await fetchSlab(connection, SLAB);

  for (const traderIdx of traderIndices) {
    const account = parseAccount(slabData, traderIdx);
    const currentCapital = account?.capital || 0n;

    if (currentCapital < DEPOSIT_SOL / 2n) {
      try {
        await executeDeposit(traderIdx, DEPOSIT_SOL, userAta);
        console.log(`  Trader ${traderIdx}: deposited ${Number(DEPOSIT_SOL)/1e9} SOL`);
      } catch (err: any) {
        console.log(`  Trader ${traderIdx}: deposit failed - ${err.message?.slice(0, 50)}`);
      }
      // Longer delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 600));
    } else {
      console.log(`  Trader ${traderIdx}: already has ${Number(currentCapital)/1e9} SOL`);
    }
  }

  console.log('\n💰 Refunding complete\n');
}

/**
 * Top up traders that are low on capital (before bank run)
 */
async function topUpTradersIfNeeded(userAta: PublicKey): Promise<void> {
  const slabData = await fetchSlab(connection, SLAB);
  let toppedUp = 0;

  for (const traderIdx of traderIndices) {
    const account = parseAccount(slabData, traderIdx);
    const currentCapital = account?.capital || 0n;

    // Top up if capital is below threshold
    if (currentCapital < DEPOSIT_SOL / 4n) {
      try {
        await executeDeposit(traderIdx, DEPOSIT_SOL, userAta);
        console.log(`[TopUp] Trader ${traderIdx}: deposited ${Number(DEPOSIT_SOL)/1e9} SOL (was ${Number(currentCapital)/1e9})`);
        toppedUp++;
        await new Promise(r => setTimeout(r, 500));
      } catch (err: any) {
        // Ignore deposit failures
      }
    }
  }

  if (toppedUp > 0) {
    console.log(`[TopUp] Topped up ${toppedUp} traders\n`);
  }
}

async function executeTrade(traderIdx: number, isLong: boolean, lp: LpInfo): Promise<void> {
  // Run cranks to ensure sweep is fresh (reduced for rate limiting)
  for (let i = 0; i < 2; i++) {
    try { await runCrank(); } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

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

const BANK_RUN_INTERVAL = 20; // Trigger bank run every N trades
const PNL_REALIZATION_INTERVAL = 15; // Try to realize PnL every N trades

/**
 * Close all positions to realize PnL - this should trigger ADL if one side can't pay
 */
async function realizePnL(): Promise<{ closed: number; adlTriggered: boolean }> {
  console.log('\n💰 === PNL REALIZATION (CLOSING ALL POSITIONS) === 💰\n');

  const slabData = await fetchSlab(connection, SLAB);
  const lps = await findAllLps(slabData);
  if (lps.length === 0) {
    console.log('No LPs found, skipping PnL realization');
    return { closed: 0, adlTriggered: false };
  }

  let closed = 0;
  let adlTriggered = false;

  // Get all trader positions and sort by absolute PnL (most profitable first)
  const traderData: { idx: number; position: bigint; pnl: bigint; capital: bigint }[] = [];
  for (const traderIdx of traderIndices) {
    const account = parseAccount(slabData, traderIdx);
    if (!account || account.positionSize === 0n) continue;
    traderData.push({
      idx: traderIdx,
      position: account.positionSize,
      pnl: account.pnl,
      capital: account.capital,
    });
  }

  // Sort by PnL descending (most profitable first - they try to realize gains first)
  traderData.sort((a, b) => Number(b.pnl) - Number(a.pnl));

  console.log('Closing order (most profitable first):');
  traderData.forEach(t => {
    const dir = t.position > 0n ? 'LONG' : 'SHORT';
    const pnlStr = Number(t.pnl) >= 0 ? `+${(Number(t.pnl)/1e9).toFixed(4)}` : `${(Number(t.pnl)/1e9).toFixed(4)}`;
    console.log(`  Trader ${t.idx}: ${dir} ${Math.abs(Number(t.position))/1e9}B, pnl=${pnlStr} SOL`);
  });
  console.log('');

  for (const trader of traderData) {
    const { idx: traderIdx, position } = trader;
    const isLong = position > 0n;
    const closeDirection = !isLong; // Close LONG by going SHORT, close SHORT by going LONG
    const closeSize = position > 0n ? -position : -position; // Negate to close

    // Find LP for closing trade
    const bestLp = findBestLp(lps, closeDirection);
    if (!bestLp) continue;

    console.log(`Trader ${traderIdx}: Closing ${isLong ? 'LONG' : 'SHORT'} position of ${Math.abs(Number(position))/1e9}B...`);

    try {
      // Run cranks first (reduced for rate limiting)
      for (let i = 0; i < 2; i++) {
        try { await runCrank(); } catch {}
        await new Promise(r => setTimeout(r, 300));
      }

      // Execute closing trade (opposite direction, same size to flatten)
      const tradeData = encodeTradeCpi({
        userIdx: traderIdx,
        lpIdx: bestLp.index,
        size: closeSize.toString()
      });

      const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
        payer.publicKey,
        payer.publicKey,
        SLAB,
        SYSVAR_CLOCK_PUBKEY,
        ORACLE,
        bestLp.matcherProgram,
        bestLp.matcherContext,
        bestLp.lpPda,
      ]);

      const tradeTx = new Transaction();
      tradeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
      tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
      await sendAndConfirmTransaction(connection, tradeTx, [payer], { commitment: 'confirmed' });

      // Check if position actually closed
      const postSlabData = await fetchSlab(connection, SLAB);
      const postAccount = parseAccount(postSlabData, traderIdx);
      const newPos = postAccount?.positionSize || 0n;
      const newPnl = postAccount?.pnl || 0n;

      if (newPos === 0n) {
        console.log(`  ✓ Position closed! Realized PnL: ${Number(newPnl)/1e9} SOL`);
        closed++;
      } else {
        // Partial close or ADL may have occurred
        console.log(`  ⚠ Partial close: remaining position ${newPos}, PnL: ${Number(newPnl)/1e9} SOL`);
        if (Math.abs(Number(newPos)) < Math.abs(Number(position))) {
          console.log(`  🔥 ADL may have triggered! Position reduced from ${position} to ${newPos}`);
          adlTriggered = true;
        }
      }
    } catch (err: any) {
      const errMsg = err.message || '';
      if (errMsg.includes('0x11') || errMsg.includes('0x12')) {
        console.log(`  🔥 ADL ERROR detected: ${errMsg.slice(0, 80)}`);
        adlTriggered = true;
      } else {
        console.log(`  ✗ Close failed: ${errMsg.slice(0, 60)}`);
      }
    }

    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`\n💰 PnL Realization Complete: ${closed} positions closed, ADL triggered: ${adlTriggered}\n`);
  return { closed, adlTriggered };
}

async function tradeLoop(): Promise<void> {
  console.log('=== Starting Random Trading Loop ===\n');

  // Get wrapped SOL ATA for withdrawals
  const userAta = await getOrCreateAssociatedTokenAccount(connection, payer, NATIVE_MINT, payer.publicKey);

  // Run a full crank cycle to ensure sweep is fresh
  await runFullCrankCycle();

  console.log(`Trading every ${TRADE_INTERVAL_MS / 1000} seconds`);
  console.log(`MAX LEVERAGE MODE: Always INCREASE current position direction!`);
  console.log(`BANK RUNS: Every ${BANK_RUN_INTERVAL} trades`);
  console.log(`PNL REALIZATION: Every ${PNL_REALIZATION_INTERVAL} trades (to trigger ADL)\n`);

  let tradeCount = 0;
  let failCount = 0;
  let bankRunCount = 0;
  let pnlRealizationCount = 0;

  while (true) {
    try {
      // Check if it's time for PnL realization (to trigger ADL)
      if (tradeCount > 0 && tradeCount % PNL_REALIZATION_INTERVAL === 0 && tradeCount % BANK_RUN_INTERVAL !== 0) {
        pnlRealizationCount++;
        console.log(`\n[${new Date().toISOString()}] === PNL REALIZATION #${pnlRealizationCount} (after ${tradeCount} trades) ===\n`);

        const result = await realizePnL();

        if (result.adlTriggered) {
          console.log('🔥🔥🔥 ADL WAS TRIGGERED! 🔥🔥🔥\n');
        }

        // Refund traders after PnL realization
        await new Promise(r => setTimeout(r, 1000));
        await refundAllTraders(userAta.address);

        // Increment trade count to avoid retriggering
        tradeCount++;
        continue;
      }

      // Check if it's time for a bank run
      if (tradeCount > 0 && tradeCount % BANK_RUN_INTERVAL === 0) {
        bankRunCount++;
        console.log(`\n[${new Date().toISOString()}] === BANK RUN #${bankRunCount} (after ${tradeCount} trades) ===\n`);

        // Top up traders before bank run to avoid fee-drained accounts
        await topUpTradersIfNeeded(userAta.address);

        const result = await simulateBankRun(userAta.address);

        // Wait a bit then refund
        await new Promise(r => setTimeout(r, 2000));
        await refundAllTraders(userAta.address);

        console.log(`Bank run stats: ${result.success} withdrawals, ${Number(result.totalWithdrawn)/1e9} SOL withdrawn\n`);

        // Increment trade count to avoid retriggering
        tradeCount++;
        continue;
      }

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

      tradeCount++;
      console.log(`[${new Date().toISOString()}] Trade #${tradeCount}: Trader ${traderIdx} going ${direction} via LP ${bestLp.index}...`);

      await executeTrade(traderIdx, isLong, bestLp);
      console.log(`  ✓ Trade executed successfully (LP ${bestLp.index})`);

      // Fetch and show position
      const postSlabData = await fetchSlab(connection, SLAB);
      const postAccount = parseAccount(postSlabData, traderIdx);
      if (postAccount) {
        console.log(`  Position: ${postAccount.positionSize}, Capital: ${Number(postAccount.capital) / 1e9} SOL`);
      }

      const failRate = tradeCount > 0 ? ((failCount / tradeCount) * 100).toFixed(0) : '0';
      console.log(`  Total: ${tradeCount} trades, ${failRate}% fail, ${bankRunCount} bank runs, ${pnlRealizationCount} PnL realizations\n`);
    } catch (err: any) {
      failCount++;
      tradeCount++;
      const failRate = tradeCount > 0 ? ((failCount / tradeCount) * 100).toFixed(0) : '0';
      console.error(`  ✗ Trade failed: ${err.message}`);
      console.log(`  Total: ${tradeCount} trades, ${failRate}% fail, ${bankRunCount} bank runs, ${pnlRealizationCount} PnL realizations\n`);
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
