import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveV16HealthCheckConfig } from "./check-current-market-health.ts";

const VALID_ENV = {
  LP_PORTFOLIO: "11111111111111111111111111111111",
  MARKET: "11111111111111111111111111111111",
  PROGRAM_ID: "11111111111111111111111111111111",
  RPC_URL: "https://rpc.example.invalid/path",
};

test("read-only checker requires every RPC and account identity explicitly", () => {
  for (const name of ["RPC_URL", "PROGRAM_ID", "MARKET", "LP_PORTFOLIO"] as const) {
    const env: Record<string, string | undefined> = { ...VALID_ENV };
    delete env[name];
    assert.throws(() => resolveV16HealthCheckConfig(env), new RegExp(`${name} is required`));
  }
});

test("read-only checker validates RPC credentials and every public key", () => {
  assert.throws(
    () => resolveV16HealthCheckConfig({
      ...VALID_ENV,
      RPC_URL: "https://user:password@rpc.example.invalid/path",
    }),
    /must not embed HTTP credentials/,
  );
  for (const name of ["PROGRAM_ID", "MARKET", "LP_PORTFOLIO"] as const) {
    assert.throws(
      () => resolveV16HealthCheckConfig({ ...VALID_ENV, [name]: "not-a-public-key" }),
      new RegExp(`${name} must be a base58 Solana public key`),
    );
  }
});

test("explicit checker configuration preserves strict recovery defaults", () => {
  const config = resolveV16HealthCheckConfig(VALID_ENV);
  assert.equal(config.runtime.rpcUrl, VALID_ENV.RPC_URL);
  assert.equal(config.runtime.commitment, "confirmed");
  assert.equal(config.runtime.programId.toBase58(), VALID_ENV.PROGRAM_ID);
  assert.equal(config.market.toBase58(), VALID_ENV.MARKET);
  assert.equal(config.lpPortfolio.toBase58(), VALID_ENV.LP_PORTFOLIO);
  assert.equal(config.minimumLpCapital, 10_000_000_000n);
  assert.equal(config.auditProfile.name, "recovery");
  assert.equal(config.auditProfile.options.requireFullSourceCredit, true);
});

test("checker batches context reads and contains no write or simulation path", () => {
  const source = readFileSync(new URL("./check-current-market-health.ts", import.meta.url), "utf8");
  assert.match(source, /getMultipleAccountsInfoAndContext/);
  assert.match(source, /minContextSlot/);
  assert.match(source, /AccountLayout\.decode/);
  assert.match(source, /disableRetryOnRateLimit: true/);
  assert.doesNotMatch(source, /getTokenAccountBalance/);
  assert.doesNotMatch(
    source,
    /sendRawTransaction|sendTransaction|simulateTransaction|TransactionInstruction/,
  );
  assert.doesNotMatch(source, /7C37Xn3|DNhYhm8|BWqxjf1/);
  assert.doesNotMatch(source, /process\.env\.(PROGRAM_ID|MARKET|LP_PORTFOLIO)\s*\?\?/);
});
