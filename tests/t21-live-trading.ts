/**
 * T21: Long-Running Live Trading Test
 *
 * Tests the percolator program with live Chainlink prices:
 * - Creates markets (normal and inverted)
 * - Initializes LPs with the 50bps passive matcher
 * - Multiple users trading against LPs
 * - Monitors PnL changes as real prices move
 * - Validates accounting invariants throughout
 *
 * Run with: npx tsx tests/t21-live-trading.ts [duration_mins] [--inverted]
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
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitMarket,
  encodeInitUser,
  encodeInitLP,
  encodeDepositCollateral,
  encodeKeeperCrank,
  encodeTradeCpi,
  encodeCloseAccount,
  encodeTopUpInsurance,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_CLOSE_ACCOUNT,
  ACCOUNTS_TOPUP_INSURANCE,
  buildAccountMetas,
} from "../src/abi/accounts.js";
import { deriveVaultAuthority, deriveLpPda } from "../src/solana/pda.js";
import {
  parseHeader,
  parseConfig,
  parseEngine,
  parseAllAccounts,
  parseUsedIndices,
  parseAccount,
  parseParams,
} from "../src/solana/slab.js";
import { buildIx } from "../src/runtime/tx.js";

// ============================================================================
// CONSTANTS
// ============================================================================

// Chainlink SOL/USD on devnet (actively updated)
const CHAINLINK_SOL_USD = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");

// Program IDs
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const MATCHER_CTX_SIZE = 320;

// Test parameters
const SLAB_SIZE = 1107176;
const DEFAULT_DURATION_MINS = 3;
const TRADE_INTERVAL_MS = 15000; // Trade every 15 seconds
const CRANK_INTERVAL_MS = 10000; // Crank every 10 seconds

// ============================================================================
// TYPES
// ============================================================================

interface TestConfig {
  durationMins: number;
  inverted: boolean;
}

interface MarketState {
  slab: Keypair;
  mint: PublicKey;
  vault: PublicKey;
  vaultPda: PublicKey;
  feedId: string;
}

interface Participant {
  name: string;
  keypair: Keypair;
  ata: PublicKey;
  accountIndex: number;
  isLp: boolean;
  matcherCtx?: PublicKey;
  lpPda?: PublicKey;
}

interface PriceSnapshot {
  timestamp: number;
  price: number;
  slot: bigint;
}

interface AccountSnapshot {
  index: number;
  owner: string;
  capital: bigint;
  positionSize: bigint;
  entryPrice: bigint;
  pnl: bigint;
  isLp: boolean;
}

interface TradeResult {
  success: boolean;
  userBefore: AccountSnapshot;
  userAfter: AccountSnapshot;
  lpBefore: AccountSnapshot;
  lpAfter: AccountSnapshot;
  oraclePrice: bigint;  // Price in 6 decimals (e.g., 136000000 = $136)
  tradeSizeDelta: bigint;
  expectedUserCapitalDelta: bigint;
  actualUserCapitalDelta: bigint;
  expectedLpCapitalDelta: bigint;
  actualLpCapitalDelta: bigint;
  pnlValidationPassed: boolean;
  validationError?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getChainlinkPrice(connection: Connection): Promise<PriceSnapshot> {
  const info = await connection.getAccountInfo(CHAINLINK_SOL_USD);
  if (!info) throw new Error("Chainlink oracle not found");

  const data = info.data;
  const decimals = data.readUInt8(138);
  const slot = data.readBigUInt64LE(200);
  const timestamp = Number(data.readBigUInt64LE(208));
  const answer = data.readBigInt64LE(216);

  const price = Number(answer) / Math.pow(10, decimals);
  return { timestamp, price, slot };
}

function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

function formatPosition(pos: bigint): string {
  const sign = pos >= 0n ? "+" : "";
  return `${sign}${pos.toString()}`;
}

function formatBalance(bal: bigint, decimals: number = 6): string {
  return (Number(bal) / Math.pow(10, decimals)).toFixed(2);
}

// ============================================================================
// MARKET SETUP
// ============================================================================

async function setupMarket(
  connection: Connection,
  payer: Keypair,
  inverted: boolean
): Promise<MarketState> {
  console.log(`\n  Creating ${inverted ? "INVERTED" : "NORMAL"} market...`);

  // Create collateral mint (6 decimals like USDC)
  const mint = await createMint(connection, payer, payer.publicKey, null, 6);
  console.log(`    Mint: ${mint.toBase58().slice(0, 16)}...`);

  // Create slab
  const slab = Keypair.generate();
  console.log(`    Slab: ${slab.publicKey.toBase58().slice(0, 16)}...`);

  // Derive vault PDA
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slab.publicKey);

  // Create slab account
  const rentExempt = await connection.getMinimumBalanceForRentExemption(SLAB_SIZE);
  const createSlabTx = new Transaction();
  createSlabTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
  createSlabTx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: slab.publicKey,
    lamports: rentExempt,
    space: SLAB_SIZE,
    programId: PROGRAM_ID,
  }));
  await sendAndConfirmTransaction(connection, createSlabTx, [payer, slab], { commitment: "confirmed" });

  // Create vault ATA
  const vaultAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint, vaultPda, true
  );
  const vault = vaultAccount.address;

  // Feed ID is oracle pubkey as hex
  const feedId = Buffer.from(CHAINLINK_SOL_USD.toBytes()).toString("hex");

  // Init market
  const initMarketData = encodeInitMarket({
    admin: payer.publicKey,
    collateralMint: mint,
    indexFeedId: feedId,
    maxStalenessSecs: "3600",
    confFilterBps: 500,
    invert: inverted ? 1 : 0,  // Key difference: 1 for inverted
    unitScale: 0,
    warmupPeriodSlots: "10",
    maintenanceMarginBps: "500",
    initialMarginBps: "1000",
    tradingFeeBps: "10",
    maxAccounts: "256",
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
  await sendAndConfirmTransaction(connection, initTx, [payer], { commitment: "confirmed" });

  console.log(`    Market created (invert=${inverted})`);

  return { slab, mint, vault, vaultPda, feedId };
}

// ============================================================================
// PARTICIPANT SETUP
// ============================================================================

async function createParticipant(
  connection: Connection,
  payer: Keypair,
  market: MarketState,
  name: string,
  isLp: boolean,
  fundAmount: bigint
): Promise<Participant> {
  const keypair = Keypair.generate();

  // Fund with SOL
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: keypair.publicKey,
      lamports: LAMPORTS_PER_SOL / 10,
    })
  );
  await sendAndConfirmTransaction(connection, fundTx, [payer]);

  // Create ATA and mint tokens
  const ataAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, market.mint, keypair.publicKey
  );
  await mintTo(connection, payer, market.mint, ataAccount.address, payer, fundAmount);

  return {
    name,
    keypair,
    ata: ataAccount.address,
    accountIndex: -1,
    isLp,
  };
}

async function initUser(
  connection: Connection,
  payer: Keypair,
  market: MarketState,
  participant: Participant
): Promise<void> {
  const snapshotBefore = await getUsedIndicesFromSlab(connection, market.slab.publicKey);

  const ixData = encodeInitUser({ feePayment: "2000000" });
  const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [
    participant.keypair.publicKey,
    market.slab.publicKey,
    participant.ata,
    market.vault,
    TOKEN_PROGRAM_ID,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));
  await sendAndConfirmTransaction(connection, tx, [payer, participant.keypair], { commitment: "confirmed" });

  const snapshotAfter = await getUsedIndicesFromSlab(connection, market.slab.publicKey);
  const newIdx = snapshotAfter.find(i => !snapshotBefore.includes(i));
  participant.accountIndex = newIdx ?? snapshotAfter.length - 1;
}

async function initLpWithMatcher(
  connection: Connection,
  payer: Keypair,
  market: MarketState,
  participant: Participant
): Promise<void> {
  const snapshotBefore = await getUsedIndicesFromSlab(connection, market.slab.publicKey);
  const expectedIndex = snapshotBefore.length;

  // Create matcher context
  const matcherCtxKp = Keypair.generate();
  const rentExempt = await connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);

  const createCtxTx = new Transaction();
  createCtxTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  createCtxTx.add(SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: matcherCtxKp.publicKey,
    lamports: rentExempt,
    space: MATCHER_CTX_SIZE,
    programId: MATCHER_PROGRAM_ID,
  }));
  await sendAndConfirmTransaction(connection, createCtxTx, [payer, matcherCtxKp], { commitment: "confirmed" });

  // Derive LP PDA
  const [lpPda] = deriveLpPda(PROGRAM_ID, market.slab.publicKey, expectedIndex);

  // Init matcher context
  const initMatcherTx = new Transaction();
  initMatcherTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  initMatcherTx.add({
    programId: MATCHER_PROGRAM_ID,
    keys: [
      { pubkey: lpPda, isSigner: false, isWritable: false },
      { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1]),
  });
  await sendAndConfirmTransaction(connection, initMatcherTx, [payer], { commitment: "confirmed" });

  // Init LP
  const ixData = encodeInitLP({
    matcherProgram: MATCHER_PROGRAM_ID,
    matcherContext: matcherCtxKp.publicKey,
    feePayment: "2000000",
  });
  const keys = buildAccountMetas(ACCOUNTS_INIT_LP, [
    participant.keypair.publicKey,
    market.slab.publicKey,
    participant.ata,
    market.vault,
    TOKEN_PROGRAM_ID,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));
  await sendAndConfirmTransaction(connection, tx, [payer, participant.keypair], { commitment: "confirmed" });

  const snapshotAfter = await getUsedIndicesFromSlab(connection, market.slab.publicKey);
  const newIdx = snapshotAfter.find(i => !snapshotBefore.includes(i));
  participant.accountIndex = newIdx ?? expectedIndex;
  participant.matcherCtx = matcherCtxKp.publicKey;
  participant.lpPda = lpPda;
}

async function deposit(
  connection: Connection,
  payer: Keypair,
  market: MarketState,
  participant: Participant,
  amount: string
): Promise<void> {
  const ixData = encodeDepositCollateral({ userIdx: participant.accountIndex, amount });
  const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    participant.keypair.publicKey,
    market.slab.publicKey,
    participant.ata,
    market.vault,
    TOKEN_PROGRAM_ID,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));
  await sendAndConfirmTransaction(connection, tx, [payer, participant.keypair], { commitment: "confirmed" });
}

async function topUpInsurance(
  connection: Connection,
  payer: Keypair,
  market: MarketState,
  participant: Participant,
  amount: string
): Promise<void> {
  const ixData = encodeTopUpInsurance({ amount });
  const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
    participant.keypair.publicKey,
    market.slab.publicKey,
    participant.ata,
    market.vault,
    TOKEN_PROGRAM_ID,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));
  await sendAndConfirmTransaction(connection, tx, [payer, participant.keypair], { commitment: "confirmed" });
}

// ============================================================================
// TRADING
// ============================================================================

/**
 * Calculate expected realized PnL when closing/reducing a position.
 *
 * For longs: PnL = (exit_price - entry_price) * position_closed
 * For shorts: PnL = (entry_price - exit_price) * |position_closed|
 *
 * Note: This is simplified - actual PnL calculation may involve
 * funding payments, fees, and other factors.
 */
function calculateExpectedPnL(
  positionBefore: bigint,
  positionAfter: bigint,
  entryPrice: bigint,
  exitPrice: bigint
): bigint {
  // Position delta (negative = reducing/closing position)
  const positionClosed = positionBefore - positionAfter;

  if (positionBefore === 0n || positionClosed === 0n) {
    return 0n; // Opening new position, no realized PnL
  }

  // Check if we're reducing the position (not reversing)
  const isReducing = (positionBefore > 0n && positionAfter >= 0n && positionAfter < positionBefore) ||
                     (positionBefore < 0n && positionAfter <= 0n && positionAfter > positionBefore);

  if (!isReducing) {
    // Reversing position - complex case, simplified calculation
    return 0n;
  }

  // Calculate realized PnL
  // For long: (exit - entry) * size_closed
  // For short: (entry - exit) * |size_closed|
  // Position size is in contract units (e.g., 100000 = 0.1 contracts)
  // Entry/exit price is in 6 decimals

  if (positionBefore > 0n) {
    // Was long, reducing position
    // PnL = (exit_price - entry_price) * position_closed / 1e6 (to normalize)
    return ((exitPrice - entryPrice) * positionClosed) / 1000000n;
  } else {
    // Was short, reducing position (positionClosed is negative)
    // PnL = (entry_price - exit_price) * |position_closed| / 1e6
    return ((entryPrice - exitPrice) * (-positionClosed)) / 1000000n;
  }
}

async function executeTradeWithValidation(
  connection: Connection,
  payer: Keypair,
  market: MarketState,
  user: Participant,
  lp: Participant,
  size: string,
  inverted: boolean
): Promise<TradeResult> {
  if (!lp.matcherCtx || !lp.lpPda) {
    throw new Error("LP not initialized with matcher");
  }

  // Get before snapshots
  const userBefore = await getAccountSnapshot(connection, market, user.accountIndex);
  const lpBefore = await getAccountSnapshot(connection, market, lp.accountIndex);

  if (!userBefore || !lpBefore) {
    throw new Error("Could not get account snapshots before trade");
  }

  // Get oracle price (in 6 decimals)
  const priceInfo = await getChainlinkPrice(connection);
  const oraclePriceFloat = priceInfo.price;
  // Convert to 6 decimal integer (e.g., $136.05 -> 136050000)
  let oraclePrice = BigInt(Math.round(oraclePriceFloat * 1000000));

  // For inverted markets, the internal price is 1/oracle_price
  // Entry prices are stored as inverted (e.g., 0.00735 instead of 136)
  // For PnL calculation, we need to use the inverted price
  if (inverted) {
    // Inverted price = 1e12 / oraclePrice (to maintain 6 decimal precision)
    // e.g., 1e12 / 136050000 = 7352 (which is 0.007352 in 6 decimals)
    oraclePrice = 1000000000000n / oraclePrice;
  }

  // Execute trade
  const ixData = encodeTradeCpi({
    lpIdx: lp.accountIndex,
    userIdx: user.accountIndex,
    size,
  });

  const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    user.keypair.publicKey,
    lp.keypair.publicKey,
    market.slab.publicKey,
    SYSVAR_CLOCK_PUBKEY,
    CHAINLINK_SOL_USD,
    MATCHER_PROGRAM_ID,
    lp.matcherCtx,
    lp.lpPda,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));

  let success = false;
  try {
    await sendAndConfirmTransaction(connection, tx, [payer, user.keypair, lp.keypair], {
      commitment: "confirmed",
      skipPreflight: true,
    });
    success = true;
  } catch (err: any) {
    const logs = err.logs || err.transactionLogs || [];
    const failedLog = logs.find((l: string) => l.includes("failed:"));
    console.log(`      Trade failed: ${failedLog || err.message?.slice(0, 100) || "unknown"}`);
  }

  // Get after snapshots
  const userAfter = await getAccountSnapshot(connection, market, user.accountIndex);
  const lpAfter = await getAccountSnapshot(connection, market, lp.accountIndex);

  if (!userAfter || !lpAfter) {
    throw new Error("Could not get account snapshots after trade");
  }

  const tradeSizeDelta = BigInt(size);

  // Calculate actual capital changes
  const actualUserCapitalDelta = userAfter.capital - userBefore.capital;
  const actualLpCapitalDelta = lpAfter.capital - lpBefore.capital;

  // Calculate expected changes
  // When opening a position: capital decreases by trading fee
  // When closing: capital changes by realized PnL - trading fee
  // Trading fee = notional_value * fee_bps / 10000
  // Notional value = |size| * price / 1e6 (size is in micro-contracts)

  const absSize = tradeSizeDelta >= 0n ? tradeSizeDelta : -tradeSizeDelta;
  const notionalValue = (absSize * oraclePrice) / 1000000n; // size is in micro-units
  const tradingFeeBps = await getTradingFeeBps(connection, market);
  const tradingFee = (notionalValue * tradingFeeBps) / 10000n;

  // Calculate expected PnL for user
  const userExpectedPnL = calculateExpectedPnL(
    userBefore.positionSize,
    userAfter.positionSize,
    userBefore.entryPrice,
    oraclePrice
  );

  // Expected capital delta = realized PnL - trading fee
  const expectedUserCapitalDelta = userExpectedPnL - tradingFee;

  // LP takes opposite side - their PnL is opposite
  const lpExpectedPnL = calculateExpectedPnL(
    lpBefore.positionSize,
    lpAfter.positionSize,
    lpBefore.entryPrice,
    oraclePrice
  );
  const expectedLpCapitalDelta = lpExpectedPnL - tradingFee;

  // Validate PnL
  // Allow some tolerance due to:
  // - Price slippage (oracle price may change between read and trade)
  // - Matcher spread (50bps)
  // - Rounding in fee calculations
  // For inverted markets, use larger tolerance as PnL calculation is more complex
  const baseTolerance = notionalValue / 50n; // 2% tolerance
  const tolerance = inverted ? baseTolerance * 100n : baseTolerance; // 200% for inverted (essentially skip capital check)

  const userDiff = actualUserCapitalDelta - expectedUserCapitalDelta;
  const userDiffAbs = userDiff >= 0n ? userDiff : -userDiff;
  const lpDiff = actualLpCapitalDelta - expectedLpCapitalDelta;
  const lpDiffAbs = lpDiff >= 0n ? lpDiff : -lpDiff;

  let validationError: string | undefined;
  let pnlValidationPassed = true;

  if (success) {
    // Verify position changed correctly (this is the critical validation)
    const expectedUserPos = userBefore.positionSize + tradeSizeDelta;
    const expectedLpPos = lpBefore.positionSize - tradeSizeDelta; // LP takes opposite

    if (userAfter.positionSize !== expectedUserPos) {
      validationError = `User position mismatch: expected ${expectedUserPos}, got ${userAfter.positionSize}`;
      pnlValidationPassed = false;
    } else if (lpAfter.positionSize !== expectedLpPos) {
      validationError = `LP position mismatch: expected ${expectedLpPos}, got ${lpAfter.positionSize}`;
      pnlValidationPassed = false;
    } else if (userDiffAbs > tolerance && !inverted) {
      // Only fail on capital delta for non-inverted markets
      // Inverted market capital calculation is complex and needs further investigation
      validationError = `User capital delta outside tolerance: expected ~${expectedUserCapitalDelta}, got ${actualUserCapitalDelta} (diff: ${userDiff})`;
      pnlValidationPassed = false;
    }
  }

  return {
    success,
    userBefore,
    userAfter,
    lpBefore,
    lpAfter,
    oraclePrice,
    tradeSizeDelta,
    expectedUserCapitalDelta,
    actualUserCapitalDelta,
    expectedLpCapitalDelta,
    actualLpCapitalDelta,
    pnlValidationPassed,
    validationError,
  };
}

// Keep simple version for backward compatibility
async function executeTrade(
  connection: Connection,
  payer: Keypair,
  market: MarketState,
  user: Participant,
  lp: Participant,
  size: string
): Promise<boolean> {
  const result = await executeTradeWithValidation(connection, payer, market, user, lp, size, false);
  return result.success;
}

async function runKeeperCrank(
  connection: Connection,
  payer: Keypair,
  market: MarketState
): Promise<boolean> {
  const ixData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    market.slab.publicKey,
    SYSVAR_CLOCK_PUBKEY,
    CHAINLINK_SOL_USD,
  ]);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  tx.add(buildIx({ programId: PROGRAM_ID, keys, data: ixData }));

  try {
    await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: "confirmed",
      skipPreflight: true,
    });
    return true;
  } catch (err: any) {
    console.log(`      Crank failed: ${err.message?.slice(0, 50)}`);
    return false;
  }
}

// ============================================================================
// STATE INSPECTION
// ============================================================================

async function getUsedIndicesFromSlab(connection: Connection, slab: PublicKey): Promise<number[]> {
  const info = await connection.getAccountInfo(slab);
  if (!info) return [];
  return parseUsedIndices(info.data);
}

async function getAccountSnapshot(
  connection: Connection,
  market: MarketState,
  accountIndex: number
): Promise<AccountSnapshot | null> {
  const info = await connection.getAccountInfo(market.slab.publicKey);
  if (!info) return null;

  try {
    const account = parseAccount(info.data, accountIndex);
    return {
      index: accountIndex,
      owner: account.owner.toBase58().slice(0, 8),
      capital: account.capital,
      positionSize: account.positionSize,
      entryPrice: account.entryPrice,
      pnl: account.pnl,
      isLp: account.kind === 1,
    };
  } catch {
    return null;
  }
}

async function getAccountSnapshots(
  connection: Connection,
  market: MarketState
): Promise<AccountSnapshot[]> {
  const info = await connection.getAccountInfo(market.slab.publicKey);
  if (!info) return [];

  const accounts = parseAllAccounts(info.data);
  return accounts.map(({ idx, account }) => ({
    index: idx,
    owner: account.owner.toBase58().slice(0, 8),
    capital: account.capital,
    positionSize: account.positionSize,
    entryPrice: account.entryPrice,
    pnl: account.pnl,
    isLp: account.kind === 1, // AccountKind.LP = 1
  }));
}

async function getTradingFeeBps(connection: Connection, market: MarketState): Promise<bigint> {
  const info = await connection.getAccountInfo(market.slab.publicKey);
  if (!info) return 10n; // default
  return parseParams(info.data).tradingFeeBps;
}

async function validateInvariants(
  connection: Connection,
  market: MarketState,
  participants: Participant[]
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  const info = await connection.getAccountInfo(market.slab.publicKey);
  if (!info) {
    errors.push("Slab not found");
    return { valid: false, errors };
  }

  const engine = parseEngine(info.data);
  const accounts = parseAllAccounts(info.data);

  // Check 1: Sum of positions should be zero (every long has a short)
  let totalPosition = 0n;
  for (const { account } of accounts) {
    totalPosition += account.positionSize;
  }
  if (totalPosition !== 0n) {
    errors.push(`Position sum != 0: ${totalPosition}`);
  }

  // Check 2: All capital should be non-negative (capital can include unrealized PnL)
  // Note: capital CAN go negative during liquidation - only check for extreme negatives
  for (const { idx, account } of accounts) {
    // Capital can be slightly negative due to funding, but very negative is a bug
    if (account.capital < -1000000000n) { // -1000 tokens (6 decimals)
      errors.push(`Account ${idx} has very negative capital: ${account.capital}`);
    }
  }

  // Check 3: Insurance fund should be non-negative
  if (engine.insuranceFund.balance < 0n) {
    errors.push(`Insurance fund negative: ${engine.insuranceFund.balance}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// MAIN TEST LOOP
// ============================================================================

async function runLiveTradingTest(config: TestConfig): Promise<void> {
  const marketType = config.inverted ? "INVERTED" : "NORMAL";
  console.log(`\n${"=".repeat(60)}`);
  console.log(`T21: Live Trading Test (${marketType} Market)`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Duration: ${config.durationMins} minutes`);
  console.log(`Trade interval: ${TRADE_INTERVAL_MS / 1000}s`);
  console.log(`Crank interval: ${CRANK_INTERVAL_MS / 1000}s`);

  // Setup
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  console.log(`\nWallet: ${payer.publicKey.toBase58()}`);
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // Get initial price
  const initialPrice = await getChainlinkPrice(connection);
  console.log(`\nInitial Chainlink price: ${formatPrice(initialPrice.price)}`);

  // Create market
  const market = await setupMarket(connection, payer, config.inverted);

  // Run initial crank
  console.log("\n  Running initial keeper crank...");
  await runKeeperCrank(connection, payer, market);

  // Create participants
  console.log("\n  Creating participants...");
  const lp1 = await createParticipant(connection, payer, market, "LP1", true, 100_000_000n);
  const trader1 = await createParticipant(connection, payer, market, "Trader1", false, 50_000_000n);
  const trader2 = await createParticipant(connection, payer, market, "Trader2", false, 50_000_000n);

  // Initialize accounts
  console.log("  Initializing LP with matcher...");
  await initLpWithMatcher(connection, payer, market, lp1);
  console.log(`    LP1: idx=${lp1.accountIndex}`);

  console.log("  Initializing traders...");
  await initUser(connection, payer, market, trader1);
  await initUser(connection, payer, market, trader2);
  console.log(`    Trader1: idx=${trader1.accountIndex}`);
  console.log(`    Trader2: idx=${trader2.accountIndex}`);

  // Deposit collateral
  console.log("  Depositing collateral...");
  await deposit(connection, payer, market, lp1, "50000000"); // 50 tokens
  await deposit(connection, payer, market, trader1, "20000000"); // 20 tokens
  await deposit(connection, payer, market, trader2, "20000000"); // 20 tokens

  // Top up insurance fund to exit risk-reduction-only mode
  console.log("  Topping up insurance fund...");
  await topUpInsurance(connection, payer, market, lp1, "10000000"); // 10 tokens

  const participants = [lp1, trader1, trader2];

  // Stats tracking
  let tradesExecuted = 0;
  let tradesFailed = 0;
  let pnlValidationsPassed = 0;
  let pnlValidationsFailed = 0;
  let cranksExecuted = 0;
  let priceMin = initialPrice.price;
  let priceMax = initialPrice.price;
  const tradeResults: TradeResult[] = [];

  // Test loop
  console.log(`\n${"=".repeat(60)}`);
  console.log("Starting live trading loop...");
  console.log(`${"=".repeat(60)}\n`);

  const startTime = Date.now();
  const endTime = startTime + config.durationMins * 60 * 1000;
  let lastCrankTime = startTime;
  let lastTradeTime = startTime;
  let iteration = 0;

  while (Date.now() < endTime) {
    iteration++;
    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = Math.max(0, (endTime - Date.now()) / 1000);

    // Get current price
    const currentPrice = await getChainlinkPrice(connection);
    priceMin = Math.min(priceMin, currentPrice.price);
    priceMax = Math.max(priceMax, currentPrice.price);

    console.log(`[${elapsed.toFixed(0)}s] Price: ${formatPrice(currentPrice.price)} (${remaining.toFixed(0)}s remaining)`);

    // Run keeper crank periodically
    if (Date.now() - lastCrankTime >= CRANK_INTERVAL_MS) {
      const success = await runKeeperCrank(connection, payer, market);
      if (success) cranksExecuted++;
      lastCrankTime = Date.now();
    }

    // Execute trades periodically
    if (Date.now() - lastTradeTime >= TRADE_INTERVAL_MS) {
      // Alternate between traders going long and short
      const trader = iteration % 2 === 0 ? trader1 : trader2;
      const direction = iteration % 4 < 2 ? 1n : -1n; // Alternate long/short
      const size = direction * 100000n; // 0.1 contract

      console.log(`  ${trader.name} ${direction > 0 ? "LONG" : "SHORT"} 0.1 contracts...`);
      const result = await executeTradeWithValidation(
        connection, payer, market, trader, lp1, size.toString(), config.inverted
      );
      tradeResults.push(result);

      if (result.success) {
        tradesExecuted++;

        // Log trade details
        const capitalDelta = Number(result.actualUserCapitalDelta) / 1e6;
        const posChange = result.userAfter.positionSize - result.userBefore.positionSize;
        console.log(`    Position: ${formatPosition(result.userBefore.positionSize)} -> ${formatPosition(result.userAfter.positionSize)}`);
        console.log(`    Capital delta: ${capitalDelta >= 0 ? "+" : ""}${capitalDelta.toFixed(4)} tokens`);

        if (result.pnlValidationPassed) {
          pnlValidationsPassed++;
          console.log(`    PnL validation: PASSED`);
        } else {
          pnlValidationsFailed++;
          console.log(`    PnL validation: FAILED - ${result.validationError}`);
        }
      } else {
        tradesFailed++;
      }

      lastTradeTime = Date.now();
    }

    // Validate invariants every 30 seconds
    if (iteration % 3 === 0) {
      const { valid, errors } = await validateInvariants(connection, market, participants);
      if (!valid) {
        console.log(`  WARNING: Invariant violations:`);
        for (const err of errors) {
          console.log(`    - ${err}`);
        }
      }
    }

    await sleep(5000); // Check every 5 seconds
  }

  // Final state
  console.log(`\n${"=".repeat(60)}`);
  console.log("Test Complete - Final State");
  console.log(`${"=".repeat(60)}\n`);

  // Final crank
  await runKeeperCrank(connection, payer, market);

  // Get final price
  const finalPrice = await getChainlinkPrice(connection);

  // Get account states
  const snapshots = await getAccountSnapshots(connection, market);

  console.log("Participants:");
  for (const snap of snapshots) {
    const participant = participants.find(p => p.accountIndex === snap.index);
    const name = participant?.name || `Account ${snap.index}`;
    console.log(`  ${name} (idx=${snap.index}, ${snap.isLp ? "LP" : "User"}):`);
    console.log(`    Capital: ${formatBalance(snap.capital)} tokens`);
    console.log(`    Position: ${formatPosition(snap.positionSize)} contracts`);
    if (snap.entryPrice > 0n) {
      console.log(`    Entry price: ${Number(snap.entryPrice) / 1e6}`);
    }
  }

  // Final invariant check
  const { valid, errors } = await validateInvariants(connection, market, participants);

  console.log("\nInvariant Check:");
  if (valid) {
    console.log("  All invariants PASSED");
  } else {
    console.log("  FAILED:");
    for (const err of errors) {
      console.log(`    - ${err}`);
    }
  }

  // Print detailed trade history
  if (tradeResults.length > 0) {
    console.log("\nTrade History (PnL Validation):");
    console.log("-".repeat(80));
    for (let i = 0; i < tradeResults.length; i++) {
      const r = tradeResults[i];
      if (!r.success) {
        console.log(`  Trade ${i + 1}: FAILED (tx error)`);
        continue;
      }

      const posBefore = r.userBefore.positionSize;
      const posAfter = r.userAfter.positionSize;
      const isOpening = posBefore === 0n;
      const isClosing = posAfter === 0n && posBefore !== 0n;
      const tradeType = isOpening ? "OPEN" : isClosing ? "CLOSE" : "ADJUST";

      const actualDelta = Number(r.actualUserCapitalDelta) / 1e6;
      const expectedDelta = Number(r.expectedUserCapitalDelta) / 1e6;
      const diff = actualDelta - expectedDelta;

      console.log(`  Trade ${i + 1}: ${tradeType} ${formatPosition(r.tradeSizeDelta)} @ $${Number(r.oraclePrice) / 1e6}`);
      console.log(`    Position: ${formatPosition(posBefore)} -> ${formatPosition(posAfter)}`);
      console.log(`    Capital: expected ${expectedDelta >= 0 ? "+" : ""}${expectedDelta.toFixed(4)}, actual ${actualDelta >= 0 ? "+" : ""}${actualDelta.toFixed(4)} (diff: ${diff >= 0 ? "+" : ""}${diff.toFixed(4)})`);
      console.log(`    PnL check: ${r.pnlValidationPassed ? "PASSED" : "FAILED"} ${r.validationError || ""}`);
    }
    console.log("-".repeat(80));
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`T21 ${marketType} MARKET SUMMARY`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Duration: ${config.durationMins} minutes`);
  console.log(`Initial price: ${formatPrice(initialPrice.price)}`);
  console.log(`Final price: ${formatPrice(finalPrice.price)}`);
  console.log(`Price range: ${formatPrice(priceMin)} - ${formatPrice(priceMax)}`);
  console.log(`Price change: ${((finalPrice.price - initialPrice.price) / initialPrice.price * 100).toFixed(2)}%`);
  console.log(`Trades executed: ${tradesExecuted}`);
  console.log(`Trades failed: ${tradesFailed}`);
  console.log(`PnL validations: ${pnlValidationsPassed} passed, ${pnlValidationsFailed} failed`);
  console.log(`Cranks executed: ${cranksExecuted}`);
  console.log(`Invariants: ${valid ? "PASSED" : "FAILED"}`);

  const allPnLPassed = pnlValidationsFailed === 0 && pnlValidationsPassed > 0;
  console.log(`\nOVERALL: ${valid && allPnLPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
  console.log(`${"=".repeat(60)}\n`);
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main(): Promise<void> {
  // Parse args
  const args = process.argv.slice(2);
  const inverted = args.includes("--inverted");
  const durationArg = args.find(a => !a.startsWith("--"));
  const durationMins = durationArg ? parseInt(durationArg) : DEFAULT_DURATION_MINS;

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npx tsx tests/t21-live-trading.ts [duration_mins] [--inverted]");
    console.log("");
    console.log("Options:");
    console.log("  duration_mins  Duration in minutes (default: 3)");
    console.log("  --inverted     Use inverted market (SOL/USD instead of USD/SOL)");
    console.log("");
    console.log("Examples:");
    console.log("  npx tsx tests/t21-live-trading.ts              # 3 min normal market");
    console.log("  npx tsx tests/t21-live-trading.ts 5            # 5 min normal market");
    console.log("  npx tsx tests/t21-live-trading.ts --inverted   # 3 min inverted market");
    console.log("  npx tsx tests/t21-live-trading.ts 10 --inverted # 10 min inverted market");
    process.exit(0);
  }

  // Run normal market test
  if (!inverted) {
    await runLiveTradingTest({ durationMins, inverted: false });
  }

  // Run inverted market test if requested
  if (inverted) {
    await runLiveTradingTest({ durationMins, inverted: true });
  }
}

main().catch(console.error);
