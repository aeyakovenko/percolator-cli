#!/usr/bin/env node
/**
 * Percolator Test Suite Runner
 *
 * Executes all test suites (T1-T10) and generates summary report.
 *
 * Usage:
 *   npx tsx tests/runner.ts           # Run all tests
 *   npx tsx tests/runner.ts t1 t2     # Run specific tests
 *   npx tsx tests/runner.ts --quick   # Run quick subset
 */

import { runT1Tests } from "./t1-market-boot.js";
import { runT2Tests } from "./t2-user-lifecycle.js";
import { runT3Tests } from "./t3-capital.js";
import { runT4Tests } from "./t4-trading.js";
import { runT5Tests } from "./t5-oracle.js";
import { runT6Tests } from "./t6-liquidation.js";
import { runT7Tests } from "./t7-socialization.js";
import { runT8Tests } from "./t8-crank.js";
import { runT9Tests } from "./t9-determinism.js";
import { runT10Tests } from "./t10-adversarial.js";
import { runT11Tests } from "./t11-inverted-markets.js";

interface SuiteInfo {
  name: string;
  description: string;
  run: () => Promise<void>;
  quick?: boolean; // Include in quick run
}

const ALL_SUITES: SuiteInfo[] = [
  { name: "t1", description: "Market Boot & Layout", run: runT1Tests, quick: true },
  { name: "t2", description: "User Lifecycle", run: runT2Tests, quick: true },
  { name: "t3", description: "Capital & Withdrawal", run: runT3Tests, quick: true },
  { name: "t4", description: "Trading & Matching", run: runT4Tests },
  { name: "t5", description: "Oracle & Price Movement", run: runT5Tests },
  { name: "t6", description: "Liquidation Edge", run: runT6Tests },
  { name: "t7", description: "Loss Socialization", run: runT7Tests },
  { name: "t8", description: "Crank & Scaling", run: runT8Tests },
  { name: "t9", description: "Determinism & Replay", run: runT9Tests, quick: true },
  { name: "t10", description: "Adversarial", run: runT10Tests },
  { name: "t11", description: "Inverted Markets", run: runT11Tests },
];

async function main() {
  const args = process.argv.slice(2);

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         PERCOLATOR DEVNET CONFORMANCE TEST SUITE           ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log("");

  let suitesToRun: SuiteInfo[];

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("--quick") || args.includes("-q")) {
    suitesToRun = ALL_SUITES.filter(s => s.quick);
    console.log("Running QUICK test subset...\n");
  } else if (args.includes("--list") || args.includes("-l")) {
    printSuites();
    return;
  } else if (args.length > 0 && !args[0].startsWith("-")) {
    // Run specific suites
    const requestedNames = args.map(a => a.toLowerCase());
    suitesToRun = ALL_SUITES.filter(s =>
      requestedNames.includes(s.name.toLowerCase())
    );

    if (suitesToRun.length === 0) {
      console.error(`No matching test suites found for: ${args.join(", ")}`);
      console.error("Use --list to see available suites");
      process.exit(1);
    }
  } else {
    suitesToRun = ALL_SUITES;
    console.log("Running ALL test suites...\n");
  }

  console.log("Suites to run:");
  for (const suite of suitesToRun) {
    console.log(`  - ${suite.name.toUpperCase()}: ${suite.description}`);
  }
  console.log("");

  const startTime = Date.now();
  const results: { name: string; success: boolean; error?: string; duration: number }[] = [];

  for (const suite of suitesToRun) {
    const suiteStart = Date.now();
    try {
      await suite.run();
      results.push({
        name: suite.name.toUpperCase(),
        success: true,
        duration: Date.now() - suiteStart,
      });
    } catch (e: any) {
      results.push({
        name: suite.name.toUpperCase(),
        success: false,
        error: e.message,
        duration: Date.now() - suiteStart,
      });
    }
  }

  const totalDuration = Date.now() - startTime;

  // Print summary
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║                    FINAL TEST SUMMARY                       ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  for (const r of results) {
    const status = r.success ? "✓ PASS" : "✗ FAIL";
    const duration = (r.duration / 1000).toFixed(1);
    console.log(`  ${status}  ${r.name.padEnd(5)} (${duration}s)`);
    if (r.error) {
      console.log(`         Error: ${r.error.slice(0, 60)}`);
    }
  }

  console.log("");
  console.log("────────────────────────────────────────────────────────────");
  console.log(`  Total: ${results.length} suites | Passed: ${passed} | Failed: ${failed}`);
  console.log(`  Time: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log("────────────────────────────────────────────────────────────");

  if (failed > 0) {
    console.log("\n⚠️  Some test suites failed!");
    process.exit(1);
  } else {
    console.log("\n✅ All test suites passed!");
  }
}

function printHelp() {
  console.log(`
Usage: npx tsx tests/runner.ts [options] [suites...]

Options:
  --help, -h     Show this help message
  --list, -l     List all available test suites
  --quick, -q    Run only quick tests (T1, T2, T3, T9)

Examples:
  npx tsx tests/runner.ts            # Run all tests
  npx tsx tests/runner.ts t1 t2      # Run T1 and T2 only
  npx tsx tests/runner.ts --quick    # Run quick subset

Test Suites:
  T1  - Market Boot & Layout Tests
  T2  - User Lifecycle Tests
  T3  - Capital & Withdrawal Tests
  T4  - Trading & Matching Tests
  T5  - Oracle & Price Movement Tests
  T6  - Liquidation Edge Tests
  T7  - Loss Socialization Tests
  T8  - Crank & Scaling Tests
  T9  - Determinism & Replay Tests
  T10 - Adversarial Tests
  T11 - Inverted Markets Tests
`);
}

function printSuites() {
  console.log("Available test suites:\n");
  for (const suite of ALL_SUITES) {
    const quick = suite.quick ? " [quick]" : "";
    console.log(`  ${suite.name.toUpperCase().padEnd(5)} - ${suite.description}${quick}`);
  }
  console.log("");
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
