import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  parseKeeperAssets,
  requireKeeperExecutableConfiguration,
} from "./keeper-executable-config.ts";

function publicKey(fill: number): string {
  return new PublicKey(new Uint8Array(32).fill(fill)).toBase58();
}

const VALID_ASSETS = JSON.stringify([
  { index: 0, symbol: "SOL", feedId: "00".repeat(32) },
  { index: 2, symbol: "ETH", feedId: "11".repeat(32) },
]);

const VALID_ENV = {
  KEEPER_ASSETS_JSON: VALID_ASSETS,
  KEEPER_MODE: "shadow",
  LP_PORTFOLIO: publicKey(3),
  MARKET: publicKey(2),
  PROGRAM_ID: publicKey(1),
  RPC_URL: "https://rpc.example.invalid/keeper",
};

test("keeper executable requires every target, mode, and asset mapping explicitly", () => {
  for (const name of [
    "RPC_URL",
    "PROGRAM_ID",
    "MARKET",
    "LP_PORTFOLIO",
    "KEEPER_MODE",
    "KEEPER_ASSETS_JSON",
  ] as const) {
    const env: Record<string, string | undefined> = { ...VALID_ENV };
    delete env[name];
    assert.throws(() => requireKeeperExecutableConfiguration(env), new RegExp(`${name} is required`));
  }
});

test("keeper executable rejects credential-bearing RPCs and invalid or colliding identities", () => {
  assert.throws(
    () => requireKeeperExecutableConfiguration({
      ...VALID_ENV,
      RPC_URL: "https://user:password@rpc.example.invalid/keeper",
    }),
    /must not embed HTTP credentials/,
  );
  for (const name of ["PROGRAM_ID", "MARKET", "LP_PORTFOLIO"] as const) {
    assert.throws(
      () => requireKeeperExecutableConfiguration({ ...VALID_ENV, [name]: "invalid" }),
      new RegExp(`${name} must be a base58 Solana public key`),
    );
  }
  assert.throws(
    () => requireKeeperExecutableConfiguration({ ...VALID_ENV, MARKET: VALID_ENV.PROGRAM_ID }),
    /must be distinct/,
  );
});

test("keeper mode must be explicit and valid", () => {
  assert.throws(
    () => requireKeeperExecutableConfiguration({ ...VALID_ENV, KEEPER_MODE: "dry-run" }),
    /live or shadow/,
  );
  assert.equal(requireKeeperExecutableConfiguration(VALID_ENV).mode, "shadow");
  assert.equal(
    requireKeeperExecutableConfiguration({ ...VALID_ENV, KEEPER_MODE: "live" }).mode,
    "live",
  );
});

test("asset JSON fails closed on malformed shape, capacity, range, and ordering", () => {
  assert.throws(() => parseKeeperAssets("{"), /valid JSON/);
  assert.throws(() => parseKeeperAssets("{}"), /1 to 16/);
  assert.throws(() => parseKeeperAssets("[]"), /1 to 16/);
  assert.throws(
    () => parseKeeperAssets(JSON.stringify(Array.from({ length: 17 }, (_, index) => ({
      index,
      symbol: `A${index}`,
      feedId: index.toString(16).padStart(64, "0"),
    })))),
    /1 to 16/,
  );
  assert.throws(
    () => parseKeeperAssets(JSON.stringify([{ index: 16, symbol: "SOL", feedId: "00".repeat(32) }])),
    /0 to 15/,
  );
  assert.throws(
    () => parseKeeperAssets(JSON.stringify([
      { index: 1, symbol: "BTC", feedId: "11".repeat(32) },
      { index: 0, symbol: "SOL", feedId: "00".repeat(32) },
    ])),
    /strictly increasing/,
  );
});

test("asset JSON rejects unknown fields and duplicate indexes, symbols, or feeds", () => {
  assert.throws(
    () => parseKeeperAssets(JSON.stringify([{
      index: 0,
      symbol: "SOL",
      feedId: "00".repeat(32),
      enabled: true,
    }])),
    /contain only/,
  );
  assert.throws(
    () => parseKeeperAssets(JSON.stringify([
      { index: 0, symbol: "SOL", feedId: "00".repeat(32) },
      { index: 0, symbol: "BTC", feedId: "11".repeat(32) },
    ])),
    /strictly increasing/,
  );
  assert.throws(
    () => parseKeeperAssets(JSON.stringify([
      { index: 0, symbol: "SOL", feedId: "00".repeat(32) },
      { index: 1, symbol: "SOL", feedId: "11".repeat(32) },
    ])),
    /symbols must be unique/,
  );
  assert.throws(
    () => parseKeeperAssets(JSON.stringify([
      { index: 0, symbol: "SOL", feedId: "aa".repeat(32) },
      { index: 1, symbol: "BTC", feedId: "AA".repeat(32) },
    ])),
    /feed IDs must be unique/,
  );
});

test("valid explicit configuration normalizes immutable feed mappings", () => {
  const config = requireKeeperExecutableConfiguration(VALID_ENV);
  assert.equal(config.runtime.rpcUrl, VALID_ENV.RPC_URL);
  assert.equal(config.runtime.commitment, "confirmed");
  assert.equal(config.runtime.programId.toBase58(), VALID_ENV.PROGRAM_ID);
  assert.equal(config.market.toBase58(), VALID_ENV.MARKET);
  assert.equal(config.lpPortfolio.toBase58(), VALID_ENV.LP_PORTFOLIO);
  assert.deepEqual(config.assets, JSON.parse(VALID_ASSETS));
  assert.equal(Object.isFrozen(config.assets), true);
  assert.equal(Object.isFrozen(config.assets[0]), true);
});
