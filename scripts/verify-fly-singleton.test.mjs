import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifier = new URL("./verify-fly-singleton.mjs", import.meta.url);
const APP = "keeper-app";
const MACHINE = "abc123def45678";
const SOURCE = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"2".repeat(64)}`;

function status(state = "started", overrides = {}) {
  return {
    Name: APP,
    Machines: [{
      id: MACHINE,
      state,
      image_ref: { digest: DIGEST },
      config: { metadata: { source_revision: SOURCE } },
      ...overrides,
    }],
  };
}

function verify(input, args = [APP, MACHINE, "started", SOURCE, DIGEST]) {
  return spawnSync(process.execPath, [verifier.pathname, ...args], {
    encoding: "utf8",
    input: JSON.stringify(input),
  });
}

test("accepts the exact started singleton, source, and digest", () => {
  const result = verify(status());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified singleton/);
});

test("rejects a stopped singleton for a running promotion", () => {
  const result = verify(status("stopped"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be started/);
});

test("allows an explicit stopped-state inspection without weakening the running gate", () => {
  const result = verify(status("stopped"), [APP, MACHINE, "stopped", SOURCE, DIGEST]);
  assert.equal(result.status, 0, result.stderr);
});

test("rejects an additional machine", () => {
  const input = status();
  input.Machines.push({ id: "fedcba98765432", state: "stopped" });
  const result = verify(input);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one machine/);
});

test("rejects app, machine, source, and digest mismatches", () => {
  const wrongApp = verify({ ...status(), Name: "other-app" });
  assert.notEqual(wrongApp.status, 0);
  assert.match(wrongApp.stderr, /status belongs to/);

  const wrongMachine = verify(status("started", { id: "fedcba98765432" }));
  assert.notEqual(wrongMachine.status, 0);
  assert.match(wrongMachine.stderr, /does not match/);

  const wrongSource = verify(status("started", {
    config: { metadata: { source_revision: "a".repeat(40) } },
  }));
  assert.notEqual(wrongSource.status, 0);
  assert.match(wrongSource.stderr, /source revision/);

  const wrongDigest = verify(status("started", {
    image_ref: { digest: `sha256:${"b".repeat(64)}` },
  }));
  assert.notEqual(wrongDigest.status, 0);
  assert.match(wrongDigest.stderr, /image digest/);
});

test("rejects an in-flight machine state", () => {
  const result = verify(status("starting"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be started or stopped/);
});
