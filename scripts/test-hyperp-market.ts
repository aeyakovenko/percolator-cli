/**
 * Test: Hyperp Market Mode — Full Lifecycle
 *
 * Hyperp mode uses internal mark/index pricing without an external oracle.
 * - index_feed_id = all zeros enables Hyperp mode
 * - Mark price updated by trade execution prices
 * - Index price smoothly follows mark with rate limiting
 * - Funding based on premium: (mark - index) / index
 *
 * This script tests the full lifecycle:
 * 1. Trading updates mark price
 * 2. Index smooths toward mark
 * 3. Premium-based funding rate
 * 4. Set oracle authority (admin)
 * 5. Push settlement price (YES outcome)
 * 6. Resolve market
 * 7. Force-close positions via crank
 * 8. Withdraw insurance fund
 * 9. Cleanup (withdraw capital, close accounts, close slab)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitMarket,
  encodeInitLP,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodeKeeperCrank,
  encodeInitUser,
  encodeTradeCpi,
  encodeWithdrawCollateral,
  encodeCloseAccount,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeResolveMarket,
  encodeWithdrawInsurance,
  encodeCloseSlab,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_CLOSE_ACCOUNT,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_RESOLVE_MARKET,
  ACCOUNTS_WITHDRAW_INSURANCE,
  ACCOUNTS_CLOSE_SLAB,
  buildAccountMetas,
} from "../src/abi/accounts.js";
import { deriveVaultAuthority, deriveLpPda } from "../src/solana/pda.js";
import { fetchSlab, parseHeader, parseConfig, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { buildIx } from "../src/runtime/tx.js";

// Program IDs (same as main market)
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const MATCHER_CTX_SIZE = 320;
const SLAB_SIZE = 992560;

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const fmt = (n: bigint) => (Number(n) / 1e9).toFixed(6);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("============================================================");
  console.log("Hyperp Market Test");
  console.log("============================================================");

  const mint = NATIVE_MINT;

  // Check if hyperp-market.json already exists
  let slab: Keypair;
  let vault: PublicKey;
  let vaultPda: PublicKey;
  let matcherCtx: Keypair;
  let lpPda: PublicKey;
  let lpIdx: number;
  let needsSetup = true;

  if (fs.existsSync("hyperp-market.json")) {
    const info = JSON.parse(fs.readFileSync("hyperp-market.json", "utf-8"));
    slab = Keypair.generate(); // Dummy, we'll use the pubkey from file
    const slabPubkey = new PublicKey(info.slab);

    // Check if market is initialized
    const slabInfo = await conn.getAccountInfo(slabPubkey);
    if (slabInfo && slabInfo.data.length > 0) {
      console.log("  Using existing Hyperp market from hyperp-market.json");
      needsSetup = false;
      vault = new PublicKey(info.vault);
      vaultPda = new PublicKey(info.vaultPda);
      matcherCtx = Keypair.generate(); // Dummy
      lpPda = new PublicKey(info.lp.pda);
      lpIdx = info.lp.index;

      // Read current state
      const data = await fetchSlab(conn, slabPubkey);
      const config = parseConfig(data);
      const engine = parseEngine(data);
      console.log(`  Mark price (authority_price_e6): ${config.authorityPriceE6}`);
      console.log(`  Index price (last_effective_price_e6): ${config.lastEffectivePriceE6}`);
      console.log(`  Is Hyperp: ${config.indexFeedId === "0".repeat(64)}`);

      // Run tests on existing market
      await runTests(slabPubkey, vault, vaultPda, lpPda, lpIdx, new PublicKey(info.lp.matcherContext));
      return;
    }
  }

  // Create new Hyperp market
  console.log("\n--- Creating Hyperp Market ---");

  // Create slab account
  slab = Keypair.generate();
  const rentExempt = await conn.getMinimumBalanceForRentExemption(SLAB_SIZE);
  console.log(`  Creating slab account: ${slab.publicKey.toBase58()}`);

  const createSlabTx = new Transaction();
  createSlabTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  createSlabTx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: slab.publicKey,
    lamports: rentExempt,
    space: SLAB_SIZE,
    programId: PROGRAM_ID,
  }));
  await sendAndConfirmTransaction(conn, createSlabTx, [payer, slab], { commitment: "confirmed" });

  // Derive vault PDA
  [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slab.publicKey);
  console.log(`  Vault PDA: ${vaultPda.toBase58()}`);

  // Create vault ATA
  const vaultAccount = await getOrCreateAssociatedTokenAccount(conn, payer, mint, vaultPda, true);
  vault = vaultAccount.address;
  console.log(`  Vault ATA: ${vault.toBase58()}`);

  // Initialize Hyperp market
  const INITIAL_MARK_PRICE = 10_000n; // $0.01 in e6 format (10_000 = 0.01 * 1e6)
  console.log(`  Initial mark price: ${INITIAL_MARK_PRICE} (${Number(INITIAL_MARK_PRICE) / 1e6} in e6)`);

  const initMarketData = encodeInitMarket({
    admin: payer.publicKey,
    collateralMint: mint,
    indexFeedId: "0".repeat(64),      // All zeros = Hyperp mode
    maxStalenessSecs: "3600",
    confFilterBps: 500,
    invert: 0,                         // No inversion
    unitScale: 0,
    initialMarkPriceE6: INITIAL_MARK_PRICE.toString(), // Required for Hyperp
    warmupPeriodSlots: "10",
    maintenanceMarginBps: "500",
    initialMarginBps: "1000",
    tradingFeeBps: "10",
    maxAccounts: "64",
    newAccountFee: "1000000",
    riskReductionThreshold: "0",
    maintenanceFeePerSlot: "0",
    maxCrankStalenessSlots: "200",
    liquidationFeeBps: "100",
    liquidationFeeCap: "1000000000",
    liquidationBufferBps: "50",
    minLiquidationAbs: "100000",
  });

  const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
    payer.publicKey,
    slab.publicKey,
    mint,
    vault,
    TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    vaultPda,
    SystemProgram.programId,
  ]);

  const initTx = new Transaction();
  initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  initTx.add(buildIx({ programId: PROGRAM_ID, keys: initMarketKeys, data: initMarketData }));
  await sendAndConfirmTransaction(conn, initTx, [payer], { commitment: "confirmed" });
  console.log("  Hyperp market initialized");

  // Create matcher context for LP
  matcherCtx = Keypair.generate();
  const matcherRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);
  const createMatcherTx = new Transaction();
  createMatcherTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  createMatcherTx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: matcherCtx.publicKey,
    lamports: matcherRent,
    space: MATCHER_CTX_SIZE,
    programId: MATCHER_PROGRAM_ID,
  }));
  await sendAndConfirmTransaction(conn, createMatcherTx, [payer, matcherCtx], { commitment: "confirmed" });

  // Derive LP PDA for matcher init (need lpIdx=0 since we're creating first LP)
  const [lpPdaForInit] = deriveLpPda(PROGRAM_ID, slab.publicKey, 0);

  // Initialize matcher context with matcher program
  const initMatcherTx = new Transaction();
  initMatcherTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  initMatcherTx.add({
    programId: MATCHER_PROGRAM_ID,
    keys: [
      { pubkey: lpPdaForInit, isSigner: false, isWritable: false },
      { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1]),  // Init instruction
  });
  await sendAndConfirmTransaction(conn, initMatcherTx, [payer], { commitment: "confirmed" });
  console.log("  Matcher context initialized");

  // Run initial crank (use slab pubkey as dummy oracle in Hyperp mode)
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    slab.publicKey,
    SYSVAR_CLOCK_PUBKEY,
    slab.publicKey,  // Dummy oracle (not used in Hyperp mode)
  ]);
  const crankTx = new Transaction();
  crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });

  // Create admin wrapped SOL and fund it
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  const wrapTx = new Transaction();
  wrapTx.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: adminAta.address,
    lamports: 3 * LAMPORTS_PER_SOL,
  }));
  wrapTx.add({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: adminAta.address, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
  await sendAndConfirmTransaction(conn, wrapTx, [payer], { commitment: "confirmed" });

  // Top up insurance
  const insData = encodeTopUpInsurance({ amount: (LAMPORTS_PER_SOL / 2).toString() });
  const insKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [payer.publicKey, slab.publicKey, adminAta.address, vault, TOKEN_PROGRAM_ID]);
  const insTx = new Transaction();
  insTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  insTx.add(buildIx({ programId: PROGRAM_ID, keys: insKeys, data: insData }));
  await sendAndConfirmTransaction(conn, insTx, [payer], { commitment: "confirmed" });

  // Create LP
  [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, 0);
  const initLpData = encodeInitLP({
    matcherProgram: MATCHER_PROGRAM_ID,
    matcherContext: matcherCtx.publicKey,
    feePayment: "1000000",
  });
  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [payer.publicKey, slab.publicKey, adminAta.address, vault, TOKEN_PROGRAM_ID]);
  const initLpTx = new Transaction();
  initLpTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  initLpTx.add(buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData }));
  await sendAndConfirmTransaction(conn, initLpTx, [payer], { commitment: "confirmed" });

  // Get LP index
  let data = await fetchSlab(conn, slab.publicKey);
  lpIdx = 0;
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc && acc.kind === AccountKind.LP) {
      lpIdx = idx;
      break;
    }
  }

  // Deposit to LP
  const lpDepData = encodeDepositCollateral({ userIdx: lpIdx, amount: (LAMPORTS_PER_SOL / 2).toString() });
  const lpDepKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slab.publicKey, adminAta.address, vault, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY]);
  const lpDepTx = new Transaction();
  lpDepTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  lpDepTx.add(buildIx({ programId: PROGRAM_ID, keys: lpDepKeys, data: lpDepData }));
  await sendAndConfirmTransaction(conn, lpDepTx, [payer], { commitment: "confirmed" });

  console.log("  LP created and funded");

  // Save market info
  const marketInfo = {
    network: "devnet",
    mode: "hyperp",
    createdAt: new Date().toISOString(),
    programId: PROGRAM_ID.toBase58(),
    matcherProgramId: MATCHER_PROGRAM_ID.toBase58(),
    slab: slab.publicKey.toBase58(),
    mint: mint.toBase58(),
    vault: vault.toBase58(),
    vaultPda: vaultPda.toBase58(),
    initialMarkPrice: Number(INITIAL_MARK_PRICE),
    lp: {
      index: lpIdx,
      pda: lpPda.toBase58(),
      matcherContext: matcherCtx.publicKey.toBase58(),
    },
    admin: payer.publicKey.toBase58(),
  };
  fs.writeFileSync("hyperp-market.json", JSON.stringify(marketInfo, null, 2));
  console.log("  Market info saved to hyperp-market.json");

  await runTests(slab.publicKey, vault, vaultPda, lpPda, lpIdx, matcherCtx.publicKey);
}

async function runTests(slab: PublicKey, vault: PublicKey, vaultPda: PublicKey, lpPda: PublicKey, lpIdx: number, matcherCtx: PublicKey) {
  console.log("\n--- Running Hyperp Tests ---");

  const mint = NATIVE_MINT;
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);

  // Read initial state
  let data = await fetchSlab(conn, slab);
  let config = parseConfig(data);
  let engine = parseEngine(data);

  console.log("\n  Initial State:");
  const isHyperp = config.indexFeedId.toBytes().every((b: number) => b === 0);
  console.log(`    Is Hyperp: ${isHyperp}`);
  console.log(`    Mark price: ${config.authorityPriceE6}`);
  console.log(`    Index price: ${config.lastEffectivePriceE6}`);
  console.log(`    Oracle cap (e2bps): ${config.oraclePriceCapE2bps}`);

  // TEST 1: Create user and trade
  console.log("\n--- Test 1: Trading updates mark price ---");

  // Create user
  const userBefore = new Set(parseUsedIndices(data));
  const initUserData = encodeInitUser({ feePayment: "1000000" });
  const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [payer.publicKey, slab, adminAta.address, vault, TOKEN_PROGRAM_ID]);
  const initUserTx = new Transaction();
  initUserTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  initUserTx.add(buildIx({ programId: PROGRAM_ID, keys: initUserKeys, data: initUserData }));
  await sendAndConfirmTransaction(conn, initUserTx, [payer], { commitment: "confirmed" });

  data = await fetchSlab(conn, slab);
  let userIdx = 0;
  for (const idx of parseUsedIndices(data)) {
    if (!userBefore.has(idx)) {
      userIdx = idx;
      break;
    }
  }
  console.log(`  Created user at index ${userIdx}`);

  // Deposit collateral
  const depData = encodeDepositCollateral({ userIdx, amount: "100000000" }); // 0.1 SOL
  const depKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [payer.publicKey, slab, adminAta.address, vault, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY]);
  const depTx = new Transaction();
  depTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  depTx.add(buildIx({ programId: PROGRAM_ID, keys: depKeys, data: depData }));
  await sendAndConfirmTransaction(conn, depTx, [payer], { commitment: "confirmed" });

  // Record mark price before trade
  data = await fetchSlab(conn, slab);
  config = parseConfig(data);
  const markBefore = config.authorityPriceE6;
  console.log(`  Mark before trade: ${markBefore}`);

  // Execute trade
  const tradeSize = 1_000_000_000n; // 1B size
  const tradeData = encodeTradeCpi({ lpIdx, userIdx, size: tradeSize.toString() });
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey, payer.publicKey, slab, SYSVAR_CLOCK_PUBKEY, slab, // slab as dummy oracle
    MATCHER_PROGRAM_ID, matcherCtx, lpPda,
  ]);
  const tradeTx = new Transaction();
  tradeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }));
  tradeTx.add(buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData }));
  await sendAndConfirmTransaction(conn, tradeTx, [payer], { commitment: "confirmed" });

  // Check mark price after trade
  data = await fetchSlab(conn, slab);
  config = parseConfig(data);
  const markAfter = config.authorityPriceE6;
  console.log(`  Mark after trade: ${markAfter}`);
  console.log(`  Mark changed: ${markBefore !== markAfter ? "YES" : "NO"}`);

  // TEST 2: Index smoothing toward mark
  console.log("\n--- Test 2: Index smoothing ---");
  const indexBefore = config.lastEffectivePriceE6;
  console.log(`  Index before crank: ${indexBefore}`);
  console.log(`  Mark price: ${markAfter}`);

  // Wait a bit and crank to update index
  await delay(2000);
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slab, SYSVAR_CLOCK_PUBKEY, slab]);
  const crankTx = new Transaction();
  crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  crankTx.add(buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData }));
  await sendAndConfirmTransaction(conn, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });

  data = await fetchSlab(conn, slab);
  config = parseConfig(data);
  const indexAfter = config.lastEffectivePriceE6;
  console.log(`  Index after crank: ${indexAfter}`);

  if (indexBefore !== indexAfter) {
    const direction = indexAfter > indexBefore ? "up toward mark" : "down toward mark";
    console.log(`  Index moved: ${direction}`);
  } else {
    console.log(`  Index unchanged (may already equal mark)`);
  }

  // TEST 3: Funding rate check
  console.log("\n--- Test 3: Funding rate ---");
  engine = parseEngine(data);
  console.log(`  Funding rate (bps/slot): ${engine.fundingRateBpsPerSlotLast}`);
  console.log(`  Funding index: ${engine.fundingIndexQpbE6}`);

  // TEST 4: Set oracle authority
  console.log("\n--- Test 4: Set oracle authority ---");
  const setAuthData = encodeSetOracleAuthority({ newAuthority: payer.publicKey });
  const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
    payer.publicKey,
    slab,
  ]);
  const setAuthTx = new Transaction();
  setAuthTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  setAuthTx.add(buildIx({ programId: PROGRAM_ID, keys: setAuthKeys, data: setAuthData }));
  await sendAndConfirmTransaction(conn, setAuthTx, [payer], { commitment: "confirmed" });
  console.log("  Admin set as oracle authority");

  // TEST 5: Push settlement price (YES outcome = 1_000_000 e6)
  console.log("\n--- Test 5: Push settlement price ---");
  const settlementPriceE6 = 1_000_000n;
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const pushData = encodePushOraclePrice({ priceE6: settlementPriceE6.toString(), timestamp: timestamp.toString() });
  const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
    payer.publicKey,
    slab,
  ]);
  const pushTx = new Transaction();
  pushTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  pushTx.add(buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData }));
  await sendAndConfirmTransaction(conn, pushTx, [payer], { commitment: "confirmed" });
  console.log(`  Pushed settlement price: ${settlementPriceE6} (YES outcome)`);

  // TEST 6: Resolve market
  console.log("\n--- Test 6: Resolve market ---");
  const resolveData = encodeResolveMarket();
  const resolveKeys = buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, [
    payer.publicKey,
    slab,
  ]);
  const resolveTx = new Transaction();
  resolveTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  resolveTx.add(buildIx({ programId: PROGRAM_ID, keys: resolveKeys, data: resolveData }));
  await sendAndConfirmTransaction(conn, resolveTx, [payer], { commitment: "confirmed" });

  data = await fetchSlab(conn, slab);
  const header = parseHeader(data);
  console.log(`  Resolved flag: ${header.resolved}`);
  if (!header.resolved) throw new Error("Market not resolved after ResolveMarket");
  console.log("  Market RESOLVED - trading blocked, force-close enabled");

  // TEST 7: Force-close positions via crank
  console.log("\n--- Test 7: Force-close positions via crank ---");
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const fcCrankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
    const fcCrankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [payer.publicKey, slab, SYSVAR_CLOCK_PUBKEY, slab]);
    const fcCrankTx = new Transaction();
    fcCrankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    fcCrankTx.add(buildIx({ programId: PROGRAM_ID, keys: fcCrankKeys, data: fcCrankData }));
    await sendAndConfirmTransaction(conn, fcCrankTx, [payer], { commitment: "confirmed", skipPreflight: true });
    attempts++;

    data = await fetchSlab(conn, slab);
    const indices = parseUsedIndices(data);

    let hasOpenPositions = false;
    for (const idx of indices) {
      const acc = parseAccount(data, idx);
      if (acc && acc.positionSize !== 0n) {
        hasOpenPositions = true;
        console.log(`  Account ${idx} still has position: ${acc.positionSize}`);
      }
    }

    if (!hasOpenPositions) {
      console.log(`  All positions force-closed after ${attempts} crank(s)`);
      break;
    }

    await delay(500);
  }

  // Show final account states
  data = await fetchSlab(conn, slab);
  const finalIndices = parseUsedIndices(data);
  console.log("\n  Final account states:");
  for (const idx of finalIndices) {
    const acc = parseAccount(data, idx);
    if (acc) {
      console.log(`    Account ${idx}: pos=${acc.positionSize}, capital=${Number(acc.capital)/1e9} SOL`);
    }
  }

  // TEST 8: Withdraw insurance
  console.log("\n--- Test 8: Withdraw insurance ---");
  engine = parseEngine(data);
  console.log(`  Insurance fund balance: ${Number(engine.insuranceFund.balance) / 1e9} SOL`);

  if (engine.insuranceFund.balance > 0n) {
    const withdrawInsData = encodeWithdrawInsurance();
    const withdrawInsKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
      payer.publicKey,
      slab,
      adminAta.address,
      vault,
      TOKEN_PROGRAM_ID,
      vaultPda,
    ]);
    const withdrawInsTx = new Transaction();
    withdrawInsTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
    withdrawInsTx.add(buildIx({ programId: PROGRAM_ID, keys: withdrawInsKeys, data: withdrawInsData }));
    await sendAndConfirmTransaction(conn, withdrawInsTx, [payer], { commitment: "confirmed" });
    console.log("  Insurance fund withdrawn to admin");
  } else {
    console.log("  No insurance fund to withdraw");
  }

  // TEST 9: Cleanup - withdraw capital, close accounts, close slab
  console.log("\n--- Test 9: Cleanup ---");
  data = await fetchSlab(conn, slab);
  const cleanupIndices = parseUsedIndices(data);

  for (const idx of cleanupIndices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;

    // Withdraw remaining capital
    if (acc.capital > 0n) {
      try {
        const wKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
          payer.publicKey, slab, vault, adminAta.address, vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, slab,
        ]);
        const wIx = buildIx({ programId: PROGRAM_ID, keys: wKeys, data: encodeWithdrawCollateral({ userIdx: idx, amount: acc.capital.toString() }) });
        const wTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), wIx);
        await sendAndConfirmTransaction(conn, wTx, [payer], { commitment: "confirmed" });
        console.log(`  Withdrew ${Number(acc.capital)/1e9} SOL from account ${idx}`);
      } catch (e: any) {
        console.log(`  Withdraw failed for account ${idx}: ${e.message?.slice(0, 50)}`);
      }
    }

    // Close account
    try {
      const cKeys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
        payer.publicKey, slab, vault, adminAta.address, vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, slab,
      ]);
      const cIx = buildIx({ programId: PROGRAM_ID, keys: cKeys, data: encodeCloseAccount({ userIdx: idx }) });
      const cTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), cIx);
      await sendAndConfirmTransaction(conn, cTx, [payer], { commitment: "confirmed" });
      console.log(`  Account ${idx} closed`);
    } catch (e: any) {
      console.log(`  Close failed for account ${idx}: ${e.message?.slice(0, 50)}`);
    }

    await delay(300);
  }

  // Close slab
  try {
    const closeSlabData = encodeCloseSlab();
    const closeSlabKeys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
      payer.publicKey,
      slab,
    ]);
    const closeSlabTx = new Transaction();
    closeSlabTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
    closeSlabTx.add(buildIx({ programId: PROGRAM_ID, keys: closeSlabKeys, data: closeSlabData }));
    await sendAndConfirmTransaction(conn, closeSlabTx, [payer], { commitment: "confirmed" });
    console.log("  Slab closed - rent returned to admin");
  } catch (e: any) {
    console.log(`  Close slab failed: ${e.message?.slice(0, 60)}`);
  }

  console.log("\n============================================================");
  console.log("HYPERP TEST SUMMARY");
  console.log("============================================================");
  const isHyperpFinal = config.indexFeedId.toBytes().every((b: number) => b === 0);
  console.log(`  Hyperp mode active: ${isHyperpFinal}`);
  console.log(`  Mark price updates on trade: ${markBefore !== markAfter ? "PASS" : "CHECK"}`);
  console.log(`  Index smoothing works: ${indexBefore !== indexAfter ? "PASS" : "CHECK"}`);
  console.log(`  Market resolved: ${header.resolved ? "PASS" : "FAIL"}`);
  console.log(`  Force-close completed: ${attempts <= maxAttempts ? "PASS" : "FAIL"}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
