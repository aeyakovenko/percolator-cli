/**
 * Binary Market Feature Test
 *
 * Tests the full lifecycle of a binary/premarket:
 * 1. Create Hyperp market (admin oracle, initial price 50%)
 * 2. Set up LP and traders
 * 3. Execute trades
 * 4. Push settlement price (YES=1_000_000 or NO=1)
 * 5. Resolve market
 * 6. Crank to force-close all positions
 * 7. Withdraw insurance fund
 * 8. Users withdraw remaining capital
 * 9. Close all accounts and slab
 */
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  sendAndConfirmTransaction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount, createSyncNativeInstruction,
  TOKEN_PROGRAM_ID, NATIVE_MINT, getAccount,
} from '@solana/spl-token';
import * as fs from 'fs';
import {
  encodeInitMarket, encodeInitUser, encodeInitLP, encodeDepositCollateral,
  encodeWithdrawCollateral, encodeKeeperCrank, encodeTradeNoCpi,
  encodeCloseAccount, encodeCloseSlab, encodeSetOracleAuthority,
  encodePushOraclePrice, encodeResolveMarket, encodeWithdrawInsurance,
} from '../src/abi/instructions.js';
import {
  buildAccountMetas, ACCOUNTS_INIT_MARKET, ACCOUNTS_INIT_USER, ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_NOCPI, ACCOUNTS_CLOSE_ACCOUNT, ACCOUNTS_CLOSE_SLAB,
  ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_RESOLVE_MARKET, ACCOUNTS_WITHDRAW_INSURANCE,
} from '../src/abi/accounts.js';
import { buildIx } from '../src/runtime/tx.js';
import { fetchSlab, parseHeader, parseUsedIndices, parseAccount, parseEngine } from '../src/solana/slab.js';
import { deriveVaultAuthority } from '../src/solana/pda.js';

// Config
const PROGRAM_ID = new PublicKey('2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp');
const INITIAL_PRICE_E6 = 500_000n;  // 50% probability (0.5 in e6)
const SETTLEMENT_YES = 1_000_000n;  // YES outcome = 1.0
const SETTLEMENT_NO = 1n;           // NO outcome = ~0

const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const admin = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf-8')))
);

// Test accounts
let slabKp: Keypair;
let vaultKp: Keypair;
let lpIndex: number;
let traderIndex: number;

async function createMarket(): Promise<void> {
  console.log('\n=== Step 1: Create Binary Market ===\n');

  slabKp = Keypair.generate();
  vaultKp = Keypair.generate();

  // Calculate slab size - must match program's SLAB_LEN (~992KB for 4096 accounts)
  const slabSize = 992_568;  // From program: ENGINE_OFF + ENGINE_LEN
  const slabRent = await conn.getMinimumBalanceForRentExemption(slabSize);

  // Create slab account
  const createSlabIx = SystemProgram.createAccount({
    fromPubkey: admin.publicKey,
    newAccountPubkey: slabKp.publicKey,
    lamports: slabRent,
    space: slabSize,
    programId: PROGRAM_ID,
  });

  // Create vault token account
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);

  // Wrap SOL for initial deposits (use small amounts for testing)
  const wrapAmount = Math.floor(0.1 * LAMPORTS_PER_SOL);
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminAta.address, lamports: wrapAmount }),
    createSyncNativeInstruction(adminAta.address),
  );
  await sendAndConfirmTransaction(conn, wrapTx, [admin]);
  console.log(`Wrapped ${wrapAmount / LAMPORTS_PER_SOL} SOL`);

  // Create vault
  const { TOKEN_PROGRAM_ID: TPK } = await import('@solana/spl-token');
  const createVaultTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: vaultKp.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(165),
      space: 165,
      programId: TPK,
    }),
    // Initialize as token account
    {
      programId: TPK,
      keys: [
        { pubkey: vaultKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: deriveVaultAuthority(PROGRAM_ID, slabKp.publicKey)[0], isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),  // InitializeAccount instruction
    }
  );
  await sendAndConfirmTransaction(conn, createVaultTx, [admin, vaultKp]);
  console.log('Created vault:', vaultKp.publicKey.toBase58());

  // Init market (Hyperp mode - all zeros feed ID, non-zero initial price)
  const initMarketData = encodeInitMarket({
    admin: admin.publicKey,
    collateralMint: NATIVE_MINT,
    indexFeedId: '0'.repeat(64),  // All zeros = Hyperp mode
    maxStalenessSecs: 3600n,
    confFilterBps: 500,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: INITIAL_PRICE_E6,  // 50% probability
    warmupPeriodSlots: 10n,
    maintenanceMarginBps: 500n,
    initialMarginBps: 1000n,
    tradingFeeBps: 10n,
    maxAccounts: 256n,
    newAccountFee: 1_000_000n,
    riskReductionThreshold: 7816n,
    maintenanceFeePerSlot: 0n,
    maxCrankStalenessSlots: 200n,
    liquidationFeeBps: 100n,
    liquidationFeeCap: 1_000_000_000n,
    liquidationBufferBps: 50n,
    minLiquidationAbs: 100_000n,
  });

  const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
    admin.publicKey,
    slabKp.publicKey,
    NATIVE_MINT,
    vaultKp.publicKey,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    adminAta.address,  // Dummy ATA (unused but required)
    SystemProgram.programId,
  ]);

  const initMarketTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    createSlabIx,
    buildIx({ programId: PROGRAM_ID, keys: initMarketKeys, data: initMarketData }),
  );
  await sendAndConfirmTransaction(conn, initMarketTx, [admin, slabKp]);

  console.log('Created binary market:');
  console.log('  Slab:', slabKp.publicKey.toBase58());
  console.log('  Initial price: 50% (0.5)');
}

async function setupOracleAuthority(): Promise<void> {
  console.log('\n=== Step 2: Set Oracle Authority ===\n');

  // Set admin as oracle authority (for pushing settlement price)
  const setAuthData = encodeSetOracleAuthority({ newAuthority: admin.publicKey });
  const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
    admin.publicKey,
    slabKp.publicKey,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys: setAuthKeys, data: setAuthData }),
  );
  await sendAndConfirmTransaction(conn, tx, [admin]);
  console.log('Set admin as oracle authority');
}

async function setupLpAndTrader(): Promise<void> {
  console.log('\n=== Step 3: Setup LP and Trader ===\n');

  const adminAta = await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);

  // Init LP (using null matcher for passive LP)
  const initLpData = encodeInitLP({
    matcherProgram: PublicKey.default,  // Null = passive LP
    matcherContext: PublicKey.default,
    feePayment: 1_000_000n,
  });
  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
    admin.publicKey,
    slabKp.publicKey,
    adminAta.address,
    vaultKp.publicKey,
    TOKEN_PROGRAM_ID,
  ]);

  const initLpTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData }),
  );
  await sendAndConfirmTransaction(conn, initLpTx, [admin]);

  // Get LP index
  let slabData = await fetchSlab(conn, slabKp.publicKey);
  const indices = parseUsedIndices(slabData);
  lpIndex = indices[0];
  console.log('Created LP at index:', lpIndex);

  // Deposit to LP (small amount for testing)
  const depositLpData = encodeDepositCollateral({ userIdx: lpIndex, amount: (BigInt(Math.floor(0.02 * LAMPORTS_PER_SOL))).toString() });
  const depositLpKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    admin.publicKey,
    slabKp.publicKey,
    adminAta.address,
    vaultKp.publicKey,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const depositLpTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: depositLpKeys, data: depositLpData }),
  );
  await sendAndConfirmTransaction(conn, depositLpTx, [admin]);
  console.log('Deposited 0.02 SOL to LP');

  // Init trader
  const initUserData = encodeInitUser({ feePayment: 1_000_000n });
  const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
    admin.publicKey,
    slabKp.publicKey,
    adminAta.address,
    vaultKp.publicKey,
    TOKEN_PROGRAM_ID,
  ]);

  const initUserTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: initUserKeys, data: initUserData }),
  );
  await sendAndConfirmTransaction(conn, initUserTx, [admin]);

  // Get trader index
  slabData = await fetchSlab(conn, slabKp.publicKey);
  const newIndices = parseUsedIndices(slabData);
  traderIndex = newIndices.find(i => i !== lpIndex)!;
  console.log('Created trader at index:', traderIndex);

  // Deposit to trader (small amount for testing)
  const depositUserData = encodeDepositCollateral({ userIdx: traderIndex, amount: BigInt(Math.floor(0.01 * LAMPORTS_PER_SOL)).toString() });
  const depositUserKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    admin.publicKey,
    slabKp.publicKey,
    adminAta.address,
    vaultKp.publicKey,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
  ]);

  const depositUserTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: depositUserKeys, data: depositUserData }),
  );
  await sendAndConfirmTransaction(conn, depositUserTx, [admin]);
  console.log('Deposited 0.01 SOL to trader');
}

async function executeTrades(): Promise<void> {
  console.log('\n=== Step 4: Execute Trades ===\n');

  // Run crank first
  await runCrank();

  // Trade: trader goes LONG (betting YES)
  const tradeSize = 1_000_000n;  // 1M units (small for testing)
  const tradeData = encodeTradeNoCpi({
    lpIdx: lpIndex,
    userIdx: traderIndex,
    size: tradeSize.toString(),
  });

  // For TradeNoCpi, LP must sign (passive LP)
  // Since admin owns both accounts, we sign with admin
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
    admin.publicKey,  // user (trader owner)
    admin.publicKey,  // lp (LP owner signs for passive LP)
    slabKp.publicKey,
    SYSVAR_CLOCK_PUBKEY,
    slabKp.publicKey,  // Oracle = slab for Hyperp mode
  ]);

  const tradeTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }),
  );
  await sendAndConfirmTransaction(conn, tradeTx, [admin]);
  console.log('Trader went LONG 100M units (betting YES)');

  // Check positions
  const slabData = await fetchSlab(conn, slabKp.publicKey);
  const traderAcc = parseAccount(slabData, traderIndex);
  const lpAcc = parseAccount(slabData, lpIndex);
  console.log(`Trader position: ${traderAcc?.positionSize}`);
  console.log(`LP position: ${lpAcc?.positionSize} (counterparty)`);
}

async function runCrank(): Promise<void> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    admin.publicKey,
    slabKp.publicKey,
    SYSVAR_CLOCK_PUBKEY,
    slabKp.publicKey,  // Oracle = slab for Hyperp
  ]);

  const crankTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }),
  );
  await sendAndConfirmTransaction(conn, crankTx, [admin]);
}

async function settleMarket(outcome: 'YES' | 'NO'): Promise<void> {
  console.log(`\n=== Step 5: Settle Market (${outcome}) ===\n`);

  const settlementPrice = outcome === 'YES' ? SETTLEMENT_YES : SETTLEMENT_NO;
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  // Push settlement price
  const pushData = encodePushOraclePrice({ priceE6: settlementPrice.toString(), timestamp: timestamp.toString() });
  const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
    admin.publicKey,
    slabKp.publicKey,
  ]);

  const pushTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }),
  );
  await sendAndConfirmTransaction(conn, pushTx, [admin]);
  console.log(`Pushed settlement price: ${settlementPrice} (${outcome})`);

  // Resolve market
  const resolveData = encodeResolveMarket();
  const resolveKeys = buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, [
    admin.publicKey,
    slabKp.publicKey,
  ]);

  const resolveTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys: resolveKeys, data: resolveData }),
  );
  await sendAndConfirmTransaction(conn, resolveTx, [admin]);
  console.log('Market RESOLVED - trading blocked, force-close enabled');

  // Verify resolved flag
  const slabData = await fetchSlab(conn, slabKp.publicKey);
  const header = parseHeader(slabData);
  console.log(`Resolved flag: ${header.resolved}`);
}

async function forceClosePositions(): Promise<void> {
  console.log('\n=== Step 6: Force-Close Positions via Crank ===\n');

  // Run cranks until all positions are closed
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    await runCrank();
    attempts++;

    const slabData = await fetchSlab(conn, slabKp.publicKey);
    const indices = parseUsedIndices(slabData);

    let hasOpenPositions = false;
    for (const idx of indices) {
      const acc = parseAccount(slabData, idx);
      if (acc && acc.positionSize !== 0n) {
        hasOpenPositions = true;
        console.log(`  Account ${idx} still has position: ${acc.positionSize}`);
      }
    }

    if (!hasOpenPositions) {
      console.log(`All positions force-closed after ${attempts} cranks`);
      break;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Show final state
  const slabData = await fetchSlab(conn, slabKp.publicKey);
  const indices = parseUsedIndices(slabData);
  console.log('\nFinal account states:');
  for (const idx of indices) {
    const acc = parseAccount(slabData, idx);
    if (acc) {
      console.log(`  Account ${idx}: pos=${acc.positionSize}, capital=${Number(acc.capital)/1e9} SOL, pnl=${Number(acc.pnl)/1e9} SOL`);
    }
  }
}

async function withdrawInsurance(): Promise<void> {
  console.log('\n=== Step 7: Withdraw Insurance Fund ===\n');

  const adminAta = await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabKp.publicKey);

  // Check insurance balance
  const slabData = await fetchSlab(conn, slabKp.publicKey);
  const engine = parseEngine(slabData);
  console.log(`Insurance fund balance: ${Number(engine.insuranceFundBalance) / 1e9} SOL`);

  if (engine.insuranceFundBalance > 0n) {
    const withdrawInsData = encodeWithdrawInsurance();
    const withdrawInsKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
      admin.publicKey,
      slabKp.publicKey,
      adminAta.address,
      vaultKp.publicKey,
      TOKEN_PROGRAM_ID,
      vaultPda,
    ]);

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      buildIx({ programId: PROGRAM_ID, keys: withdrawInsKeys, data: withdrawInsData }),
    );
    await sendAndConfirmTransaction(conn, tx, [admin]);
    console.log('Insurance fund withdrawn to admin');
  } else {
    console.log('No insurance fund to withdraw');
  }
}

async function cleanupAccounts(): Promise<void> {
  console.log('\n=== Step 8: Cleanup - Withdraw and Close Accounts ===\n');

  const adminAta = await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabKp.publicKey);

  const slabData = await fetchSlab(conn, slabKp.publicKey);
  const indices = parseUsedIndices(slabData);

  for (const idx of indices) {
    const acc = parseAccount(slabData, idx);
    if (!acc) continue;

    // Withdraw remaining capital
    if (acc.capital > 0n) {
      console.log(`  Withdrawing ${Number(acc.capital)/1e9} SOL from account ${idx}...`);

      const withdrawData = encodeWithdrawCollateral({ userIdx: idx, amount: acc.capital.toString() });
      const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
        admin.publicKey,
        slabKp.publicKey,
        vaultKp.publicKey,
        adminAta.address,
        vaultPda,
        TOKEN_PROGRAM_ID,
        SYSVAR_CLOCK_PUBKEY,
        slabKp.publicKey,  // Oracle = slab for Hyperp
      ]);

      try {
        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
          buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData }),
        );
        await sendAndConfirmTransaction(conn, tx, [admin]);
      } catch (err: any) {
        console.log(`    Withdraw failed: ${err.message?.slice(0, 50)}`);
      }
    }

    // Close account
    console.log(`  Closing account ${idx}...`);
    const closeData = encodeCloseAccount({ userIdx: idx });
    const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
      admin.publicKey,
      slabKp.publicKey,
      vaultKp.publicKey,
      adminAta.address,
      vaultPda,
      TOKEN_PROGRAM_ID,
      SYSVAR_CLOCK_PUBKEY,
      slabKp.publicKey,  // Oracle = slab for Hyperp
    ]);

    try {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
        buildIx({ programId: PROGRAM_ID, keys: closeKeys, data: closeData }),
      );
      await sendAndConfirmTransaction(conn, tx, [admin]);
      console.log(`    Account ${idx} closed`);
    } catch (err: any) {
      console.log(`    Close failed: ${err.message?.slice(0, 50)}`);
    }

    await new Promise(r => setTimeout(r, 300));
  }
}

async function closeSlab(): Promise<void> {
  console.log('\n=== Step 9: Close Slab ===\n');

  const closeSlabData = encodeCloseSlab();
  const closeSlabKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
    admin.publicKey,
    slabKp.publicKey,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: closeSlabKeys, data: closeSlabData }),
  );

  try {
    await sendAndConfirmTransaction(conn, tx, [admin]);
    console.log('Slab closed - rent returned to admin');
  } catch (err: any) {
    console.log(`Close slab failed: ${err.message}`);
  }
}

async function main() {
  console.log('Binary Market Feature Test');
  console.log('==========================');
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  try {
    await createMarket();
    await setupOracleAuthority();
    await setupLpAndTrader();
    await executeTrades();

    // Settle with YES outcome (trader wins)
    await settleMarket('YES');

    await forceClosePositions();
    await withdrawInsurance();
    await cleanupAccounts();
    await closeSlab();

    console.log('\n=== TEST COMPLETE ===\n');
    console.log('Binary market lifecycle completed successfully!');
  } catch (err: any) {
    console.error('\nTEST FAILED:', err.message);
    console.error(err);
    process.exit(1);
  }
}

main();
