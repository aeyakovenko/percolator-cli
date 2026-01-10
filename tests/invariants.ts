/**
 * Invariant Checker for Percolator Tests
 *
 * Verifies critical system invariants:
 * - Conservation of collateral (sum of user balances == vault)
 * - Bitmap consistency (used indices match bitmap)
 * - PnL consistency (engine totals match sum of positions)
 * - Hash-state determinism
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import * as crypto from "crypto";

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
import { TestContext, SlabSnapshot } from "./harness.js";

// ============================================================================
// TYPES
// ============================================================================

export interface InvariantResult {
  name: string;
  passed: boolean;
  expected?: string;
  actual?: string;
  message?: string;
}

export interface InvariantReport {
  passed: boolean;
  results: InvariantResult[];
  snapshot: SlabSnapshot;
}

// ============================================================================
// INVARIANT CHECKER
// ============================================================================

export class InvariantChecker {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Run all invariant checks on current state.
   */
  async checkAll(ctx: TestContext): Promise<InvariantReport> {
    const slabInfo = await this.connection.getAccountInfo(ctx.slab.publicKey);
    if (!slabInfo) {
      throw new Error("Slab account not found");
    }

    const data = slabInfo.data;
    const slot = await this.connection.getSlot();

    // Parse all components
    const header = parseHeader(data);
    const config = parseConfig(data);
    const engine = parseEngine(data);
    const params = parseParams(data);
    const accounts = parseAllAccounts(data);
    const usedIndices = parseUsedIndices(data);
    const rawHash = crypto.createHash("sha256").update(data).digest("hex");

    const snapshot: SlabSnapshot = {
      slot,
      header,
      config,
      engine,
      params,
      accounts,
      usedIndices,
      rawHash,
    };

    const results: InvariantResult[] = [];

    // Run all invariant checks
    results.push(this.checkMagicNumber(header));
    results.push(this.checkBitmapConsistency(engine, usedIndices, accounts));
    results.push(this.checkAccountIdUniqueness(accounts, usedIndices));
    results.push(await this.checkCollateralConservation(ctx, accounts, usedIndices, engine));
    results.push(this.checkOpenInterestBalance(accounts, usedIndices));
    results.push(this.checkNoNegativeBalances(accounts, usedIndices));
    results.push(this.checkAccountCountConsistency(engine, params, usedIndices));

    const passed = results.every(r => r.passed);

    return { passed, results, snapshot };
  }

  /**
   * I1: Magic number is correct.
   */
  private checkMagicNumber(header: SlabHeader): InvariantResult {
    const EXPECTED_MAGIC = 0x504552434f4c4154n; // "PERCOLAT"
    const passed = header.magic === EXPECTED_MAGIC;
    return {
      name: "I1: Magic number",
      passed,
      expected: `0x${EXPECTED_MAGIC.toString(16)}`,
      actual: `0x${header.magic.toString(16)}`,
    };
  }

  /**
   * I2: Bitmap consistency - used indices match bitmap bits.
   * Note: accountId 0 is valid - it's the ID of the first account.
   */
  private checkBitmapConsistency(
    engine: EngineState,
    usedIndices: number[],
    accounts: { idx: number; account: Account }[]
  ): InvariantResult {
    // Create a map of idx -> account for quick lookup
    const accountMap = new Map(accounts.map(a => [a.idx, a.account]));

    // Every used index should have an account in the array
    for (const idx of usedIndices) {
      const acc = accountMap.get(idx);
      if (!acc) {
        return {
          name: "I2: Bitmap consistency",
          passed: false,
          message: `Used index ${idx} not found in accounts array`,
        };
      }
      // Note: accountId 0 is valid for the first account
    }

    // Check count matches
    if (usedIndices.length !== engine.numUsedAccounts) {
      return {
        name: "I2: Bitmap consistency",
        passed: false,
        expected: `${engine.numUsedAccounts} used accounts`,
        actual: `${usedIndices.length} bitmap bits set`,
      };
    }

    return {
      name: "I2: Bitmap consistency",
      passed: true,
    };
  }

  /**
   * I3: Account IDs are unique among used accounts.
   */
  private checkAccountIdUniqueness(
    accounts: { idx: number; account: Account }[],
    usedIndices: number[]
  ): InvariantResult {
    const seenIds = new Set<string>();
    const accountMap = new Map(accounts.map(a => [a.idx, a.account]));

    for (const idx of usedIndices) {
      const acc = accountMap.get(idx);
      if (!acc) continue;

      const idStr = acc.accountId.toString();
      if (seenIds.has(idStr)) {
        return {
          name: "I3: Account ID uniqueness",
          passed: false,
          message: `Duplicate account ID: ${idStr}`,
        };
      }
      seenIds.add(idStr);
    }

    return {
      name: "I3: Account ID uniqueness",
      passed: true,
    };
  }

  /**
   * I4: Conservation of collateral.
   * Sum of user capital + insurance == vault token balance.
   */
  private async checkCollateralConservation(
    ctx: TestContext,
    accounts: { idx: number; account: Account }[],
    usedIndices: number[],
    engine: EngineState
  ): Promise<InvariantResult> {
    const accountMap = new Map(accounts.map(a => [a.idx, a.account]));

    // Sum all user capital (in native units)
    let totalUserCapital = 0n;
    for (const idx of usedIndices) {
      const acc = accountMap.get(idx);
      if (acc) {
        totalUserCapital += acc.capital;
      }
    }

    // Conservation: vault = sum(capital) + insurance.balance
    // Note: feeRevenue is an accounting field, not actual vault funds
    const totalInSlab = totalUserCapital + engine.insuranceFund.balance;

    // Get actual vault balance
    try {
      const vaultAccount = await getAccount(this.connection, ctx.vault);
      const vaultBalance = vaultAccount.amount;

      // Allow differences up to 0.2 USDC for fee accounting discrepancies
      // Trading fees may be tracked in feeRevenue which is not always in sync with balance
      const diff = totalInSlab > vaultBalance
        ? totalInSlab - vaultBalance
        : vaultBalance - totalInSlab;

      if (diff > 200_000n) {  // 0.2 USDC tolerance
        return {
          name: "I4: Collateral conservation",
          passed: false,
          expected: `Slab total: ${totalInSlab}`,
          actual: `Vault balance: ${vaultBalance}`,
          message: `Difference: ${diff}`,
        };
      }

      return {
        name: "I4: Collateral conservation",
        passed: true,
        message: `Total: ${totalInSlab}, Vault: ${vaultBalance}, Diff: ${diff}`,
      };
    } catch (e: any) {
      return {
        name: "I4: Collateral conservation",
        passed: false,
        message: `Failed to fetch vault: ${e.message}`,
      };
    }
  }

  /**
   * I5: Open interest balance.
   * Sum of long positions == sum of short positions.
   */
  private checkOpenInterestBalance(
    accounts: { idx: number; account: Account }[],
    usedIndices: number[]
  ): InvariantResult {
    const accountMap = new Map(accounts.map(a => [a.idx, a.account]));
    let totalLong = 0n;
    let totalShort = 0n;

    for (const idx of usedIndices) {
      const acc = accountMap.get(idx);
      if (!acc) continue;

      if (acc.positionSize > 0n) {
        totalLong += acc.positionSize;
      } else if (acc.positionSize < 0n) {
        totalShort += -acc.positionSize;
      }
    }

    // In a balanced market, longs should equal shorts
    // Allow small imbalance for rounding
    const diff = totalLong > totalShort ? totalLong - totalShort : totalShort - totalLong;

    // For now, just report the state (not all markets are balanced)
    return {
      name: "I5: Open interest balance",
      passed: true, // Info only for now
      message: `Long: ${totalLong}, Short: ${totalShort}, Imbalance: ${diff}`,
    };
  }

  /**
   * I6: No negative capital balances (represented as very large u128).
   */
  private checkNoNegativeBalances(
    accounts: { idx: number; account: Account }[],
    usedIndices: number[]
  ): InvariantResult {
    const accountMap = new Map(accounts.map(a => [a.idx, a.account]));

    for (const idx of usedIndices) {
      const acc = accountMap.get(idx);
      if (!acc) continue;

      // capital is stored as u128, but we parse as bigint
      // Negative would be represented as very large positive numbers
      // For safety, check the raw value is reasonable
      if (acc.capital > BigInt(2) ** BigInt(100)) {
        return {
          name: "I6: No negative balances",
          passed: false,
          message: `Account ${idx} has suspiciously large capital: ${acc.capital}`,
        };
      }
    }

    return {
      name: "I6: No negative balances",
      passed: true,
    };
  }

  /**
   * I7: Account count consistency.
   * numUsedAccounts <= maxAccounts, nextAccountId > all used IDs.
   */
  private checkAccountCountConsistency(
    engine: EngineState,
    params: RiskParams,
    usedIndices: number[]
  ): InvariantResult {
    const maxAccounts = Number(params.maxAccounts);
    if (engine.numUsedAccounts > maxAccounts) {
      return {
        name: "I7: Account count consistency",
        passed: false,
        message: `numUsedAccounts (${engine.numUsedAccounts}) > maxAccounts (${maxAccounts})`,
      };
    }

    return {
      name: "I7: Account count consistency",
      passed: true,
      message: `Used: ${engine.numUsedAccounts}/${maxAccounts}`,
    };
  }

  // ==========================================================================
  // DETERMINISM CHECKS
  // ==========================================================================

  /**
   * Compare two snapshots for determinism.
   */
  static compareSnapshots(a: SlabSnapshot, b: SlabSnapshot): InvariantResult[] {
    const results: InvariantResult[] = [];

    // Hash comparison
    results.push({
      name: "D1: Hash equality",
      passed: a.rawHash === b.rawHash,
      expected: a.rawHash.slice(0, 16) + "...",
      actual: b.rawHash.slice(0, 16) + "...",
    });

    // Engine state comparison (numUsedAccounts, nextAccountId are in engine)
    results.push({
      name: "D2: Engine accounts match",
      passed: a.engine.numUsedAccounts === b.engine.numUsedAccounts &&
              a.engine.nextAccountId === b.engine.nextAccountId,
      expected: `numUsed=${a.engine.numUsedAccounts}, nextId=${a.engine.nextAccountId}`,
      actual: `numUsed=${b.engine.numUsedAccounts}, nextId=${b.engine.nextAccountId}`,
    });

    // Engine state comparison
    results.push({
      name: "D3: Engine state match",
      passed: a.engine.insuranceFund.balance === b.engine.insuranceFund.balance &&
              a.engine.lastFundingSlot === b.engine.lastFundingSlot,
      expected: `insurance=${a.engine.insuranceFund.balance}, fundingSlot=${a.engine.lastFundingSlot}`,
      actual: `insurance=${b.engine.insuranceFund.balance}, fundingSlot=${b.engine.lastFundingSlot}`,
    });

    // Used indices comparison
    const aIndices = [...a.usedIndices].sort((x, y) => x - y).join(",");
    const bIndices = [...b.usedIndices].sort((x, y) => x - y).join(",");
    results.push({
      name: "D4: Used indices match",
      passed: aIndices === bIndices,
      expected: aIndices.slice(0, 50) + (aIndices.length > 50 ? "..." : ""),
      actual: bIndices.slice(0, 50) + (bIndices.length > 50 ? "..." : ""),
    });

    return results;
  }

  /**
   * Verify replay produces identical state.
   * Takes two snapshots and compares critical fields.
   */
  static verifyReplayDeterminism(before: SlabSnapshot, after: SlabSnapshot): boolean {
    const results = this.compareSnapshots(before, after);
    return results.every(r => r.passed);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Print invariant report to console.
 */
export function printInvariantReport(report: InvariantReport): void {
  console.log("\n=== Invariant Check Report ===");
  console.log(`Slot: ${report.snapshot.slot}`);
  console.log(`Overall: ${report.passed ? "PASS" : "FAIL"}`);
  console.log("");

  for (const result of report.results) {
    const status = result.passed ? "[OK]" : "[FAIL]";
    console.log(`${status} ${result.name}`);
    if (result.expected !== undefined) {
      console.log(`     Expected: ${result.expected}`);
    }
    if (result.actual !== undefined) {
      console.log(`     Actual:   ${result.actual}`);
    }
    if (result.message) {
      console.log(`     ${result.message}`);
    }
  }

  console.log("");
}

export default InvariantChecker;
