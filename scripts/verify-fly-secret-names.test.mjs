import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifier = new URL("./verify-fly-secret-names.mjs", import.meta.url);
const BASE_NAMES = ["RPC_URL", "KEEPER_SECRET_KEY"];

function verify(payload, names = BASE_NAMES) {
  return spawnSync(process.execPath, [verifier.pathname, ...names], {
    encoding: "utf8",
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

test("accepts the base keeper secret names without exposing metadata fields", () => {
  const result = verify([
    { Name: "RPC_URL", Digest: "rpc-digest", Value: "sentinel-value" },
    { name: "KEEPER_SECRET_KEY", digest: "signer-digest", value: "sentinel-value" },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RPC_URL, KEEPER_SECRET_KEY/);
  assert.doesNotMatch(result.stdout, /sentinel-value|digest/);
});

test("requires the Hermes credential name only when requested", () => {
  const records = BASE_NAMES.map((Name) => ({ Name }));
  assert.equal(verify(records).status, 0);
  const missing = verify(records, [...BASE_NAMES, "PYTH_API_KEY"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /PYTH_API_KEY/);
  assert.equal(
    verify([...records, { Name: "PYTH_API_KEY" }], [...BASE_NAMES, "PYTH_API_KEY"]).status,
    0,
  );
});

test("rejects missing, duplicate, or malformed names", () => {
  assert.notEqual(verify([{ Name: "RPC_URL" }]).status, 0);
  assert.notEqual(verify([{ Name: "RPC_URL" }, { name: "RPC_URL" }]).status, 0);
  assert.notEqual(verify([...BASE_NAMES.map((Name) => ({ Name })), { Name: "bad-name" }]).status, 0);
  assert.notEqual(verify(BASE_NAMES.map((Name) => ({ Name })), ["RPC_URL", "RPC_URL"]).status, 0);
  assert.notEqual(verify(BASE_NAMES.map((Name) => ({ Name })), ["bad-name"]).status, 0);
});

test("rejects invalid and oversized JSON", () => {
  assert.notEqual(verify("{").status, 0);
  assert.notEqual(verify({ secrets: BASE_NAMES.map((Name) => ({ Name })) }).status, 0);
  assert.notEqual(verify(`["${"x".repeat(256 * 1024)}"]`).status, 0);
});
