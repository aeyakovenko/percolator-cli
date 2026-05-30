/**
 * v16 offline test runner. Wired into `npm test` (after the manifest check).
 * Runs every *.test.ts suite, aggregates pass/fail, exits non-zero on any failure.
 *
 * Everything here is OFFLINE — golden-vector fixtures + pure risk math, no RPC,
 * no validator, no keypair. This is the regression guard for the v16 risk-state
 * decode path (the parsers that the keeper and scripts/v16-inspect.ts depend on).
 */
import { runParserTests } from "./parsers.test.js";
import { runCapacityGuardTests } from "./capacity-guard.test.js";
import { runLiquidationTests } from "./liquidation.test.js";

const suites = [runParserTests, runCapacityGuardTests, runLiquidationTests];

let passed = 0;
let failed = 0;
for (const run of suites) {
  const r = run();
  passed += r.passed;
  failed += r.failed;
}

console.log(`\n${"=".repeat(48)}`);
console.log(`${failed === 0 ? "✅" : "🚨"} v16 offline suite: ${passed}/${passed + failed} checks passed` +
  (failed ? `  (${failed} failed)` : ""));
process.exit(failed === 0 ? 0 : 1);
