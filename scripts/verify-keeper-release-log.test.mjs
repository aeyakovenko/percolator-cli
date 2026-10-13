import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifier = new URL("./verify-keeper-release-log.mjs", import.meta.url);
const MACHINE = "abc123def45678";
const SOURCE = "0123456789abcdef0123456789abcdef01234567";
const RELEASE = "123456-1";
const CUTOFF = "2030-01-01T03:00:00.000Z";
const ORACLE_PRICE_SOURCE = "magicblock-demo";

function line({
  timestamp = "2030-01-01T03:00:01.000Z",
  instance = MACHINE,
  source = SOURCE,
  releaseId = RELEASE,
  event = "confirmed-push",
  oraclePriceSource = ORACLE_PRICE_SOURCE,
  message,
} = {}) {
  return JSON.stringify({
    timestamp,
    instance,
    message: message ?? `NINJA_KEEPER_HEALTH ${JSON.stringify({ event, source, releaseId, oraclePriceSource })}`,
  });
}

function verify(input, mode = "strict", oraclePriceSource = ORACLE_PRICE_SOURCE) {
  return spawnSync(
    process.execPath,
    [verifier.pathname, MACHINE, SOURCE, RELEASE, CUTOFF, mode, oraclePriceSource],
    { encoding: "utf8", input },
  );
}

test("accepts only a fresh exact-machine exact-release confirmed push", () => {
  const result = verify(line());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified release keeper write/);
});

test("rejects stale, wrong-machine, wrong-source, wrong-release, and wrong-event markers", () => {
  for (const candidate of [
    line({ timestamp: "2030-01-01T02:59:59.999Z" }),
    line({ instance: "fedcba98765432" }),
    line({ source: "a".repeat(40) }),
    line({ releaseId: "other-1" }),
    line({ event: "keeper-start" }),
    line({ oraclePriceSource: "pyth-solana-push" }),
  ]) {
    const result = verify(candidate);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no fresh matching/);
  }
});

test("ignores malformed and unrelated log lines", () => {
  const result = verify([
    "not-json",
    JSON.stringify({ timestamp: "2030-01-01T03:00:01.000Z", instance: MACHINE, message: "hello" }),
    line(),
  ].join("\n"));
  assert.equal(result.status, 0, result.stderr);
});

test("accepts Fly's pretty-printed multi-object JSON stream", () => {
  const input = [
    JSON.stringify(JSON.parse(line({ message: "unrelated { application } log" })), null, 4),
    JSON.stringify(JSON.parse(line()), null, 4),
  ].join("\n");
  const result = verify(input);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified release keeper write/);
});

test("legacy push text is rejected for a candidate release", () => {
  const result = verify(line({ message: "  [03:00:01] push+crank ✓ signature…" }));
  assert.notEqual(result.status, 0);
});

test("legacy rollback mode accepts only a fresh exact-machine push+crank", () => {
  const accepted = verify(line({ message: "  [03:00:01] push+crank ✓ signature…" }), "legacy-rollback");
  assert.equal(accepted.status, 0, accepted.stderr);

  const stale = verify(line({
    timestamp: "2030-01-01T02:59:59.999Z",
    message: "  [02:59:59] push+crank ✓ signature…",
  }), "legacy-rollback");
  assert.notEqual(stale.status, 0);
});

test("rejects an invalid expected oracle source", () => {
  const result = verify(line(), "strict", "anything");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid oracle price source/);
});
