/**
 * `npm test` entry point. Runs the offline test surface in sequence:
 *   1. scripts/verify-manifest.ts — bounty-5 manifest integrity (CLI #72/#77)
 *   2. tests/v16/runner.ts        — v16 risk-state parser + liquidation-math suite
 *
 * Both are offline (no RPC/keypair). Each child exits non-zero on failure; this
 * wrapper propagates the first non-zero exit so CI fails loudly. The opt-in
 * on-chain manifest cross-check (VERIFY_ONCHAIN=1) is forwarded through the env.
 */
import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const steps: Array<{ name: string; script: string }> = [
  { name: "manifest integrity", script: path.join(REPO_ROOT, "scripts", "verify-manifest.ts") },
  { name: "v16 offline suite", script: path.join(HERE, "v16", "runner.ts") },
];

let failed = 0;
for (const step of steps) {
  console.log(`\n${"#".repeat(60)}\n# ${step.name}\n${"#".repeat(60)}`);
  const res = spawnSync("tsx", [step.script], { stdio: "inherit", env: process.env });
  // `tsx` may not be on PATH directly under some package managers; fall back to npx.
  if (res.error) {
    const viaNpx = spawnSync("npx", ["tsx", step.script], { stdio: "inherit", env: process.env });
    if (viaNpx.status !== 0) failed++;
  } else if (res.status !== 0) {
    failed++;
  }
}

console.log(`\n${"=".repeat(60)}`);
console.log(`${failed === 0 ? "✅ all test steps passed" : `🚨 ${failed} test step(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
