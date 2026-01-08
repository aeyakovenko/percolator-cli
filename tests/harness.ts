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
  encodeLiquidateAtOracle,
  encodeCloseAccount,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_NOCPI,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_CLOSE_ACCOUNT,
  buildAccountMetas,
  WELL_KNOWN,
} from "../src/abi/accounts.js";
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

export const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
export const PROGRAM_ID = new PublicKey("AT2XFGzcQ2vVHkW5xpnqhs8NvfCUq5EmEcky5KE9EhnA");

// Pyth Devnet Oracles
export const PYTH_BTC_USD = new PublicKey("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J");
export const PYTH_SOL_USD = new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix");

// Default test parameters
export const DEFAULT_MAX_ACCOUNTS = 256;
export const DEFAULT_DECIMALS = 6;
export const DEFAULT_FEE_PAYMENT = "1000000"; // 1 USDC

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

  // Test state
  users: Map<string, UserContext>;
  lps: Map<string, UserContext>;
}

export interface UserContext {
  keypair: Keypair;
  ata: PublicKey;
  accountIndex: number; // Index in slab after init
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

export class TestHarness {
  private connection: Connection;
  private payer: Keypair;
  private results: TestResult[] = [];

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
  // MARKET SETUP
  // ==========================================================================

  /**
   * Create a fresh market for testing.
   * Each test should call this to get isolated state.
   */
  async createFreshMarket(options: {
    maxAccounts?: number;
    oracle?: PublicKey;
    decimals?: number;
  } = {}): Promise<TestContext> {
    const maxAccounts = options.maxAccounts ?? DEFAULT_MAX_ACCOUNTS;
    const oracle = options.oracle ?? PYTH_BTC_USD;
    const decimals = options.decimals ?? DEFAULT_DECIMALS;

    // Create new keypairs for this market
    const slab = Keypair.generate();

    // Calculate slab size
    const slabSize = this.calculateSlabSize(maxAccounts);

    // Create mint for this market
    const mint = await createMint(
      this.connection,
      this.payer,
      this.payer.publicKey,
      null,
      decimals
    );

    // Derive vault PDA
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), slab.publicKey.toBuffer()],
      PROGRAM_ID
    );

    // Create vault ATA
    const vault = await getAssociatedTokenAddress(mint, vaultPda, true);

    // Create the vault ATA (owned by PDA)
    const createVaultAtaIx = createAssociatedTokenAccountInstruction(
      this.payer.publicKey,
      vault,
      vaultPda,
      mint
    );

    // Allocate slab account
    const rentExempt = await this.connection.getMinimumBalanceForRentExemption(slabSize);
    const createSlabIx = SystemProgram.createAccount({
      fromPubkey: this.payer.publicKey,
      newAccountPubkey: slab.publicKey,
      lamports: rentExempt,
      space: slabSize,
      programId: PROGRAM_ID,
    });

    // Build init-market instruction
    const initMarketData = encodeInitMarket({
      admin: this.payer.publicKey,
      collateralMint: mint,
      pythIndex: oracle,
      pythCollateral: oracle,
      maxStalenessSlots: "100",
      confFilterBps: 200,        // 2%
      invert: 0,                 // No oracle inversion
      unitScale: 0,              // No unit scaling
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
      oracle,                // pyth index oracle
      oracle,                // pyth collateral oracle (same for test)
      WELL_KNOWN.systemProgram,
    ]);

    const initMarketIx = buildIx({
      programId: PROGRAM_ID,
      keys: initMarketKeys,
      data: initMarketData,
    });

    // Execute setup transactions
    const setupTx = new Transaction();
    setupTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
    setupTx.add(createSlabIx);
    setupTx.add(createVaultAtaIx);

    await sendAndConfirmTransaction(this.connection, setupTx, [this.payer, slab], {
      commitment: "confirmed",
    });

    // Init market in separate tx
    const initTx = new Transaction();
    initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
    initTx.add(initMarketIx);

    await sendAndConfirmTransaction(this.connection, initTx, [this.payer], {
      commitment: "confirmed",
    });

    return {
      connection: this.connection,
      payer: this.payer,
      programId: PROGRAM_ID,
      slab,
      mint,
      vault,
      vaultPda,
      oracle,
      users: new Map(),
      lps: new Map(),
    };
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

    // Create user's ATA
    const userAta = await getAssociatedTokenAddress(ctx.mint, userKp.publicKey);
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        this.payer.publicKey,
        userAta,
        userKp.publicKey,
        ctx.mint
      )
    );
    await sendAndConfirmTransaction(this.connection, createAtaTx, [this.payer]);

    // Mint tokens to user
    if (fundAmount > 0n) {
      await mintTo(
        this.connection,
        this.payer,
        ctx.mint,
        userAta,
        this.payer,
        fundAmount
      );
    }

    const userCtx: UserContext = { keypair: userKp, ata: userAta, accountIndex: -1 };
    ctx.users.set(name, userCtx);
    return userCtx;
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
   * Execute keeper crank using payer.
   * Note: Requires payer to be the owner of account at callerIdx.
   * @param callerIdx - Index of the caller account (usually 0)
   * @param allowPanic - Whether to allow panic on error
   */
  async keeperCrank(ctx: TestContext, cuLimit: number = 200000, callerIdx: number = 0, allowPanic: boolean = false): Promise<TxResult> {
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
      const result: TestResult = {
        name,
        passed: false,
        error: e.message,
        duration: Date.now() - start,
      };
      this.results.push(result);
      console.log(`  [FAIL] ${name}: ${e.message}`);
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
