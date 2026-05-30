/**
 * Minimal offline test harness for the v16 parser/risk-decode suite.
 *
 * The pre-v16 t1–t22 suite (deleted in this change) span a live solana-test-
 * validator and a CLI/ABI layer that was removed in commit 2ddf8ca
 * ("v16: clean up pre-v16 code"). This replacement is deliberately the opposite:
 * a small, dependency-free, OFFLINE harness that exercises the v16 risk-state
 * parsers against committed golden vectors (real on-chain accounts captured via
 * getAccountInfo). No network, no validator, no keypair — `npm test` runs it.
 *
 * Style mirrors scripts/verify-manifest.ts: collect pass/fail strings, print,
 * exit non-zero on any failure.
 */
export interface TestResult {
  passed: number;
  failed: number;
}

export class Suite {
  private oks: string[] = [];
  private fails: string[] = [];
  constructor(public readonly name: string) {}

  /** Assert a boolean condition. */
  check(cond: boolean, msg: string): void {
    (cond ? this.oks : this.fails).push(msg);
  }

  /** Assert equality, rendering bigint/number/string mismatches clearly. */
  eq(got: unknown, want: unknown, msg: string): void {
    const ok = typeof got === "bigint" || typeof want === "bigint"
      ? BigInt(got as bigint) === BigInt(want as bigint)
      : got === want;
    this.check(ok, ok ? msg : `${msg}  (got ${String(got)}, want ${String(want)})`);
  }

  /** Run a block of checks; a thrown error is recorded as a failure, not a crash. */
  run(label: string, fn: () => void): void {
    try {
      fn();
    } catch (e: any) {
      this.fails.push(`${label}: threw ${e?.message ?? e}`);
    }
  }

  report(): TestResult {
    console.log(`\n=== ${this.name} ===`);
    for (const o of this.oks) console.log(`  ✅ ${o}`);
    for (const f of this.fails) console.log(`  ❌ ${f}`);
    const passed = this.oks.length;
    const failed = this.fails.length;
    console.log(`  ${failed === 0 ? "✅" : "🚨"} ${passed}/${passed + failed} checks passed`);
    return { passed, failed };
  }
}
