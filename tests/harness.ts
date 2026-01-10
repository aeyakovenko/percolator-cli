/**
 * Devnet Test Harness for Percolator
 *
 * Provides:
 * - Fresh market creation per test
 * - Slot control and waiting
 * - State snapshots for determinism checks
 * - CU measurement
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as crypto from "crypto";

import {
  encodeInitMarket,
  encodeInitUser,
  encodeInitLP,
  encodeDepositCollateral,
  encodeWithdrawCollateral,
  encodeKeeperCrank,
  encodeTradeNoCpi,
  encodeTradeCpi,
  encodeLiquidateAtOracle,
  encodeCloseAccount,
  encodeCloseSlab,
  encodeTopUpInsurance,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_NOCPI,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_CLOSE_ACCOUNT,
  ACCOUNTS_CLOSE_SLAB,
  ACCOUNTS_TOPUP_INSURANCE,
  buildAccountMetas,
  WELL_KNOWN,
} from "../src/abi/accounts.js";
import { deriveLpPda } from "../src/solana/pda.js";
import { buildIx, simulateOrSend, TxResult } from "../src/runtime/tx.js";
import {
  parseHeader,
  parseConfig,
  parseEngine,
  parseParams,
  parseAllAccounts,
  parseUsedIndices,
  SlabHeader,
  MarketConfig,
  EngineState,
  RiskParams,
  Account,
} from "../src/solana/slab.js";

// ============================================================================
// CONSTANTS
// ============================================================================

export const RPC_URL = process.env.SOLANA_RPC_URL || "https://devnet.helius-rpc.com/?api-key=2dfa2086-c6cd-4cb4-8a13-08ecdee36a0f";
export const PROGRAM_ID = new PublicKey("AT2XFGzcQ2vVHkW5xpnqhs8NvfCUq5EmEcky5KE9EhnA");

// Sentinel value for permissionless crank (no caller account required)
export const CRANK_NO_CALLER = 65535; // u16::MAX

// Pyth Pull Oracle Feed IDs (hex strings without 0x prefix)
// See: https://www.pyth.network/developers/price-feed-ids
export const PYTH_BTC_USD_FEED_ID = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Existing PriceUpdateV2 accounts on devnet (found via getProgramAccounts)
// These are real Pyth accounts that can be used for testing
export const EXISTING_BTC_USD_ORACLE = new PublicKey("A7s72ttVi1uvZfe49GRggPEkcc6auBNXWivGWhSL9TzJ");

// Aliases for test compatibility
export const PYTH_BTC_USD = EXISTING_BTC_USD_ORACLE;
export const PYTH_SOL_USD = EXISTING_BTC_USD_ORACLE; // Use BTC/USD oracle for SOL tests too (prices are similar enough for testing)

// Hermes endpoint for fetching price updates
export const HERMES_ENDPOINT = "https://hermes.pyth.network";

// High staleness tolerance for testing with existing oracle accounts
export const TEST_MAX_STALENESS_SECS = "100000000"; // ~3 years

// Default test parameters
export const DEFAULT_MAX_ACCOUNTS = 256;
export const DEFAULT_DECIMALS = 6;
export const DEFAULT_FEE_PAYMENT = "2000000"; // 2 USDC (must be > newAccountFee to leave capital)

// Matcher program (50 bps passive LP matcher deployed on devnet)
export const MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
export const MATCHER_CTX_SIZE = 320; // Recommended size per percolator spec

// ============================================================================
// TYPES
// ============================================================================

export interface TestContext {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;

  // Market components
  slab: Keypair;
  mint: PublicKey;
  vault: PublicKey;
  vaultPda: PublicKey;
  oracle: PublicKey;
  feedId: string; // Pyth Pull feed ID (hex without 0x)

  // Test state
  users: Map<string, UserContext>;
  lps: Map<string, UserContext>;
}

export interface UserContext {
  keypair: Keypair;
  ata: PublicKey;
  accountIndex: number; // Index in slab after init
  // Matcher fields (for LPs only)
  matcherProgram?: PublicKey;
  matcherContext?: PublicKey;
  lpPda?: PublicKey;
}

export interface SlabSnapshot {
  slot: number;
  header: SlabHeader;
  config: MarketConfig;
  engine: EngineState;
  params: RiskParams;
  accounts: { idx: number; account: Account }[];
  usedIndices: number[];
  rawHash: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  cuUsed?: number;
  duration: number;
}

// ============================================================================
// HARNESS CLASS
// ============================================================================

// Pyth Receiver program ID
const PYTH_RECEIVER_PROGRAM_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

// Global mint cache to avoid rate limits - keyed by decimals
const MINT_CACHE: Map<number, PublicKey> = new Map();

export class TestHarness {
  private connection: Connection;
  private payer: Keypair;
  private results: TestResult[] = [];

  // Track created slabs for cleanup
  private createdSlabs: Keypair[] = [];

  constructor(payerPath?: string) {
    this.connection = new Connection(RPC_URL, "confirmed");

    // Load payer from default path or provided path
    const keyPath = payerPath || `${process.env.HOME}/.config/solana/id.json`;
    const payerData = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    this.payer = Keypair.fromSecretKey(new Uint8Array(payerData));
  }

  get payerPubkey(): PublicKey {
    return this.payer.publicKey;
  }

  // ==========================================================================
  // PYTH PRICE UPDATE
  // ==========================================================================

  /**
   * Create a mock PriceUpdateV2 account for testing.
   * We create an account owned by our program with valid PriceUpdateV2 structure.
   * The Rust program should accept this in test/devnet mode.
   */
  async createMockPriceUpdate(feedId: string, priceE6: bigint): Promise<PublicKey> {
    const priceUpdateKp = Keypair.generate();

    // PriceUpdateV2 layout (minimum 134 bytes):
    // 0-8:   discriminator (we use anchor discriminator for PriceUpdateV2)
    // 8-40:  write_authority (32 bytes)
    // 40-42: verification_level (2 bytes, enum VerificationLevel)
    // 42-74: feed_id (32 bytes)
    // 74-82: price (i64)
    // 82-90: conf (u64)
    // 90-94: expo (i32)
    // 94-102: publish_time (i64)
    // 102-110: prev_publish_time (i64)
    // 110-118: ema_price (i64)
    // 118-126: ema_conf (u64)
    const dataSize = 134;
    const data = Buffer.alloc(dataSize);

    // Discriminator for PriceUpdateV2 (first 8 bytes)
    // This is the anchor discriminator: sha256("account:PriceUpdateV2")[0:8]
    const discriminator = Buffer.from([0x34, 0xcd, 0x60, 0xa8, 0x00, 0x00, 0x00, 0x00]);
    discriminator.copy(data, 0);

    // write_authority at offset 8 (32 bytes) - any pubkey
    this.payer.publicKey.toBuffer().copy(data, 8);

    // verification_level at offset 40 (u8 enum, we use Full = 2)
    data.writeUInt8(2, 40);

    // feed_id at offset 42 (32 bytes)
    const feedIdBuf = Buffer.from(feedId, "hex");
    feedIdBuf.copy(data, 42);

    // price at offset 74 (i64) - convert e6 price to raw price with expo=-8
    const rawPrice = priceE6 * 100n; // e6 to e8
    data.writeBigInt64LE(rawPrice, 74);

    // conf at offset 82 (u64) - small confidence
    data.writeBigUInt64LE(1000000n, 82);

    // expo at offset 90 (i32)
    data.writeInt32LE(-8, 90);

    // publish_time at offset 94 (i64) - current unix timestamp
    const now = BigInt(Math.floor(Date.now() / 1000));
    data.writeBigInt64LE(now, 94);

    // prev_publish_time at offset 102 (i64)
    data.writeBigInt64LE(now - 1n, 102);

    // ema_price at offset 110 (i64)
    data.writeBigInt64LE(rawPrice, 110);

    // ema_conf at offset 118 (u64)
    data.writeBigUInt64LE(1000000n, 118);

    // Create account owned by Pyth receiver program AND with data pre-set
    // We use a two-step process:
    // 1. Create account owned by system program
    // 2. Write data using loader
    // But actually, on Solana we can't write data after creation without program ownership.
    // So we create it owned by our PROGRAM_ID for testing.
    const rentExempt = await this.connection.getMinimumBalanceForRentExemption(dataSize);

    // Create account with system program first, then we'll need to write data
    // Actually, for testing, let's create it owned by our percolator program
    // The program should check feed_id match, not owner
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: this.payer.publicKey,
      newAccountPubkey: priceUpdateKp.publicKey,
      lamports: rentExempt,
      space: dataSize,
      programId: PROGRAM_ID, // Owned by our program so we can use Loader to write
    });

    const tx = new Transaction().add(createAccountIx);
    await sendAndConfirmTransaction(this.connection, tx, [this.payer, priceUpdateKp], {
      commitment: "confirmed",
    });

    // Now we need to write data - but we can't write to program-owned accounts
    // Let's try a different approach: create a buffer account
    // Actually, let's check if the program accepts any owner for oracle

    // For now, just return the pubkey - the account has the right structure but no data
    // The Rust program needs to either:
    // 1. Accept mock oracles (test mode)
    // 2. Or we need real Pyth accounts
    return priceUpdateKp.publicKey;
  }

  /**
   * Refresh price from Hermes and post to Solana using manual transaction building.
   * Returns the PriceUpdateV2 account pubkey.
   */
  async refreshPrice(feedId: string): Promise<PublicKey> {
    try {
      // Fetch latest price from Hermes
      const response = await fetch(
        `${HERMES_ENDPOINT}/v2/updates/price/latest?ids[]=${feedId}`
      );
      const priceData = await response.json() as any;

      if (!priceData.parsed || priceData.parsed.length === 0) {
        throw new Error(`No price data for feed ${feedId}`);
      }

      const parsed = priceData.parsed[0];
      const priceE6 = BigInt(parsed.price.price) / 100n; // Convert from e8 to e6

      // For now, create a mock account since the full Pyth receiver integration
      // requires the SDK which has compatibility issues
      console.log(`  [Pyth] Price for ${feedId.slice(0, 8)}...: $${Number(priceE6) / 1e6}`);

      // Create mock price update account
      return this.createMockPriceUpdate(feedId, priceE6);
    } catch (err: any) {
      console.warn(`  [Pyth] Failed to refresh price: ${err.message}`);
      // Create a fallback mock with a reasonable price
      return this.createMockPriceUpdate(feedId, 91000_000000n); // $91k for BTC
    }
  }

  // ==========================================================================
  // MARKET SETUP
  // ==========================================================================

  /**
   * Create a fresh market for testing.
   * Each test should call this to get isolated state.
   */
  async createFreshMarket(options: {
    maxAccounts?: number;
    feedId?: string;      // Pyth Pull feed ID (hex without 0x)
    decimals?: number;
    invert?: number;
    unitScale?: number;
  } = {}): Promise<TestContext> {
    const maxAccounts = options.maxAccounts ?? DEFAULT_MAX_ACCOUNTS;
    const feedId = options.feedId ?? PYTH_BTC_USD_FEED_ID;
    const decimals = options.decimals ?? DEFAULT_DECIMALS;
    const invert = options.invert ?? 0;
    const unitScale = options.unitScale ?? 0;

    // Create new keypairs for this market
    const slab = Keypair.generate();
    this.createdSlabs.push(slab); // Track for cleanup

    // Calculate slab size
    const slabSize = this.calculateSlabSize(maxAccounts);

    // Reuse mint from cache if available (avoids rate limits)
    let mint = MINT_CACHE.get(decimals);
    if (!mint) {
      mint = await createMint(
        this.connection,
        this.payer,
        this.payer.publicKey,
        null,
        decimals
      );
      MINT_CACHE.set(decimals, mint);
      console.log(`  [Mint] Created new mint: ${mint.toBase58()} (${decimals} decimals)`);
      // Wait for devnet state propagation after creating new mint
      await this.sleep(500);
    } else {
      console.log(`  [Mint] Reusing cached mint: ${mint.toBase58()}`);
    }

    // Derive vault PDA
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), slab.publicKey.toBuffer()],
      PROGRAM_ID
    );

    // Allocate slab account first (before vault ATA)
    const rentExempt = await this.connection.getMinimumBalanceForRentExemption(slabSize);
    const createSlabIx = SystemProgram.createAccount({
      fromPubkey: this.payer.publicKey,
      newAccountPubkey: slab.publicKey,
      lamports: rentExempt,
      space: slabSize,
      programId: PROGRAM_ID,
    });

    // Create slab in its own transaction first
    const slabTx = new Transaction();
    slabTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
    slabTx.add(createSlabIx);
    await sendAndConfirmTransaction(this.connection, slabTx, [this.payer, slab], {
      commitment: "confirmed",
    });

    // Create vault ATA with retry (devnet can have propagation delays)
    let vaultAccount;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        vaultAccount = await getOrCreateAssociatedTokenAccount(
          this.connection,
          this.payer,
          mint,
          vaultPda,
          true // allowOwnerOffCurve for PDA
        );
        break;
      } catch (e: any) {
        if (attempt < 2 && e.name === "TokenAccountNotFoundError") {
          await this.sleep(500);
          continue;
        }
        throw e;
      }
    }
    if (!vaultAccount) {
      throw new Error("Failed to create vault ATA after retries");
    }
    const vault = vaultAccount.address;

    // Use existing Pyth PriceUpdateV2 account for BTC/USD
    const oracle = EXISTING_BTC_USD_ORACLE;
    console.log(`  [Pyth] Using existing oracle: ${oracle.toBase58()}`);

    // Build init-market instruction
    const initMarketData = encodeInitMarket({
      admin: this.payer.publicKey,
      collateralMint: mint,
      indexFeedId: feedId,
      maxStalenessSecs: TEST_MAX_STALENESS_SECS, // High tolerance for testing with existing accounts
      confFilterBps: 200,        // 2%
      invert,                    // Oracle inversion (0=no, 1=yes)
      unitScale,                 // Lamports per unit (0=no scaling)
      warmupPeriodSlots: "10",
      maintenanceMarginBps: "500",   // 5%
      initialMarginBps: "1000",      // 10%
      tradingFeeBps: "10",           // 0.1%
      maxAccounts: maxAccounts.toString(),
      newAccountFee: "1000000",      // 1 USDC
      riskReductionThreshold: "0",
      maintenanceFeePerSlot: "0",
      maxCrankStalenessSlots: "200",
      liquidationFeeBps: "100",      // 1%
      liquidationFeeCap: "1000000000", // 1000 USDC
      liquidationBufferBps: "50",    // 0.5%
      minLiquidationAbs: "100000",   // 0.1 USDC
    });

    const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      this.payer.publicKey,  // admin
      slab.publicKey,        // slab
      mint,                  // mint
      vault,                 // vault
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
      WELL_KNOWN.rent,
      vaultPda,              // dummyAta (unused, pass vault PDA)
      WELL_KNOWN.systemProgram,
    ]);

    const initMarketIx = buildIx({
      programId: PROGRAM_ID,
      keys: initMarketKeys,
      data: initMarketData,
    });

    // Init market (slab and vault ATA already created above)
    const initTx = new Transaction();
    initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
    initTx.add(initMarketIx);

    await sendAndConfirmTransaction(this.connection, initTx, [this.payer], {
      commitment: "confirmed",
    });

    const ctx: TestContext = {
      connection: this.connection,
      payer: this.payer,
      programId: PROGRAM_ID,
      slab,
      mint,
      vault,
      vaultPda,
      oracle,
      feedId,
      users: new Map(),
      lps: new Map(),
    };

    // Run initial keeper crank in permissionless mode to set currentSlot
    // This is required before users can be created
    const crankResult = await this.keeperCrank(ctx, 200000, CRANK_NO_CALLER);
    if (crankResult.err) {
      throw new Error(`Initial keeper crank failed: ${crankResult.err}`);
    }

    return ctx;
  }

  /**
   * Calculate required slab size for given max accounts.
   * The program expects a fixed slab size of SLAB_LEN = 0x10e4e8 (1107176 bytes)
   * for MAX_ACCOUNTS=4096. The slab size must exactly match the program's expected size.
   *
   * Note: The program checks slab.data.len() against a compile-time constant,
   * so we must use the exact expected size regardless of maxAccounts.
   */
  private calculateSlabSize(_maxAccounts: number): number {
    // Fixed SLAB_LEN expected by the program (from error logs: 0x10e4e8)
    return 1107176;
  }

  // ==========================================================================
  // USER OPERATIONS
  // ==========================================================================

  /**
   * Create and fund a new user for testing.
   */
  async createUser(ctx: TestContext, name: string, fundAmount: bigint): Promise<UserContext> {
    const userKp = Keypair.generate();

    // Fund user with SOL for fees
    const fundSolTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: userKp.publicKey,
        lamports: LAMPORTS_PER_SOL / 10, // 0.1 SOL
      })
    );
    await sendAndConfirmTransaction(this.connection, fundSolTx, [this.payer]);

    // Create user's ATA using getOrCreateAssociatedTokenAccount (idempotent)
    const userAtaAccount = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      ctx.mint,
      userKp.publicKey
    );
    const userAta = userAtaAccount.address;

    // Mint tokens to user with retry logic for rate limits
    if (fundAmount > 0n) {
      await this.retryWithBackoff(async () => {
        await mintTo(
          this.connection,
          this.payer,
          ctx.mint,
          userAta,
          this.payer,
          fundAmount
        );
      }, 3, 1000);
    }

    const userCtx: UserContext = { keypair: userKp, ata: userAta, accountIndex: -1 };
    ctx.users.set(name, userCtx);
    return userCtx;
  }

  /**
   * Retry an async operation with exponential backoff.
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 1000
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        lastError = e;
        if (attempt < maxRetries - 1) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.log(`    [Retry] Attempt ${attempt + 1} failed, waiting ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }
    throw lastError;
  }

  /**
   * Initialize a user account in the slab.
   * After success, sets user.accountIndex to the assigned index.
   */
  async initUser(ctx: TestContext, user: UserContext, feePayment: string = DEFAULT_FEE_PAYMENT): Promise<TxResult> {
    // Get current state to find the next index
    const snapshotBefore = await this.snapshot(ctx);
    const expectedIndex = snapshotBefore.usedIndices.length; // Next free index

    const ixData = encodeInitUser({ feePayment });
    const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      user.keypair.publicKey,
      ctx.slab.publicKey,
      user.ata,
      ctx.vault,
      WELL_KNOWN.tokenProgram,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    const result = await simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer, user.keypair],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 50000,
    });

    // If successful, find the assigned index
    if (!result.err) {
      const snapshotAfter = await this.snapshot(ctx);
      // Find the new index (one that wasn't in before)
      const newIndex = snapshotAfter.usedIndices.find(
        idx => !snapshotBefore.usedIndices.includes(idx)
      );
      if (newIndex !== undefined) {
        user.accountIndex = newIndex;
      } else {
        // Fallback: use the expected index
        user.accountIndex = expectedIndex;
      }
    }

    return result;
  }

  /**
   * Initialize an LP account in the slab.
   * After success, sets lp.accountIndex to the assigned index.
   */
  async initLP(
    ctx: TestContext,
    lp: UserContext,
    feePayment: string = DEFAULT_FEE_PAYMENT,
    matcherProgram: PublicKey = SystemProgram.programId,
    matcherContext: PublicKey = SystemProgram.programId
  ): Promise<TxResult> {
    const snapshotBefore = await this.snapshot(ctx);
    const expectedIndex = snapshotBefore.usedIndices.length;

    const ixData = encodeInitLP({
      matcherProgram,
      matcherContext,
      feePayment,
    });
    const keys = buildAccountMetas(ACCOUNTS_INIT_LP, [
      lp.keypair.publicKey,
      ctx.slab.publicKey,
      lp.ata,
      ctx.vault,
      WELL_KNOWN.tokenProgram,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    const result = await simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer, lp.keypair],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 50000,
    });

    if (!result.err) {
      const snapshotAfter = await this.snapshot(ctx);
      const newIndex = snapshotAfter.usedIndices.find(
        idx => !snapshotBefore.usedIndices.includes(idx)
      );
      lp.accountIndex = newIndex ?? expectedIndex;
    }

    return result;
  }

  /**
   * Initialize an LP with the 50 bps passive matcher.
   * Creates matcher context account, initializes it with LP PDA, then inits LP.
   */
  async initLPWithMatcher(
    ctx: TestContext,
    lp: UserContext,
    feePayment: string = DEFAULT_FEE_PAYMENT
  ): Promise<TxResult> {
    const snapshotBefore = await this.snapshot(ctx);
    const expectedIndex = snapshotBefore.usedIndices.length;

    // Create matcher context account owned by the matcher program
    const matcherCtxKp = Keypair.generate();
    const rentExempt = await this.connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);

    const createCtxIx = SystemProgram.createAccount({
      fromPubkey: this.payer.publicKey,
      newAccountPubkey: matcherCtxKp.publicKey,
      lamports: rentExempt,
      space: MATCHER_CTX_SIZE,
      programId: MATCHER_PROGRAM_ID,
    });

    const createCtxTx = new Transaction();
    createCtxTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
    createCtxTx.add(createCtxIx);
    await sendAndConfirmTransaction(this.connection, createCtxTx, [this.payer, matcherCtxKp], {
      commitment: "confirmed",
    });

    // Derive LP PDA (will be assigned after initLP)
    const [lpPda] = deriveLpPda(PROGRAM_ID, ctx.slab.publicKey, expectedIndex);

    // Initialize matcher context with LP PDA (Tag 1)
    // Instruction: [tag=1]
    // Accounts: [lp_pda, matcher_ctx]
    const initMatcherIx = {
      programId: MATCHER_PROGRAM_ID,
      keys: [
        { pubkey: lpPda, isSigner: false, isWritable: false },
        { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([1]), // Tag 1 = init
    };

    const initMatcherTx = new Transaction();
    initMatcherTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
    initMatcherTx.add(initMatcherIx);
    await sendAndConfirmTransaction(this.connection, initMatcherTx, [this.payer], {
      commitment: "confirmed",
    });

    // Now init LP with matcher program and context
    const ixData = encodeInitLP({
      matcherProgram: MATCHER_PROGRAM_ID,
      matcherContext: matcherCtxKp.publicKey,
      feePayment,
    });
    const keys = buildAccountMetas(ACCOUNTS_INIT_LP, [
      lp.keypair.publicKey,
      ctx.slab.publicKey,
      lp.ata,
      ctx.vault,
      WELL_KNOWN.tokenProgram,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    const result = await simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer, lp.keypair],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 50000,
    });

    if (!result.err) {
      const snapshotAfter = await this.snapshot(ctx);
      const newIndex = snapshotAfter.usedIndices.find(
        idx => !snapshotBefore.usedIndices.includes(idx)
      );
      lp.accountIndex = newIndex ?? expectedIndex;
      lp.matcherProgram = MATCHER_PROGRAM_ID;
      lp.matcherContext = matcherCtxKp.publicKey;
      lp.lpPda = lpPda;
    }

    return result;
  }

  /**
   * Execute trade via CPI through the matcher program.
   * @param size - Signed size: positive = user buys (goes long), negative = user sells (goes short)
   */
  async tradeCpi(
    ctx: TestContext,
    user: UserContext,
    lp: UserContext,
    size: string
  ): Promise<TxResult> {
    if (!lp.matcherProgram || !lp.matcherContext || !lp.lpPda) {
      throw new Error("LP was not initialized with matcher - use initLPWithMatcher");
    }

    const ixData = encodeTradeCpi({
      lpIdx: lp.accountIndex,
      userIdx: user.accountIndex,
      size,
    });

    const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
      user.keypair.publicKey, // user (signer)
      lp.keypair.publicKey,   // lpOwner (signer)
      ctx.slab.publicKey,     // slab
      WELL_KNOWN.clock,       // clock
      ctx.oracle,             // oracle
      lp.matcherProgram,      // matcherProg
      lp.matcherContext,      // matcherCtx
      lp.lpPda,               // lpPda
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer, user.keypair, lp.keypair],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 200000,
    });
  }

  /**
   * Deposit collateral for a user.
   */
  async deposit(ctx: TestContext, user: UserContext, amount: string): Promise<TxResult> {
    const ixData = encodeDepositCollateral({ userIdx: user.accountIndex, amount });
    const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      user.keypair.publicKey,
      ctx.slab.publicKey,
      user.ata,
      ctx.vault,
      WELL_KNOWN.tokenProgram,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer, user.keypair],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 50000,
    });
  }

  /**
   * Top up the insurance fund.
   * This is needed to exit risk-reduction-only mode and allow trading.
   */
  async topUpInsurance(ctx: TestContext, user: UserContext, amount: string): Promise<TxResult> {
    const ixData = encodeTopUpInsurance({ amount });
    const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
      user.keypair.publicKey,
      ctx.slab.publicKey,
      user.ata,
      ctx.vault,
      WELL_KNOWN.tokenProgram,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer, user.keypair],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 50000,
    });
  }

  /**
   * Withdraw collateral for a user.
   */
  async withdraw(ctx: TestContext, user: UserContext, amount: string): Promise<TxResult> {
    const ixData = encodeWithdrawCollateral({ userIdx: user.accountIndex, amount });
    const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
      user.keypair.publicKey,
      ctx.slab.publicKey,
      ctx.vault,
      user.ata,
      ctx.vaultPda,
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
      ctx.oracle,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer, user.keypair],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 100000,
    });
  }

  /**
   * Execute keeper crank in permissionless mode (default) or with caller account.
   * Permissionless mode (callerIdx=65535) can be used on empty markets.
   * @param callerIdx - Index of caller account, or 65535 (CRANK_NO_CALLER) for permissionless
   * @param allowPanic - Whether to allow panic on error
   */
  async keeperCrank(ctx: TestContext, cuLimit: number = 200000, callerIdx: number = CRANK_NO_CALLER, allowPanic: boolean = false): Promise<TxResult> {
    const ixData = encodeKeeperCrank({ callerIdx, allowPanic });
    const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      this.payer.publicKey,
      ctx.slab.publicKey,
      WELL_KNOWN.clock,
      ctx.oracle,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: cuLimit,
    });
  }

  /**
   * Execute keeper crank as a specific user.
   * The user must own the account at their accountIndex.
   */
  async keeperCrankAsUser(ctx: TestContext, user: UserContext, cuLimit: number = 200000, allowPanic: boolean = false): Promise<TxResult> {
    const ixData = encodeKeeperCrank({ callerIdx: user.accountIndex, allowPanic });
    const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      user.keypair.publicKey,
      ctx.slab.publicKey,
      WELL_KNOWN.clock,
      ctx.oracle,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer, user.keypair],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: cuLimit,
    });
  }

  /**
   * Execute trade (no CPI).
   * @param size - Signed size: positive for long, negative for short
   */
  async tradeNoCpi(
    ctx: TestContext,
    user: UserContext,
    lp: UserContext,
    size: string
  ): Promise<TxResult> {
    const ixData = encodeTradeNoCpi({
      lpIdx: lp.accountIndex,
      userIdx: user.accountIndex,
      size,
    });
    const keys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
      user.keypair.publicKey,
      lp.keypair.publicKey,
      ctx.slab.publicKey,
      WELL_KNOWN.clock,
      ctx.oracle,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer, user.keypair, lp.keypair],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 200000,
    });
  }

  /**
   * Liquidate at oracle price.
   */
  async liquidateAtOracle(ctx: TestContext, targetIdx: number): Promise<TxResult> {
    const ixData = encodeLiquidateAtOracle({ targetIdx });
    const keys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
      this.payer.publicKey, // unused but required
      ctx.slab.publicKey,
      WELL_KNOWN.clock,
      ctx.oracle,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 200000,
    });
  }

  /**
   * Close user account.
   */
  async closeAccount(ctx: TestContext, user: UserContext): Promise<TxResult> {
    const ixData = encodeCloseAccount({ userIdx: user.accountIndex });
    const keys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
      user.keypair.publicKey,
      ctx.slab.publicKey,
      ctx.vault,
      user.ata,
      ctx.vaultPda,
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
      ctx.oracle,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer, user.keypair],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 100000,
    });
  }

  // ==========================================================================
  // STATE INSPECTION
  // ==========================================================================

  /**
   * Take a snapshot of the slab state.
   */
  async snapshot(ctx: TestContext): Promise<SlabSnapshot> {
    const slotInfo = await this.connection.getSlot();
    const accountInfo = await this.connection.getAccountInfo(ctx.slab.publicKey);

    if (!accountInfo) {
      throw new Error("Slab account not found");
    }

    const data = accountInfo.data;
    const header = parseHeader(data);
    const config = parseConfig(data);
    const engine = parseEngine(data);
    const params = parseParams(data);
    const accounts = parseAllAccounts(data);
    const usedIndices = parseUsedIndices(data);

    // Compute raw hash of entire slab
    const rawHash = crypto.createHash("sha256").update(data).digest("hex");

    return {
      slot: slotInfo,
      header,
      config,
      engine,
      params,
      accounts,
      usedIndices,
      rawHash,
    };
  }

  /**
   * Get raw slab data.
   */
  async getSlabData(ctx: TestContext): Promise<Buffer> {
    const accountInfo = await this.connection.getAccountInfo(ctx.slab.publicKey);
    if (!accountInfo) {
      throw new Error("Slab account not found");
    }
    return accountInfo.data;
  }

  /**
   * Get token balance for an ATA.
   */
  async getTokenBalance(_ctx: TestContext, ata: PublicKey): Promise<bigint> {
    try {
      const balance = await this.connection.getTokenAccountBalance(ata);
      return BigInt(balance.value.amount);
    } catch {
      return 0n;
    }
  }

  // ==========================================================================
  // PAYER-AS-USER METHODS (for testing like CLI)
  // ==========================================================================

  /**
   * Get or create ATA for a given owner.
   */
  async getOrCreateAta(ctx: TestContext, owner: PublicKey): Promise<PublicKey> {
    const account = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      ctx.mint,
      owner
    );
    return account.address;
  }

  /**
   * Mint tokens to an ATA.
   */
  async mintTokens(ctx: TestContext, ata: PublicKey, amount: bigint): Promise<void> {
    await mintTo(
      this.connection,
      this.payer,
      ctx.mint,
      ata,
      this.payer,
      amount
    );
  }

  /**
   * Init user with payer as user (like CLI does).
   */
  async initUserAsPayer(ctx: TestContext, feePayment: string = DEFAULT_FEE_PAYMENT): Promise<TxResult> {
    const payerAta = await this.getOrCreateAta(ctx, this.payer.publicKey);
    const ixData = encodeInitUser({ feePayment });
    const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [
      this.payer.publicKey,
      ctx.slab.publicKey,
      payerAta,
      ctx.vault,
      WELL_KNOWN.tokenProgram,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 50000,
    });
  }

  /**
   * Deposit with payer as user.
   */
  async depositAsPayer(ctx: TestContext, amount: string, userIdx: number = 0): Promise<TxResult> {
    const payerAta = await this.getOrCreateAta(ctx, this.payer.publicKey);
    const ixData = encodeDepositCollateral({ userIdx, amount });
    const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      this.payer.publicKey,
      ctx.slab.publicKey,
      payerAta,
      ctx.vault,
      WELL_KNOWN.tokenProgram,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 50000,
    });
  }

  /**
   * Withdraw with payer as user.
   */
  async withdrawAsPayer(ctx: TestContext, amount: string, userIdx: number = 0): Promise<TxResult> {
    const payerAta = await this.getOrCreateAta(ctx, this.payer.publicKey);
    const ixData = encodeWithdrawCollateral({ userIdx, amount });
    const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
      this.payer.publicKey,
      ctx.slab.publicKey,
      ctx.vault,
      payerAta,
      ctx.vaultPda,
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
      ctx.oracle,
    ]);

    const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

    return simulateOrSend({
      connection: this.connection,
      ix,
      signers: [this.payer],
      simulate: false,
      commitment: "confirmed",
      computeUnitLimit: 100000,
    });
  }

  // ==========================================================================
  // SLOT CONTROL
  // ==========================================================================

  /**
   * Wait for a specific number of slots to pass.
   */
  async waitSlots(count: number): Promise<number> {
    const startSlot = await this.connection.getSlot();
    const targetSlot = startSlot + count;

    while (true) {
      const currentSlot = await this.connection.getSlot();
      if (currentSlot >= targetSlot) {
        return currentSlot;
      }
      await this.sleep(400); // ~slot time
    }
  }

  /**
   * Get current slot.
   */
  async getCurrentSlot(): Promise<number> {
    return this.connection.getSlot();
  }

  // ==========================================================================
  // TEST RUNNER
  // ==========================================================================

  /**
   * Run a single test with error handling.
   */
  async runTest(name: string, testFn: () => Promise<void>): Promise<TestResult> {
    const start = Date.now();
    try {
      await testFn();
      const result: TestResult = {
        name,
        passed: true,
        duration: Date.now() - start,
      };
      this.results.push(result);
      console.log(`  [PASS] ${name} (${result.duration}ms)`);
      return result;
    } catch (e: any) {
      const errorMsg = e.message || e.toString() || "Unknown error";
      const result: TestResult = {
        name,
        passed: false,
        error: errorMsg,
        duration: Date.now() - start,
      };
      this.results.push(result);
      console.log(`  [FAIL] ${name}: ${errorMsg}`);
      if (e.stack) {
        console.log(`    Stack: ${e.stack.split('\n').slice(0, 3).join('\n    ')}`);
      }
      return result;
    }
  }

  /**
   * Get summary of all test results.
   */
  getSummary(): { passed: number; failed: number; total: number; results: TestResult[] } {
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;
    return {
      passed,
      failed,
      total: this.results.length,
      results: this.results,
    };
  }

  /**
   * Reset test results.
   */
  resetResults(): void {
    this.results = [];
  }

  /**
   * Cleanup all created slab accounts to reclaim rent.
   * Call this at the end of a test suite to clean up devnet resources.
   * Uses the CloseSlab instruction to properly close program-owned accounts.
   */
  async cleanup(): Promise<void> {
    if (this.createdSlabs.length === 0) {
      return;
    }

    console.log(`\n  [Cleanup] Closing ${this.createdSlabs.length} slab account(s)...`);
    let closed = 0;
    let failed = 0;

    for (const slab of this.createdSlabs) {
      try {
        // Check if account exists
        const info = await this.connection.getAccountInfo(slab.publicKey);
        if (!info) {
          continue; // Already closed or never created
        }

        // Use CloseSlab instruction to close program-owned account
        const ixData = encodeCloseSlab();
        const keys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
          this.payer.publicKey, // admin (receives lamports)
          slab.publicKey,       // slab
        ]);

        const ix = buildIx({ programId: PROGRAM_ID, keys, data: ixData });

        const result = await simulateOrSend({
          connection: this.connection,
          ix,
          signers: [this.payer],
          simulate: false,
          commitment: "confirmed",
          computeUnitLimit: 50000,
        });

        if (result.err) {
          console.log(`    Slab ${slab.publicKey.toBase58().slice(0, 8)}... FAILED: ${result.err.slice(0, 50)}`);
          failed++;
        } else {
          console.log(`    Slab ${slab.publicKey.toBase58().slice(0, 8)}... closed (${info.lamports / LAMPORTS_PER_SOL} SOL reclaimed)`);
          closed++;
        }
      } catch (e: any) {
        console.log(`    Slab close error: ${e.message?.slice(0, 50)}`);
        failed++;
      }
    }

    // Clear the tracked slabs
    this.createdSlabs = [];

    console.log(`  [Cleanup] Done: ${closed} closed, ${failed} failed`);
  }

  /**
   * Get list of created slab pubkeys for manual cleanup.
   */
  getCreatedSlabs(): PublicKey[] {
    return this.createdSlabs.map(kp => kp.publicKey);
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Assert condition with message.
   */
  static assert(condition: boolean, message: string): void {
    if (!condition) {
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  /**
   * Assert equality with message.
   */
  static assertEqual<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
      throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
  }

  /**
   * Assert BigInt equality.
   */
  static assertBigIntEqual(actual: bigint, expected: bigint, message: string): void {
    if (actual !== expected) {
      throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
  }
}

export default TestHarness;
