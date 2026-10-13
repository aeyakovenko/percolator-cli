import assert from "node:assert/strict";
import test from "node:test";
import {
  OraclePriceSourceConfigurationError,
  assertOracleSourceLifecycleCompatibility,
  requireOraclePriceSource,
} from "./oracle-price-source.ts";

test("oracle source keeps sponsored Pyth as the safe deployed default", () => {
  assert.equal(requireOraclePriceSource({}), "pyth-solana-push");
  assert.equal(
    requireOraclePriceSource({ PYTH_PRICE_SOURCE: "hermes" }),
    "pyth-hermes",
  );
});

test("MagicBlock source refuses to boot while unsupported assets are live", () => {
  assert.doesNotThrow(() => assertOracleSourceLifecycleCompatibility(
    "magicblock-demo",
    [
      { asset: 0, lifecycle: 2 },
      { asset: 1, lifecycle: 3 },
      { asset: 2, lifecycle: 2 },
      { asset: 3, lifecycle: 4 },
    ],
  ));
  assert.throws(
    () => assertOracleSourceLifecycleCompatibility(
      "magicblock-demo",
      [{ asset: 3, lifecycle: 2 }],
    ),
    /asset indexes 3/,
  );
  assert.doesNotThrow(() => assertOracleSourceLifecycleCompatibility(
    "pyth-solana-push",
    [{ asset: 2, lifecycle: 2 }],
  ));
});

test("MagicBlock demo requires an explicit top-level source selection", () => {
  assert.equal(
    requireOraclePriceSource({
      ORACLE_PRICE_SOURCE: "magicblock-demo",
      PYTH_PRICE_SOURCE: "solana-push",
    }),
    "magicblock-demo",
  );
  assert.throws(
    () => requireOraclePriceSource({ ORACLE_PRICE_SOURCE: "magicblock" }),
    OraclePriceSourceConfigurationError,
  );
  assert.throws(
    () => requireOraclePriceSource({ PYTH_PRICE_SOURCE: "exchange" }),
    OraclePriceSourceConfigurationError,
  );
});
