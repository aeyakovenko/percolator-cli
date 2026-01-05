import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { TxResult } from "../runtime/tx.js";

// Default CU budgets per instruction
// Based on Rust benchmarks with MAX_ACCOUNTS=4096 (BPF multiplier ~5x applied)
const DEFAULT_BUDGETS: Record<string, number> = {
  "init-market": 50_000,
  "init-user": 30_000,
  "init-lp": 30_000,
  deposit: 40_000,
  withdraw: 40_000,
  "keeper-crank": 80_000, // Benchmark: ~40k BPF for 4096 accounts
  "trade-nocpi": 50_000,
  "trade-cpi": 60_000,
  "liquidate-at-oracle": 80_000, // Benchmark: ~51k BPF for full scan
  "close-account": 80_000, // Similar to liquidation
  "topup-insurance": 30_000,
  "set-risk-threshold": 20_000,
  "update-admin": 20_000,
};

interface CuCheckpoint {
  label: string;
  remaining: number;
  elapsed?: number; // CU consumed since previous checkpoint
}

interface CuSummary {
  consumed: number;
  budget: number;
  programId?: string;
}

/**
 * Parse CU consumption from standard Solana program logs.
 * Format: "Program <id> consumed <used> of <budget> compute units"
 */
export function parseCuFromLogs(logs: string[]): CuSummary | null {
  for (const log of logs) {
    const match = log.match(
      /Program (\w+) consumed (\d+) of (\d+) compute units/
    );
    if (match) {
      return {
        programId: match[1],
        consumed: parseInt(match[2], 10),
        budget: parseInt(match[3], 10),
      };
    }
  }
  return null;
}

/**
 * Parse sol_log_compute_units output from logs.
 * Format: "Program log: <label>: <remaining> CU remaining"
 * or just: "Program consumption: <remaining> units remaining"
 */
export function parseCuCheckpoints(logs: string[]): CuCheckpoint[] {
  const checkpoints: CuCheckpoint[] = [];

  for (const log of logs) {
    // Match custom labeled checkpoints: "Program log: LABEL: 123456 CU remaining"
    const labeledMatch = log.match(
      /Program log: ([^:]+): (\d+) (?:CU|units) remaining/i
    );
    if (labeledMatch) {
      checkpoints.push({
        label: labeledMatch[1].trim(),
        remaining: parseInt(labeledMatch[2], 10),
      });
      continue;
    }

    // Match standard sol_log_compute_units output
    const standardMatch = log.match(/consumption: (\d+) units remaining/i);
    if (standardMatch) {
      checkpoints.push({
        label: `checkpoint_${checkpoints.length}`,
        remaining: parseInt(standardMatch[1], 10),
      });
    }
  }

  // Calculate elapsed CU between checkpoints
  for (let i = 1; i < checkpoints.length; i++) {
    checkpoints[i].elapsed =
      checkpoints[i - 1].remaining - checkpoints[i].remaining;
  }

  return checkpoints;
}

/**
 * Analyze CU usage from a transaction result.
 */
export interface CuAnalysis {
  totalConsumed: number;
  budget: number;
  remaining: number;
  percentUsed: number;
  overBudget: boolean;
  checkpoints: CuCheckpoint[];
}

export function analyzeCu(
  result: TxResult,
  instruction: string,
  customBudget?: number
): CuAnalysis {
  const budget = customBudget ?? DEFAULT_BUDGETS[instruction] ?? 200_000;
  const totalConsumed = result.unitsConsumed ?? 0;
  const checkpoints = parseCuCheckpoints(result.logs);

  return {
    totalConsumed,
    budget,
    remaining: budget - totalConsumed,
    percentUsed: (totalConsumed / budget) * 100,
    overBudget: totalConsumed > budget,
    checkpoints,
  };
}

/**
 * Format CU analysis for display.
 */
export function formatCuAnalysis(
  analysis: CuAnalysis,
  instruction: string,
  jsonMode: boolean
): string {
  if (jsonMode) {
    return JSON.stringify(
      {
        instruction,
        ...analysis,
      },
      null,
      2
    );
  }

  const lines: string[] = [];
  const status = analysis.overBudget ? "OVER BUDGET" : "OK";
  const statusColor = analysis.overBudget ? "!" : "";

  lines.push(`CU Audit: ${instruction}`);
  lines.push(`${"─".repeat(40)}`);
  lines.push(`Total Consumed: ${analysis.totalConsumed.toLocaleString()} CU`);
  lines.push(`Budget:         ${analysis.budget.toLocaleString()} CU`);
  lines.push(`Remaining:      ${analysis.remaining.toLocaleString()} CU`);
  lines.push(
    `Usage:          ${analysis.percentUsed.toFixed(1)}% ${statusColor}${status}`
  );

  if (analysis.checkpoints.length > 0) {
    lines.push("");
    lines.push("Checkpoints:");
    for (const cp of analysis.checkpoints) {
      const elapsed =
        cp.elapsed !== undefined
          ? ` (+${cp.elapsed.toLocaleString()} CU)`
          : "";
      lines.push(`  ${cp.label}: ${cp.remaining.toLocaleString()} remaining${elapsed}`);
    }
  }

  return lines.join("\n");
}

export function registerAuditCu(program: Command): void {
  program
    .command("audit-cu")
    .description("Analyze compute unit usage for instructions")
    .option("--instruction <name>", "Instruction name to analyze")
    .option("--budget <number>", "Custom CU budget to compare against")
    .option("--list-budgets", "List default CU budgets for all instructions")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);

      if (opts.listBudgets) {
        if (flags.json) {
          console.log(JSON.stringify(DEFAULT_BUDGETS, null, 2));
        } else {
          console.log("Default CU Budgets:");
          console.log("─".repeat(40));
          const sorted = Object.entries(DEFAULT_BUDGETS).sort(
            (a, b) => b[1] - a[1]
          );
          for (const [name, budget] of sorted) {
            const padded = name.padEnd(20);
            console.log(`  ${padded} ${budget.toLocaleString().padStart(10)} CU`);
          }
          console.log("");
          console.log("Benchmark results (4096 accounts, BPF ~5x native):");
          console.log("  keeper-crank:       ~40k CU (bitmap scan + funding)");
          console.log("  liquidate/close:    ~51k CU (full account scan)");
          console.log("  trade (with gate):  ~2k CU (LpRiskState::compute)");
          console.log("");
          console.log("All instructions WELL WITHIN 200k default budget.");
        }
        return;
      }

      if (!opts.instruction) {
        console.log("Usage: audit-cu --instruction <name> [--budget <number>]");
        console.log("       audit-cu --list-budgets");
        console.log("");
        console.log("Run a specific command with --simulate, then pipe logs here.");
        console.log("Or use: audit-cu --list-budgets to see default budgets.");
        return;
      }

      // For now, just display budget info for the instruction
      const instruction = opts.instruction;
      const budget = opts.budget
        ? parseInt(opts.budget, 10)
        : DEFAULT_BUDGETS[instruction];

      if (!budget) {
        console.log(`Unknown instruction: ${instruction}`);
        console.log("Use --list-budgets to see available instructions.");
        return;
      }

      console.log(`Instruction: ${instruction}`);
      console.log(`Budget: ${budget.toLocaleString()} CU`);
      console.log("");
      console.log("To measure actual CU consumption:");
      console.log(`  percolator-cli ${instruction} ... --simulate`);
    });
}
