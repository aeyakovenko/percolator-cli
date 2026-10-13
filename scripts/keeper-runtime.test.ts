import assert from "node:assert/strict";
import test from "node:test";

test('deadline diagnostics attribute phase without changing timeout or success semantics', async () => {
  const parentSignal = new AbortController().signal;
  await assert.rejects(runHardDeadlineOperation({ parentSignal, timeoutMs: 5,
    phase: 'maintenance-plan', work: () => new Promise(() => {}) }), (error: unknown) => {
    assert.ok(error instanceof KeeperFailure);
    assert.equal(error.kind, 'timeout'); assert.equal(error.phase, 'maintenance-plan');
    assert.ok(error.elapsedMs! >= 0); return true;
  });
  assert.equal(await runHardDeadlineOperation({ parentSignal, timeoutMs: 100,
    phase: 'base-rpc-http', work: async () => 7 }), 7);
  await assert.rejects(runHardDeadlineOperation({ parentSignal, timeoutMs: 100,
    phase: 'maintenance-plan', work: signal => runHardDeadlineOperation({
      parentSignal: signal, timeoutMs: 5, phase: 'base-rpc-http', work: () => new Promise(() => {}) }) }),
    (error: unknown) => { assert.ok(error instanceof KeeperFailure); assert.equal(error.phase, 'base-rpc-http'); return true; });
  const parent = new AbortController();
  await assert.rejects(runHardDeadlineOperation({ parentSignal: parent.signal, timeoutMs: 100,
    phase: 'maintenance-plan', work: async () => {
      const failure = new KeeperFailure('timeout', 'inner deadline');
      failure.phase = 'base-rpc-http'; failure.elapsedMs = 5;
      parent.abort(); throw failure;
    } }), (error: unknown) => {
      assert.ok(error instanceof KeeperFailure);
      assert.equal(error.kind, 'cancelled');
      return true;
    });
});
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  AssetQuarantine,
  BoundedShadowDecisionLog,
  buildShadowDecision,
  classifyPlannedInstructionSimulationFailure,
  executeKeeperPlan,
  instructionSimulationErrorIndex,
  isolateRejectedAssets,
  keeperModeFromEnv,
  recordSuccessfulShadowDecision,
  shouldResetRpcCircuitAfterPush,
  type DecisionSink,
} from "./keeper-shadow.ts";
import {
  abortableSleep,
  availableRecoveryNeedsCatchUp,
  classifyKeeperError,
  confirmConnectionTransaction,
  confirmedTransactionError,
  confirmationResultFromError,
  crankBufferSeedForMarket,
  ensureUsableCrankBuffer,
  fetchAvailableHermesFeeds,
  formatConfirmationFallbackError,
  formatUnhandledRejection,
  HermesFeedEntitlementQuarantine,
  isUsableLeglessCrankBuffer,
  isCustomProgramError,
  KeeperFailure,
  KeeperLifecycle,
  linkedAbortController,
  marketRecoveryStatusProbeDue,
  modelCatchupCadence,
  parseKeeperSecretKey,
  parseRecoveryClockLagSlots,
  PendingBroadcastGate,
  PushWatchdog,
  readV16LossStaleActive,
  readV16RecoveryStatus,
  requireConfiguredHermesFeeds,
  requireKeeperConfiguration,
  RpcCircuitBreaker,
  RpcOperationSignalScope,
  runDeadlineBoundOperation,
  runHardDeadlineOperation,
  runBoundedSelfHeal,
  safeErrorMessage,
  scheduleForcedExit,
  SingleTickRunner,
  V16_LOSS_STALE_ACTIVE_OFFSET,
  type Clock,
  type IntervalScheduler,
} from "./keeper-runtime.ts";

function fakeClock(startMs = 0, random = 0.5): Clock & { advance(ms: number): void; tasks: Array<{ cancelled: boolean; callback: () => void; delayMs: number }> } {
  let nowMs = startMs;
  const tasks: Array<{ cancelled: boolean; callback: () => void; delayMs: number }> = [];
  return {
    advance(ms) { nowMs += ms; },
    clearTimeout(handle) { (handle as unknown as { cancelled: boolean }).cancelled = true; },
    now: () => nowMs,
    random: () => random,
    setTimeout(callback, delayMs) {
      const handle = { callback, cancelled: false, delayMs };
      tasks.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    tasks,
  };
}

const flush = async () => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};

function shadowInstruction(byte: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    keys: [{
      pubkey: new PublicKey(Uint8Array.from({ length: 32 }, (_, index) => 255 - index)),
      isSigner: true,
      isWritable: true,
    }],
    data: Buffer.from([byte]),
  });
}

class MemoryDecisionSink implements DecisionSink {
  lines: string[] = [];
  rotations = 0;
  async append(line: string) { this.lines.push(line); }
  async bytes() { return Buffer.byteLength(this.lines.join("")); }
  async rotate() { this.rotations++; this.lines = []; }
}

test("shadow mode is explicit and invalid values fail closed", () => {
  assert.equal(keeperModeFromEnv({}), "live");
  assert.equal(keeperModeFromEnv({ KEEPER_MODE: " shadow " }), "shadow");
  assert.throws(() => keeperModeFromEnv({ KEEPER_MODE: "dry-run" }), /live or shadow/);
});

test("shadow push simulation resets only RPC circuit success semantics", () => {
  assert.equal(shouldResetRpcCircuitAfterPush("shadow", false), true);
  assert.equal(shouldResetRpcCircuitAfterPush("live", true), true);
  assert.equal(shouldResetRpcCircuitAfterPush("live", false), false);

  const clock = fakeClock(1_000, 0);
  const breaker = new RpcCircuitBreaker(clock, 30_000, 5_000, 15 * 60_000);
  breaker.recordFailure(new KeeperFailure("transport", "inconclusive simulation"));
  assert.deepEqual(breaker.snapshot(), { failures: 1, openUntilMs: 6_000 });
  if (shouldResetRpcCircuitAfterPush("shadow", false)) breaker.recordConfirmedSuccess();
  assert.deepEqual(breaker.snapshot(), { failures: 0, openUntilMs: 0 });

  const watchdog = new PushWatchdog(1_000);
  assert.equal(watchdog.lastSuccessMs(), null, "shadow circuit recovery must not advance the watchdog");
});

test("shadow execution can simulate and record but cannot enter the broadcast branch", async () => {
  let broadcasts = 0;
  let simulations = 0;
  let records = 0;
  const accepted = await executeKeeperPlan({
    mode: "shadow",
    broadcast: async () => { broadcasts++; return "landed"; },
    simulate: async () => { simulations++; return null; },
    onShadowAccepted: async () => { records++; return "decision"; },
  });
  assert.deepEqual(accepted, { mode: "shadow", simulationError: null, value: "decision" });
  assert.deepEqual({ broadcasts, simulations, records }, { broadcasts: 0, simulations: 1, records: 1 });

  const rejected = await executeKeeperPlan({
    mode: "shadow",
    broadcast: async () => { broadcasts++; return "landed"; },
    simulate: async () => ({ Custom: 9 }),
    onShadowAccepted: async () => { records++; return "decision"; },
  });
  assert.deepEqual(rejected, { mode: "shadow", simulationError: { Custom: 9 }, value: null });
  assert.deepEqual({ broadcasts, records }, { broadcasts: 0, records: 1 });

  const live = await executeKeeperPlan({
    mode: "live",
    broadcast: async () => { broadcasts++; return "landed"; },
    simulate: async () => { throw new Error("live mode must not simulate here"); },
    onShadowAccepted: async () => { throw new Error("live mode must not record shadow decisions"); },
  });
  assert.deepEqual(live, { mode: "live", value: "landed" });
  assert.equal(broadcasts, 1);
});

test("shadow decisions correlate by stable action while retaining exact intent", () => {
  const common = {
    action: "oracle-push" as const,
    assetIndexes: [3, 0, 3],
    createdAt: "2026-08-05T00:00:00.000Z",
    market: PublicKey.default.toBase58(),
    payer: PublicKey.default.toBase58(),
  };
  const first = buildShadowDecision({ ...common, instructions: [shadowInstruction(1)], observedSlot: 100n });
  const second = buildShadowDecision({ ...common, instructions: [shadowInstruction(2)], observedSlot: 101n });
  assert.equal(first.actionFingerprint, second.actionFingerprint);
  assert.notEqual(first.instructionDigest, second.instructionDigest);
  assert.notEqual(first.decisionId, second.decisionId);
  assert.deepEqual(first.assetIndexes, [0, 3]);
});

test("failed shadow simulation is not recorded and the decision log remains bounded", async () => {
  const sink = new MemoryDecisionSink();
  const log = new BoundedShadowDecisionLog(sink, 1024);
  const decisionInput = {
    action: "lp-crank" as const,
    assetIndexes: [0, 1, 2, 3],
    createdAt: "2026-08-05T00:00:00.000Z",
    instructions: [shadowInstruction(1)],
    market: PublicKey.default.toBase58(),
    observedSlot: 100n,
    payer: PublicKey.default.toBase58(),
  };
  assert.equal(await recordSuccessfulShadowDecision({ simulationError: { Custom: 1 }, log, decision: decisionInput }), null);
  assert.equal(sink.lines.length, 0);
  const accepted = await recordSuccessfulShadowDecision({ simulationError: null, log, decision: decisionInput });
  assert.ok(accepted);
  for (let slot = 101n; slot < 106n; slot++) {
    await log.append(buildShadowDecision({ ...decisionInput, observedSlot: slot }));
  }
  assert.ok(sink.rotations >= 1);
  assert.ok(sink.lines.length >= 1);
});

test("rejected assets are isolated with bounded probes and can re-enter after backoff", async () => {
  let now = 1_000;
  const quarantine = new AssetQuarantine(() => now, 100, 400);
  const assets = [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }];
  const probed: number[] = [];
  const isolated = await isolateRejectedAssets({
    assets,
    quarantine,
    simulate: async (asset) => {
      probed.push(asset.index);
      return asset.index === 2 ? { InstructionError: [2, { Custom: 9 }] } : null;
    },
    classifyFailure: (_asset, error) => instructionSimulationErrorIndex(error) === 2
      ? "asset-rejection"
      : "inconclusive",
  });
  assert.equal(isolated.inconclusive, false);
  assert.deepEqual(probed, [0, 1, 2, 3]);
  assert.deepEqual(isolated.healthy.map((asset) => asset.index), [0, 1, 3]);
  assert.deepEqual(quarantine.eligible(assets).map((asset) => asset.index), [0, 1, 3]);
  now += 100;
  assert.deepEqual(quarantine.eligible(assets).map((asset) => asset.index), [0, 1, 2, 3]);
  quarantine.recordConfirmedSuccess(2);
  assert.deepEqual(quarantine.snapshot(), []);

  const sharedFailure = new AssetQuarantine(() => now, 100, 400);
  const allRejected = await isolateRejectedAssets({
    assets,
    quarantine: sharedFailure,
    simulate: async () => ({ InstructionError: [2, { Custom: 21 }] }),
    classifyFailure: (_asset, error) => instructionSimulationErrorIndex(error) === 2
      ? "asset-rejection"
      : "inconclusive",
  });
  assert.deepEqual(allRejected.healthy, []);
  assert.deepEqual(allRejected.rejected, []);
  assert.equal(allRejected.inconclusive, false);
  assert.deepEqual(sharedFailure.snapshot(), [], 'a shared market failure must not quarantine every asset');
});

test("inconclusive simulation failures never quarantine the first probed asset", async () => {
  const quarantine = new AssetQuarantine(() => 1_000, 100, 400);
  const assets = [{ index: 0 }, { index: 1 }, { index: 2 }];
  const isolated = await isolateRejectedAssets({
    assets,
    quarantine,
    simulate: async (asset) => asset.index === 0 ? "BlockhashNotFound" : null,
    classifyFailure: (_asset, error) => instructionSimulationErrorIndex(error) === 2
      ? "asset-rejection"
      : "inconclusive",
  });
  assert.equal(isolated.inconclusive, true);
  assert.deepEqual(isolated.healthy, []);
  assert.deepEqual(isolated.rejected, []);
  assert.deepEqual(quarantine.snapshot(), []);
  assert.deepEqual(quarantine.eligible(assets).map((asset) => asset.index), [0, 1, 2]);
});

test("only a validated Solana InstructionError exposes a simulation instruction index", () => {
  assert.equal(instructionSimulationErrorIndex({ InstructionError: [2, { Custom: 9 }] }), 2);
  assert.equal(instructionSimulationErrorIndex("BlockhashNotFound"), null);
  assert.equal(instructionSimulationErrorIndex({ InstructionError: ["2", { Custom: 9 }] }), null);
  assert.equal(instructionSimulationErrorIndex({ InstructionError: [-1, { Custom: 9 }] }), null);
});

test("shadow crank rejection requires failure at the exact planned instruction", () => {
  assert.equal(
    classifyPlannedInstructionSimulationFailure({ InstructionError: [2, { Custom: 21 }] }, 2),
    "planned-instruction",
  );
  assert.equal(
    classifyPlannedInstructionSimulationFailure({ InstructionError: [1, { Custom: 21 }] }, 2),
    "other-instruction",
  );
  assert.equal(
    classifyPlannedInstructionSimulationFailure("BlockhashNotFound", 2),
    "inconclusive",
  );
});

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("Retry-After is never undercut and raw web3 Errors have no header claim", () => {
  const clock = fakeClock(1_000, 0); // local jitter would choose 24 seconds
  const breaker = new RpcCircuitBreaker(clock, 30_000, 5_000, 15 * 60_000);
  const directHttpFailure = classifyKeeperError({
    headers: { "retry-after": "60" },
    status: 429,
  }, undefined, clock.now());
  assert.equal(directHttpFailure.kind, "rate_limit");
  assert.equal(directHttpFailure.retryAfterMs, 60_000);
  assert.equal(breaker.recordFailure(directHttpFailure), 60_000);
  assert.deepEqual(breaker.snapshot(), { failures: 1, openUntilMs: 61_000 });

  // web3.js typically gives an Error message only, so no synthetic header or
  // Retry-After precision is claimed when it is unavailable to the caller.
  const web3Failure = classifyKeeperError(new Error("429 Too Many Requests"), undefined, clock.now());
  assert.equal(web3Failure.kind, "rate_limit");
  assert.equal(web3Failure.retryAfterMs, undefined);
  breaker.recordConfirmedSuccess();
  assert.deepEqual(breaker.snapshot(), { failures: 0, openUntilMs: 0 });

  const capped = new RpcCircuitBreaker(clock, 30_000, 5_000, 15 * 60_000);
  assert.equal(
    capped.recordFailure(new KeeperFailure("rate_limit", "rate limited", 24 * 60 * 60_000)),
    15 * 60_000,
    "a very large header is capped at the documented 15-minute probe interval",
  );
});

test("quota and transport failures are classified without retaining provider details", () => {
  assert.equal(classifyKeeperError(new Error("quota exhausted")).kind, "rate_limit");
  assert.equal(classifyKeeperError(new Error("socket ECONNRESET")).kind, "transport");
});

test("parent already aborted before confirmation linking aborts the child immediately", () => {
  const parent = new AbortController();
  parent.abort();
  const linked = linkedAbortController(parent.signal);
  assert.equal(linked.controller.signal.aborted, true);
  linked.dispose();
});

test("owned confirmation preserves direct and nested Custom 21 results from subscription and fallback", async () => {
  for (const [source, err] of [
    ["subscription", { Custom: 21 }],
    ["subscription", { InstructionError: [3, { Custom: 21 }] }],
    ["fallback", { Custom: 21 }],
    ["fallback", { InstructionError: [3, { Custom: 21 }] }],
  ] as const) {
    const scope = new RpcOperationSignalScope();
    const result = await confirmConnectionTransaction({
      clock: fakeClock(),
      connection: {
        getSignatureStatus: async () => source === "fallback"
          ? { context: { slot: 1 }, value: { err, confirmationStatus: "confirmed" } }
          : { context: { slot: 1 }, value: null },
        onSignature: (_signature, callback) => {
          if (source === "subscription") queueMicrotask(() => callback({ err }, { slot: 1 }));
          return 1;
        },
        removeSignatureListener: async () => undefined,
      },
      parentSignal: new AbortController().signal,
      runWithOperationSignal: (signal, work) => scope.run(signal, work),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
      timeoutMs: 8_000,
    });
    assert.equal(isCustomProgramError(confirmedTransactionError(result), 21), true);
    assert.equal(scope.currentSignal(), null);
  }
});

test("raw subscription setup InstructionError becomes crank.err and enters the Custom 21 self-heal branch", async () => {
  const rawTransactionError = { InstructionError: [2, { Custom: 21 }] };
  const result = await confirmConnectionTransaction({
    clock: fakeClock(),
    connection: {
      getSignatureStatus: async () => ({ context: { slot: 1 }, value: null }),
      onSignature: () => { throw rawTransactionError; },
      removeSignatureListener: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    runWithOperationSignal: async (_signal, work) => work(),
    strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
    timeoutMs: 8_000,
  });
  const crankErr = confirmedTransactionError(result);
  assert.deepEqual(crankErr, rawTransactionError);
  assert.equal(isCustomProgramError(crankErr, 21), true, "sendIxs passes the raw fallback error to self-heal detection");
});

test("only a validated raw Solana InstructionError is normalized", async () => {
  const untrusted = { InstructionError: ["two", { Custom: 21 }] };
  assert.equal(confirmationResultFromError(untrusted), null);
  await assert.rejects(
    confirmConnectionTransaction({
      clock: fakeClock(),
      connection: {
        getSignatureStatus: async () => ({ context: { slot: 1 }, value: null }),
        onSignature: () => { throw untrusted; },
        removeSignatureListener: async () => undefined,
      },
      parentSignal: new AbortController().signal,
      runWithOperationSignal: async (_signal, work) => work(),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
      timeoutMs: 8_000,
    }),
    (error: unknown) => error === untrusted,
  );
  assert.equal(confirmationResultFromError({ InstructionError: [0, { Custom: 21, Other: 1 }] }), null);
});

test("owned confirmation finalization aborts and settles all operation-lifetime fallback work", async () => {
  for (const err of [null, { InstructionError: [1, { Custom: 21 }] }]) {
    const scope = new RpcOperationSignalScope();
    let activeCalls = 0;
    const result = await confirmConnectionTransaction({
      clock: fakeClock(),
      connection: {
        getSignatureStatus: () => new Promise<unknown>((_resolve, reject) => {
          activeCalls += 1;
          const signal = scope.currentSignal();
          signal?.addEventListener("abort", () => {
            activeCalls -= 1;
            reject(signal.reason);
          }, { once: true });
        }),
        onSignature: (_signature, callback) => {
          queueMicrotask(() => callback({ err }, { slot: 1 }));
          return 1;
        },
        removeSignatureListener: async () => undefined,
      },
      parentSignal: new AbortController().signal,
      runWithOperationSignal: (signal, work) => scope.run(signal, work),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
      timeoutMs: 8_000,
    });
    assert.deepEqual(confirmedTransactionError(result), err);
    assert.equal(activeCalls, 0, "finally aborts success/chain-error background work");
    assert.equal(scope.currentSignal(), null);
  }
});

async function runRealConnectionFallbackRace(kind: "owner" | "independent-abort" | "transport") {
  const scope = new RpcOperationSignalScope();
  let activeFallbacks = 0;
  let unsubscribeCalls = 0;
  const ignoredUnsubscribeWarnings: string[] = [];
  let deliverSubscription!: (result: { err: unknown }, context: unknown) => void;
  const customFetch: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
    activeFallbacks += 1;
    const signal = init?.signal;
    signal?.addEventListener("abort", () => {
      activeFallbacks -= 1;
      if (kind === "owner") reject(signal.reason);
      else if (kind === "independent-abort") {
        reject(Object.assign(new Error("independent abort"), { name: "AbortError" }));
      } else {
        reject(new Error("connection reset https://provider.invalid/key"));
      }
    }, { once: true });
  });
  const connection = new Connection("http://127.0.0.1:8899", {
    commitment: "confirmed",
    fetch: customFetch,
    fetchMiddleware: (url, options, next) => next(url, {
      ...(options ?? {}),
      signal: scope.currentSignal() ?? options?.signal,
    }),
  }) as unknown as {
    getSignatureStatus: (signature: string) => Promise<unknown>;
    onSignature: (signature: string, callback: (result: { err: unknown }, context: unknown) => void, commitment: "confirmed") => number;
    removeSignatureListener: (id: number) => Promise<void>;
  };
  connection.removeSignatureListener = async () => {
    unsubscribeCalls += 1;
    if (unsubscribeCalls > 1) ignoredUnsubscribeWarnings.push("ignored unsubscribe");
  };
  connection.onSignature = (_signature, callback) => {
    deliverSubscription = (result, context) => {
      callback(result, context);
      // Mirrors web3.js 1.98.4's onSignature auto-removal after callback.
      void connection.removeSignatureListener(7);
    };
    return 7;
  };
  const reports: string[] = [];
  const unhandled: unknown[] = [];
  const uncaught: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  const onUncaught = (error: unknown) => { uncaught.push(error); };
  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtException", onUncaught);
  try {
    const confirmation = confirmConnectionTransaction({
      clock: fakeClock(),
      connection,
      parentSignal: new AbortController().signal,
      reportUnexpectedFallbackError: (message) => { reports.push(message); },
      runWithOperationSignal: (signal, work) => scope.run(signal, work),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
      timeoutMs: 8_000,
    });
    await flush();
    assert.equal(activeFallbacks, 1);
    deliverSubscription({ err: null }, { slot: 1 });
    assert.deepEqual(await confirmation, { context: { slot: 1 }, value: { err: null } });
    await flush();
    assert.equal(activeFallbacks, 0);
    assert.equal(unsubscribeCalls, 1);
    assert.deepEqual(ignoredUnsubscribeWarnings, []);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(uncaught, []);
    assert.equal(scope.currentSignal(), null);
    return reports;
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    process.removeListener("uncaughtException", onUncaught);
  }
}

test("real Connection custom-fetch fallback consumes only its exact owner abort and avoids double unsubscribe", async () => {
  assert.deepEqual(await runRealConnectionFallbackRace("owner"), []);
});

test("real Connection ignores abandoned fallback errors after a confirmed websocket outcome", async () => {
  // Once the websocket has authoritatively confirmed the transaction, the
  // owned abort settles the hard-bounded fallback first. A transport's later
  // rejection is consumed by the deadline helper and must not become either
  // an unhandled rejection or a false keeper warning.
  assert.deepEqual(await runRealConnectionFallbackRace("independent-abort"), []);
  assert.deepEqual(await runRealConnectionFallbackRace("transport"), []);
});

test("confirmation polling survives an early null and a missed websocket notification", async () => {
  const clock = fakeClock();
  const statuses = [
    { context: { slot: 1 }, value: null },
    { context: { slot: 2 }, value: { err: null, confirmationStatus: "processed" } },
    { context: { slot: 3 }, value: { err: null, confirmationStatus: "confirmed" } },
  ];
  let reads = 0;
  const confirmation = confirmConnectionTransaction({
    clock,
    connection: {
      getSignatureStatus: async () => statuses[Math.min(reads++, statuses.length - 1)],
      onSignature: () => 1,
      removeSignatureListener: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    pollIntervalMs: 400,
    runWithOperationSignal: async (_signal, work) => work(),
    strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 100 },
    timeoutMs: 8_000,
  });

  for (let poll = 0; poll < 2; poll += 1) {
    await flush();
    const sleep = clock.tasks.find((task) => !task.cancelled && task.delayMs === 400);
    assert.ok(sleep);
    sleep.cancelled = true;
    sleep.callback();
  }
  assert.deepEqual(await confirmation, { context: { slot: 3 }, value: { err: null } });
  assert.equal(reads, 3);
});

test("processed polling errors remain pending until confirmed commitment", async () => {
  const clock = fakeClock();
  const error = { InstructionError: [2, { Custom: 21 }] };
  const statuses = [
    { context: { slot: 2 }, value: { err: error, confirmationStatus: "processed" } },
    { context: { slot: 3 }, value: { err: error, confirmationStatus: "confirmed" } },
  ];
  let reads = 0;
  const confirmation = confirmConnectionTransaction({
    clock,
    connection: {
      getSignatureStatus: async () => statuses[Math.min(reads++, statuses.length - 1)],
      onSignature: () => 1,
      removeSignatureListener: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    pollIntervalMs: 400,
    runWithOperationSignal: async (_signal, work) => work(),
    strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 100 },
    timeoutMs: 8_000,
  });
  await flush();
  const sleep = clock.tasks.find((task) => !task.cancelled && task.delayMs === 400);
  assert.ok(sleep);
  sleep.cancelled = true;
  sleep.callback();
  assert.deepEqual(confirmedTransactionError(await confirmation), error);
  assert.equal(reads, 2);
});

test("expiry performs a final history lookup before declaring non-landing", async () => {
  const makeConnection = (historicalStatus: unknown) => ({
    getBlockHeight: async () => 101,
    getSignatureStatus: async () => ({ context: { slot: 10 }, value: null }),
    getSignatureStatuses: async () => ({ context: { slot: 11 }, value: [historicalStatus] }),
    onSignature: () => 1,
    removeSignatureListener: async () => undefined,
  });

  const late = await confirmConnectionTransaction({
    clock: fakeClock(),
    connection: makeConnection({ err: null, confirmationStatus: "confirmed" }),
    parentSignal: new AbortController().signal,
    runWithOperationSignal: async (_signal, work) => work(),
    strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 100 },
    timeoutMs: 8_000,
  });
  assert.deepEqual(late, { context: { slot: 11 }, value: { err: null } });

  await assert.rejects(
    confirmConnectionTransaction({
      clock: fakeClock(),
      connection: makeConnection(null),
      parentSignal: new AbortController().signal,
      runWithOperationSignal: async (_signal, work) => work(),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 100 },
      timeoutMs: 8_000,
    }),
    (error: unknown) => error instanceof KeeperFailure && error.kind === "expired",
  );
});

test("pending broadcast gate rebroadcasts identical bytes and blocks replacement signing", async () => {
  const gate = new PendingBroadcastGate<{ action: string }>();
  const pending = {
    context: { action: "oracle-push" },
    rawTransaction: Uint8Array.from([1, 2, 3]),
    strategy: { signature: "same-signature", blockhash: "blockhash", lastValidBlockHeight: 100 },
  };
  gate.record(pending);
  assert.throws(() => gate.record(pending), (error: unknown) => error instanceof KeeperFailure && error.kind === "pending");

  let rebroadcasts = 0;
  await assert.rejects(
    gate.reconcile({
      confirm: async () => { throw new KeeperFailure("pending", "not terminal"); },
      rebroadcast: async (raw) => {
        rebroadcasts += 1;
        assert.deepEqual([...raw], [1, 2, 3]);
        return "same-signature";
      },
    }),
    (error: unknown) => error instanceof KeeperFailure && error.kind === "pending",
  );
  assert.equal(gate.hasPending(), true);

  const resolved = await gate.reconcile({
    confirm: async () => ({ context: { slot: 12 }, value: { err: null } }),
    rebroadcast: async (raw) => {
      rebroadcasts += 1;
      assert.deepEqual([...raw], [1, 2, 3]);
      return "same-signature";
    },
  });
  assert.equal(rebroadcasts, 2);
  assert.equal(resolved?.context.action, "oracle-push");
  assert.equal(resolved?.strategy.signature, "same-signature");
  assert.equal(gate.hasPending(), false);

  gate.record(pending);
  await assert.rejects(
    gate.reconcile({ confirm: async () => { throw new KeeperFailure("expired", "history miss"); } }),
    (error: unknown) => error instanceof KeeperFailure && error.kind === "expired",
  );
  assert.equal(gate.hasPending(), false, "only proven expiry permits a replacement transaction");
});

test("pending broadcast gate fails closed when identical bytes produce a different signature", async () => {
  const gate = new PendingBroadcastGate<{ action: string }>();
  gate.record({
    context: { action: "lp-crank" },
    rawTransaction: Uint8Array.from([9]),
    strategy: { signature: "expected", blockhash: "blockhash", lastValidBlockHeight: 100 },
  });
  await assert.rejects(
    gate.reconcile({
      confirm: async () => ({ context: {}, value: { err: null } }),
      rebroadcast: async () => "different",
    }),
    (error: unknown) => error instanceof KeeperFailure && error.kind === "pending",
  );
  assert.equal(gate.hasPending(), true);
});

test("confirmation timeout and shutdown abort owned fallback work without orphaning a runner", async () => {
  const clock = fakeClock();
  const scope = new RpcOperationSignalScope();
  const runner = new SingleTickRunner(clock, 20_000);
  let unresolvedCalls = 0;
  const parent = new AbortController();
  const connection = {
    getSignatureStatus: () => new Promise<unknown>((_resolve, reject) => {
      unresolvedCalls += 1;
      const pollSignal = scope.currentSignal();
      const onAbort = () => {
        unresolvedCalls -= 1;
        reject(pollSignal?.reason);
      };
      pollSignal?.addEventListener("abort", onAbort, { once: true });
    }),
    onSignature: () => 1,
    removeSignatureListener: async () => undefined,
  };
  const first = runner.run(async (signal) => {
    await confirmConnectionTransaction({
      clock,
      connection,
      parentSignal: signal,
      runWithOperationSignal: (operationSignal, work) => scope.run(operationSignal, work),
      strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
      timeoutMs: 8_000,
    });
  });
  await flush();
  assert.equal(unresolvedCalls, 1);
  assert.equal(await runner.run(async () => undefined), false, "an active confirmation blocks a second tick");
  const confirmationTimeout = clock.tasks.find((task) => task.delayMs === 8_000);
  assert.ok(confirmationTimeout);
  confirmationTimeout.callback();
  await assert.rejects(first, (error: unknown) => error instanceof KeeperFailure && error.kind === "pending");
  assert.equal(unresolvedCalls, 0);
  assert.equal(scope.currentSignal(), null);
  assert.equal(runner.isActive(), false);

  const shutdownClock = fakeClock();
  const shutdownScope = new RpcOperationSignalScope();
  let shutdownCalls = 0;
  const shutdown = new AbortController();
  const pending = confirmConnectionTransaction({
    clock: shutdownClock,
    connection: {
      getSignatureStatus: () => new Promise<unknown>((_resolve, reject) => {
        shutdownCalls += 1;
        shutdownScope.currentSignal()?.addEventListener("abort", () => {
          shutdownCalls -= 1;
          reject(shutdownScope.currentSignal()?.reason);
        }, { once: true });
      }),
      onSignature: () => 1,
      removeSignatureListener: async () => undefined,
    },
    parentSignal: shutdown.signal,
    runWithOperationSignal: (operationSignal, work) => shutdownScope.run(operationSignal, work),
    strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 1 },
    timeoutMs: 8_000,
  });
  await flush();
  shutdown.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof KeeperFailure && error.kind === "cancelled");
  assert.equal(shutdownCalls, 0);
  assert.equal(shutdownScope.currentSignal(), null);
});

test("confirmation returns when a status RPC ignores cancellation", async () => {
  const clock = fakeClock();
  const scope = new RpcOperationSignalScope();
  const confirmation = confirmConnectionTransaction({
    clock,
    connection: {
      getSignatureStatus: () => new Promise<unknown>(() => {}),
      onSignature: () => 1,
      removeSignatureListener: async () => undefined,
    },
    parentSignal: new AbortController().signal,
    rpcReadTimeoutMs: 4_000,
    runWithOperationSignal: (signal, work) => scope.run(signal, work),
    strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 100 },
    timeoutMs: 8_000,
  });
  await flush();
  const readDeadline = clock.tasks.find((task) => task.delayMs === 4_000);
  assert.ok(readDeadline);
  readDeadline.callback();
  await assert.rejects(
    confirmation,
    (error: unknown) => error instanceof KeeperFailure && error.kind === "timeout",
  );
  assert.equal(scope.currentSignal(), null);
});

test("confirmation does not hang when websocket cleanup ignores cancellation", async () => {
  const clock = fakeClock();
  const scope = new RpcOperationSignalScope();
  const confirmation = confirmConnectionTransaction({
    clock,
    connection: {
      getSignatureStatus: async () => ({
        context: { slot: 1 },
        value: { err: null, confirmationStatus: "confirmed" },
      }),
      onSignature: () => 1,
      removeSignatureListener: () => new Promise<void>(() => {}),
    },
    parentSignal: new AbortController().signal,
    runWithOperationSignal: (signal, work) => scope.run(signal, work),
    strategy: { signature: "sig", blockhash: "blockhash", lastValidBlockHeight: 100 },
    timeoutMs: 8_000,
  });
  await flush();
  const cleanupDeadline = clock.tasks.find((task) => task.delayMs === 1_000);
  assert.ok(cleanupDeadline);
  cleanupDeadline.callback();
  assert.deepEqual(await confirmation, { context: { slot: 1 }, value: { err: null } });
  assert.equal(scope.currentSignal(), null);
});

test("deadline cancellation keeps the active tick serialized until its work settles", async () => {
  const clock = fakeClock();
  const runner = new SingleTickRunner(clock, 20_000);
  let calls = 0;
  const first = runner.run(async (signal) => {
    calls += 1;
    await abortableSleep(10_000, signal, clock);
  });
  await flush();
  assert.equal(runner.isActive(), true);
  assert.equal(await runner.run(async () => { calls += 1; }), false);
  assert.equal(calls, 1);
  const deadline = clock.tasks.find((task) => task.delayMs === 20_000);
  assert.ok(deadline);
  deadline.callback();
  await assert.rejects(first, (error: unknown) => error instanceof KeeperFailure && error.kind === "cancelled");
  assert.equal(runner.isActive(), false);
});

test("hard deadline returns even when abandoned read work ignores cancellation", async () => {
  const clock = fakeClock();
  const observed: { operationSignal: AbortSignal | null } = { operationSignal: null };
  let lateResolve!: (value: string) => void;
  const result = runHardDeadlineOperation({
    clock,
    parentSignal: new AbortController().signal,
    timeoutMs: 5_000,
    work: (signal) => {
      observed.operationSignal = signal;
      return new Promise<string>((resolve) => { lateResolve = resolve; });
    },
  });
  await flush();
  assert.equal(observed.operationSignal?.aborted, false);
  const deadline = clock.tasks.find((task) => task.delayMs === 5_000);
  assert.ok(deadline);
  deadline.callback();
  await assert.rejects(
    result,
    (error: unknown) => error instanceof KeeperFailure && error.kind === "timeout",
  );
  assert.equal(observed.operationSignal?.aborted, true);
  lateResolve("late read result");
  await flush();
});

test("hard deadline rejects immediately on parent cancellation without starting work", async () => {
  const parent = new AbortController();
  parent.abort();
  let started = false;
  await assert.rejects(
    runHardDeadlineOperation({
      clock: fakeClock(),
      parentSignal: parent.signal,
      timeoutMs: 5_000,
      work: async () => {
        started = true;
        return "unexpected";
      },
    }),
    (error: unknown) => error instanceof KeeperFailure && error.kind === "cancelled",
  );
  assert.equal(started, false);
});

test("SingleTickRunner reports a permanently hung deadline without releasing serialization", async () => {
  const clock = fakeClock();
  let deadlineReports = 0;
  const runner = new SingleTickRunner(clock, 20_000, () => { deadlineReports += 1; });
  void runner.run(async () => new Promise<void>(() => {}));
  await flush();
  const deadline = clock.tasks.find((task) => task.delayMs === 20_000);
  assert.ok(deadline);
  deadline.callback();
  assert.equal(deadlineReports, 1);
  assert.equal(runner.isActive(), true);
  assert.equal(await runner.run(async () => undefined), false);
});

test("Hermes deadline spans headers, body parsing, and validation for timeout and parent abort", async () => {
  const timeoutClock = fakeClock();
  let activeBodies = 0;
  const timedOut = runDeadlineBoundOperation({
    clock: timeoutClock,
    parentSignal: new AbortController().signal,
    timeoutMs: 5_000,
    work: async (signal) => {
      // Headers have resolved, but the body is still waiting for the same signal.
      const response = { json: () => new Promise<unknown>((_resolve, reject) => {
        activeBodies += 1;
        signal.addEventListener("abort", () => {
          activeBodies -= 1;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }) };
      const data = await response.json();
      return requireConfiguredHermesFeeds(["sol"], (data as Array<{ id: string }>));
    },
  });
  await flush();
  assert.equal(activeBodies, 1);
  const bodyDeadline = timeoutClock.tasks.find((task) => task.delayMs === 5_000);
  assert.ok(bodyDeadline);
  bodyDeadline.callback();
  await assert.rejects(timedOut, (error: unknown) => error instanceof KeeperFailure && error.kind === "timeout");
  assert.equal(activeBodies, 0);

  const parent = new AbortController();
  const validation = { signal: null as AbortSignal | null };
  const cancelled = runDeadlineBoundOperation({
    clock: fakeClock(),
    parentSignal: parent.signal,
    timeoutMs: 5_000,
    work: async (signal) => {
      validation.signal = signal;
      await new Promise<void>((_resolve, reject) => signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      ));
      return requireConfiguredHermesFeeds(["sol"], [{ id: "sol" }]);
    },
  });
  await flush();
  assert.equal(validation.signal?.aborted, false, "the link remains active after headers until body/validation complete");
  parent.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof KeeperFailure && error.kind === "cancelled");
  assert.equal(validation.signal?.aborted, true);

  const completed = { signal: null as AbortSignal | null };
  const feeds = await runDeadlineBoundOperation({
    clock: fakeClock(),
    parentSignal: new AbortController().signal,
    timeoutMs: 5_000,
    work: async (signal) => {
      completed.signal = signal;
      const response = { json: async () => [{ id: "sol" }] };
      const data = await response.json();
      assert.equal(signal.aborted, false, "feed validation runs before final operation cleanup");
      return requireConfiguredHermesFeeds(["sol"], data);
    },
  });
  assert.equal(feeds.size, 1);
  assert.equal(completed.signal?.aborted, true, "success cleanup aborts any remaining body work");
});

test("5s cadence / 20s budget model includes wall-slot accrual and partial deadline continuation", () => {
  const model = modelCatchupCadence({
    cadenceMs: 5_000,
    tickBudgetMs: 20_000,
    pushConfirmationMs: 1_000,
    lpConfirmationMs: 1_000,
    healConfirmationMs: 3_000,
    catchupTransactionsPerTick: 4,
    cranksPerTransaction: 9,
    slotsPerCrank: 20,
    initialLagSlots: 4_000,
    simulationMs: 74_000,
    slotDurationMs: 400,
  });
  assert.equal(model.completedTicks, 5);
  assert.equal(model.completedHealTransactions, 20);
  assert.equal(model.finalLagSlots, 585, "wall time adds 185 slots while 5 × 4 × 9 × ~20 slots catch up");
  assert.equal(model.maxConcurrentTicks, 1);
  assert.equal(model.orphanedConfirmations, 0);
  assert.equal(model.skippedCadenceCallbacks, 10);
  const partial = modelCatchupCadence({
    cadenceMs: 5_000,
    tickBudgetMs: 20_000,
    pushConfirmationMs: 1_000,
    lpConfirmationMs: 1_000,
    healConfirmationMs: 5_000,
    catchupTransactionsPerTick: 4,
    cranksPerTransaction: 9,
    slotsPerCrank: 20,
    initialLagSlots: 4_000,
    simulationMs: 60_000,
    slotDurationMs: 400,
  });
  assert.equal(partial.completedTicks, 3);
  assert.equal(partial.completedHealTransactions, 9, "three confirmations land before each partial deadline");
  assert.equal(partial.partialDeadlineCancellations, 3);
  assert.ok(partial.finalLagSlots < 4_000, "next ticks continue bounded catch-up after deadline cancellation");
  assert.equal(partial.maxConcurrentTicks, 1);
  assert.equal(partial.orphanedConfirmations, 0);
});

test("self-heal obeys its one-transaction liveness budget and yields to the next price tick", async () => {
  const controller = new AbortController();
  const calls: number[] = [];
  const completed = await runBoundedSelfHeal({
    batchesPerTick: 1,
    cranksPerBatch: 9,
    signal: controller.signal,
    runBatch: async (cranks) => {
      calls.push(cranks);
      return true;
    },
  });
  assert.equal(completed, 1);
  assert.deepEqual(calls, [9]);
});

test("self-heal stops immediately after a bounded batch yields", async () => {
  const calls: number[] = [];
  const completed = await runBoundedSelfHeal({
    batchesPerTick: 4,
    cranksPerBatch: 9,
    signal: new AbortController().signal,
    runBatch: async (cranks) => {
      calls.push(cranks);
      return false;
    },
  });
  assert.equal(completed, 0);
  assert.deepEqual(calls, [9]);
});

test("SingleTickRunner marks active before synchronous re-entrant work", async () => {
  const runner = new SingleTickRunner(fakeClock(), 20_000);
  let nestedStarted: boolean | undefined;
  assert.equal(await runner.run(async () => {
    nestedStarted = await runner.run(async () => undefined);
  }), true);
  assert.equal(nestedStarted, false);
});

test("partial Hermes data fails the whole configured feed set", () => {
  assert.throws(
    () => requireConfiguredHermesFeeds(["sol", "btc"], [{ id: "sol" }]),
    (error: unknown) => error instanceof KeeperFailure && error.kind === "transport",
  );
  assert.equal(requireConfiguredHermesFeeds(["sol", "btc"], [{ id: "sol" }, { id: "btc" }]).size, 2);
});

test("one denied Hermes feed is quarantined without blocking healthy feeds", async () => {
  const clock = fakeClock(1_000);
  const quarantine = new HermesFeedEntitlementQuarantine(clock.now, 100, 400);
  const feeds = [
    { feedId: "sol", index: 0 },
    { feedId: "btc", index: 1 },
    { feedId: "zec", index: 3 },
  ];
  const calls: string[][] = [];
  const first = await fetchAvailableHermesFeeds({
    feeds,
    quarantine,
    fetchBatch: async (requested) => {
      calls.push(requested.map((feed) => feed.feedId));
      if (requested.some((feed) => feed.feedId === "zec")) return { kind: "denied" as const };
      return { kind: "ok" as const, items: requested.map((feed) => ({ id: feed.feedId })) };
    },
  });
  assert.deepEqual(calls, [["sol", "btc", "zec"], ["sol"], ["btc"], ["zec"]]);
  assert.deepEqual([...first.feeds.keys()], ["sol", "btc"]);
  assert.deepEqual(first.unavailableIndexes, [3]);

  calls.length = 0;
  const second = await fetchAvailableHermesFeeds({
    feeds,
    quarantine,
    fetchBatch: async (requested) => {
      calls.push(requested.map((feed) => feed.feedId));
      return { kind: "ok" as const, items: requested.map((feed) => ({ id: feed.feedId })) };
    },
  });
  assert.deepEqual(calls, [["sol", "btc"]]);
  assert.deepEqual([...second.feeds.keys()], ["sol", "btc"]);
  assert.deepEqual(second.unavailableIndexes, [3]);

  clock.advance(100);
  const restored = await fetchAvailableHermesFeeds({
    feeds,
    quarantine,
    fetchBatch: async (requested) => ({
      kind: "ok" as const,
      items: requested.map((feed) => ({ id: feed.feedId })),
    }),
  });
  assert.deepEqual([...restored.feeds.keys()], ["sol", "btc", "zec"]);
  assert.deepEqual(restored.unavailableIndexes, []);
});

test("an all-feed entitlement denial opens the provider circuit", async () => {
  const feeds = [{ feedId: "sol", index: 0 }, { feedId: "zec", index: 3 }];
  await assert.rejects(
    fetchAvailableHermesFeeds({
      feeds,
      quarantine: new HermesFeedEntitlementQuarantine(() => 1_000),
      fetchBatch: async () => ({ kind: "denied" as const }),
    }),
    (error: unknown) => error instanceof KeeperFailure && error.kind === "provider_denied",
  );
  const clock = fakeClock(1_000, 0);
  const breaker = new RpcCircuitBreaker(clock, 30_000, 5_000, 15 * 60_000);
  assert.equal(breaker.recordFailure(new KeeperFailure("provider_denied", "Pyth access rejected")), 30_000);
  assert.deepEqual(breaker.snapshot(), { failures: 1, openUntilMs: 31_000 });
});

function usableBufferData(): { data: Uint8Array; market: Uint8Array; portfolio: Uint8Array } {
  const data = new Uint8Array(9411);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 0x5045_5243_5631_3600n, true);
  view.setUint16(8, 16, true);
  view.setUint8(10, 2);
  const market = new Uint8Array(32).fill(1);
  const portfolio = new Uint8Array(32).fill(2);
  data.set(market, 16);
  data.set(portfolio, 48);
  return { data, market, portfolio };
}

test("crank-buffer create rejection re-reads and accepts only a verified legless buffer", async () => {
  const usable = usableBufferData();
  assert.equal(isUsableLeglessCrankBuffer({
    data: usable.data,
    expectedLength: 9411,
    expectedMarket: usable.market,
    expectedPortfolio: usable.portfolio,
    programOwnerMatches: true,
  }), true);
  let reads = 0;
  await ensureUsableCrankBuffer({
    read: async () => (++reads === 1 ? null : usable.data),
    isUsable: (account) => account === usable.data,
    create: async () => { throw new KeeperFailure("onchain", "rejected"); },
  });
  assert.equal(reads, 2, "a rejected create is never treated as ready without a validating re-read");
  await assert.rejects(
    ensureUsableCrankBuffer({
      read: async () => null,
      isUsable: () => false,
      create: async () => { throw new KeeperFailure("onchain", "rejected"); },
    }),
    (error: unknown) => error instanceof KeeperFailure && error.kind === "onchain",
  );
});

test("market-scoped crank buffer ignores a legacy old-market buffer and selects an unused live candidate", async () => {
  const authority = new PublicKey(new Uint8Array(32).fill(9));
  const program = new PublicKey(new Uint8Array(32).fill(8));
  const oldMarket = new Uint8Array(32).fill(1);
  const liveMarket = new Uint8Array(32).fill(2);
  const legacy = await PublicKey.createWithSeed(authority, "ninja-crank-buffer", program);
  const liveSeed = crankBufferSeedForMarket(liveMarket);
  const liveCandidate = await PublicKey.createWithSeed(authority, liveSeed, program);
  const oldBuffer = usableBufferData();
  oldBuffer.data.set(oldMarket, 16);
  oldBuffer.data.set(legacy.toBytes(), 48);
  const accounts = new Map<string, Uint8Array>([[legacy.toBase58(), oldBuffer.data]]);

  assert.notEqual(liveSeed, "ninja-crank-buffer");
  assert.notEqual(liveSeed, crankBufferSeedForMarket(oldMarket));
  assert.notEqual(liveCandidate.toBase58(), legacy.toBase58());
  assert.equal(isUsableLeglessCrankBuffer({
    data: oldBuffer.data,
    expectedLength: 9411,
    expectedMarket: liveMarket,
    expectedPortfolio: liveCandidate.toBytes(),
    programOwnerMatches: true,
  }), false, "the old-market account can never validate for the live candidate");
  assert.equal(accounts.has(liveCandidate.toBase58()), false, "the live-market candidate starts unused");

  const liveBuffer = usableBufferData();
  liveBuffer.data.set(liveMarket, 16);
  liveBuffer.data.set(liveCandidate.toBytes(), 48);
  await ensureUsableCrankBuffer({
    read: async () => accounts.get(liveCandidate.toBase58()) ?? null,
    isUsable: (account) => account !== null && isUsableLeglessCrankBuffer({
      data: account,
      expectedLength: 9411,
      expectedMarket: liveMarket,
      expectedPortfolio: liveCandidate.toBytes(),
      programOwnerMatches: true,
    }),
    create: async () => { accounts.set(liveCandidate.toBase58(), liveBuffer.data); },
  });
  assert.equal(accounts.get(legacy.toBase58()), oldBuffer.data, "legacy buffer is never repurposed");
  assert.equal(accounts.get(liveCandidate.toBase58()), liveBuffer.data, "only the live candidate is selected");
});

test("existing valid live-market crank buffer remains usable without creation", async () => {
  const liveMarket = new Uint8Array(32).fill(4);
  const livePortfolio = new Uint8Array(32).fill(5);
  const existing = usableBufferData();
  existing.data.set(liveMarket, 16);
  existing.data.set(livePortfolio, 48);
  let creates = 0;
  await ensureUsableCrankBuffer({
    read: async () => existing.data,
    isUsable: (account) => account !== null && isUsableLeglessCrankBuffer({
      data: account,
      expectedLength: 9411,
      expectedMarket: liveMarket,
      expectedPortfolio: livePortfolio,
      programOwnerMatches: true,
    }),
    create: async () => { creates += 1; },
  });
  assert.equal(creates, 0);
});

test("hosted keeper configuration fails closed without explicit RPC and signer", () => {
  assert.throws(() => requireKeeperConfiguration({}), /explicit RPC_URL/);
  assert.throws(() => requireKeeperConfiguration({ RPC_URL: "configured" }), /explicit KEEPER_SECRET_KEY/);
  assert.deepEqual(
    requireKeeperConfiguration({ RPC_URL: "configured", KEEPER_SECRET_KEY: "configured" }),
    { rpcUrl: "configured", encodedSecretKey: "configured" },
  );
});

test("keeper secret decode failures have a fixed message and do not echo input", () => {
  for (const malformed of ["[1]", "[not-json]", "not-base64-or-json", "[256, 0]"]) {
    assert.throws(
      () => parseKeeperSecretKey(malformed),
      (error: unknown) => error instanceof KeeperFailure
        && error.message === "invalid KEEPER_SECRET_KEY"
        && !error.message.includes(malformed),
    );
  }
  assert.equal(parseKeeperSecretKey(JSON.stringify(Array(64).fill(0))).length, 64);
});

test("terminal shutdown clears intervals and exits only after active work drains", async () => {
  const handles: Array<{ callback: () => void; cleared: boolean }> = [];
  const scheduler: IntervalScheduler = {
    setInterval(callback) {
      const handle = { callback, cleared: false };
      handles.push(handle);
      return handle as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(handle) { (handle as unknown as { cleared: boolean }).cleared = true; },
  };
  const exits: number[] = [];
  const lifecycle = new KeeperLifecycle(scheduler, (code) => exits.push(code));
  let ticks = 0;
  lifecycle.every(() => { ticks += 1; }, 5000);
  handles[0].callback();
  assert.equal(ticks, 1);
  const gate = deferred<void>();
  const terminating = lifecycle.terminate(async () => { await gate.promise; });
  assert.equal(handles[0].cleared, true);
  handles[0].callback();
  assert.equal(ticks, 1, "terminal wrapper cannot revive recurring work");
  assert.deepEqual(exits, []);
  gate.resolve();
  await terminating;
  assert.deepEqual(exits, [0]);
});

test("terminal restart preserves its nonzero exit code when cancellation makes drain reject", async () => {
  const scheduler: IntervalScheduler = {
    setInterval: (() => ({}) as ReturnType<typeof setInterval>),
    clearInterval: () => {},
  };
  const exits: number[] = [];
  const reports: unknown[] = [];
  const lifecycle = new KeeperLifecycle(
    scheduler,
    (code) => exits.push(code),
    (error) => reports.push(error),
  );

  const failure = new Error('operation cancelled during shutdown');
  await lifecycle.terminate(async () => { throw failure; }, 1);

  assert.deepEqual(exits, [1]);
  assert.deepEqual(reports, [failure]);
});

test("forced watchdog exit remains live while a drain is stuck", () => {
  const clock = fakeClock();
  const exits: number[] = [];
  const cancel = scheduleForcedExit({ clock, delayMs: 10_000, code: 1, exit: (code) => exits.push(code) });
  assert.equal(clock.tasks.length, 1);
  clock.tasks[0].callback();
  assert.deepEqual(exits, [1]);
  cancel();
  assert.equal(clock.tasks[0].cancelled, true);
});

test("confirmation success, on-chain error, timeout, and cancellation remain distinct", () => {
  assert.equal(confirmedTransactionError({ value: { err: null } }), null);
  assert.deepEqual(confirmedTransactionError({ value: { err: { Custom: 21 } } }), { Custom: 21 });
  assert.throws(() => confirmedTransactionError(null), (error: unknown) => error instanceof KeeperFailure && error.kind === "timeout");
  assert.throws(() => confirmedTransactionError({ value: {} }), (error: unknown) => error instanceof KeeperFailure && error.kind === "timeout");
  const controller = new AbortController();
  controller.abort();
  assert.equal(classifyKeeperError(new Error("aborted"), controller.signal).kind, "cancelled");
});

test("watchdog never advances on timeout or cancellation, only confirmed pushes", () => {
  const watchdog = new PushWatchdog(1_000);
  watchdog.recordConfirmedPush(2_000, false);
  assert.equal(watchdog.lastSuccessMs(), null);
  assert.equal(watchdog.shouldRestart(151_001, 150_000), true);
  watchdog.recordConfirmedPush(160_000, true);
  assert.equal(watchdog.lastSuccessMs(), 160_000);
  assert.equal(watchdog.shouldRestart(300_000, 150_000), false);
});

test("v16 loss-stale parser accepts only the exact on-chain boolean encoding", () => {
  const data = new Uint8Array(V16_LOSS_STALE_ACTIVE_OFFSET + 1);
  assert.equal(readV16LossStaleActive(data), false);
  data[V16_LOSS_STALE_ACTIVE_OFFSET] = 1;
  assert.equal(readV16LossStaleActive(data), true);
  data[V16_LOSS_STALE_ACTIVE_OFFSET] = 2;
  assert.throws(() => readV16LossStaleActive(data), /loss-stale flag/);
  assert.throws(
    () => readV16LossStaleActive(new Uint8Array(V16_LOSS_STALE_ACTIVE_OFFSET)),
    /status layout/,
  );
});

const V16_TEST_MAGIC = 0x5045_5243_5631_3600n;
const V16_TEST_GROUP_OFFSET = 16 + 448;
const V16_TEST_GROUP_HEADER_LEN = 726;
const V16_TEST_MARKET_MIN_LEN = V16_TEST_GROUP_OFFSET + V16_TEST_GROUP_HEADER_LEN;
const V16_TEST_ASSET_SLOT_LEN = 1797;
const V16_TEST_ENGINE_ASSET_OFFSET = 512;

function recoveryMarketFixture(input: {
  currentSlot?: bigint;
  lifecycles?: number[];
  lossStale?: boolean;
  market?: Uint8Array;
  slotLast?: bigint[];
} = {}): { data: Buffer; market: Uint8Array } {
  const currentSlot = input.currentSlot ?? 200_000n;
  const lifecycles = input.lifecycles ?? [2, 2, 2, 2];
  const market = input.market ?? Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const slotLast = input.slotLast ?? lifecycles.map(() => currentSlot);
  assert.equal(slotLast.length, lifecycles.length);
  const data = Buffer.alloc(V16_TEST_MARKET_MIN_LEN + lifecycles.length * V16_TEST_ASSET_SLOT_LEN);
  data.writeBigUInt64LE(V16_TEST_MAGIC, 0);
  data.writeUInt16LE(16, 8);
  data.writeUInt8(1, 10);
  Buffer.from(market).copy(data, V16_TEST_GROUP_OFFSET);
  data.writeUInt32LE(lifecycles.length, V16_TEST_GROUP_OFFSET + 281);
  data.writeBigUInt64LE(currentSlot, V16_TEST_GROUP_OFFSET + 581);
  data.writeUInt8(input.lossStale ? 1 : 0, V16_TEST_GROUP_OFFSET + 591);
  for (let asset = 0; asset < lifecycles.length; asset += 1) {
    const engineAssetOffset = V16_TEST_MARKET_MIN_LEN
      + asset * V16_TEST_ASSET_SLOT_LEN
      + V16_TEST_ENGINE_ASSET_OFFSET;
    data.writeUInt8(lifecycles[asset], engineAssetOffset + 16);
    data.writeBigUInt64LE(slotLast[asset], engineAssetOffset + 41);
  }
  return { data, market };
}

test("v16 recovery remains active after loss-stale clears until active asset clocks are bounded", () => {
  const currentSlot = 200_000n;
  const { data, market } = recoveryMarketFixture({
    currentSlot,
    slotLast: [currentSlot, currentSlot - 301n, currentSlot - 300n, currentSlot - 127_880n],
  });
  assert.deepEqual(readV16RecoveryStatus(data, market, 300n), {
    laggingAssetIndexes: [1, 3],
    lossStaleActive: false,
    marketCurrentSlot: currentSlot,
    maxActiveAssetClockLag: 127_880n,
    needsCatchUp: true,
  });
});

test("recovery writes ignore lag belonging only to an unavailable Coming Soon asset", () => {
  const status = {
    laggingAssetIndexes: [3],
    lossStaleActive: false,
    marketCurrentSlot: 200_000n,
    maxActiveAssetClockLag: 10_000n,
    needsCatchUp: true,
  };
  assert.equal(availableRecoveryNeedsCatchUp(status, [0, 1, 2]), false);
  assert.equal(availableRecoveryNeedsCatchUp({ ...status, laggingAssetIndexes: [1, 3] }, [0, 1, 2]), true);
  assert.equal(availableRecoveryNeedsCatchUp({ ...status, laggingAssetIndexes: [], lossStaleActive: true }, [0, 1, 2]), true);
  assert.equal(availableRecoveryNeedsCatchUp({ ...status, lossStaleActive: true }, [0, 1, 2]), false);
});

test("v16 recovery stops only when both the loss-stale lock and active clock lag are bounded", () => {
  const currentSlot = 200_000n;
  const locked = recoveryMarketFixture({ currentSlot, lossStale: true });
  assert.equal(readV16RecoveryStatus(locked.data, locked.market, 300n).needsCatchUp, true);

  const healthy = recoveryMarketFixture({
    currentSlot,
    slotLast: [currentSlot, currentSlot - 299n, currentSlot - 300n, currentSlot],
  });
  assert.deepEqual(readV16RecoveryStatus(healthy.data, healthy.market, 300n), {
    laggingAssetIndexes: [],
    lossStaleActive: false,
    marketCurrentSlot: currentSlot,
    maxActiveAssetClockLag: 300n,
    needsCatchUp: false,
  });
});

test("healthy recovery status still permits the next bounded probe", () => {
  const nextCheck = 31_000;
  assert.equal(marketRecoveryStatusProbeDue(nextCheck - 1, nextCheck), false);
  assert.equal(marketRecoveryStatusProbeDue(nextCheck, nextCheck), true);
  assert.equal(marketRecoveryStatusProbeDue(nextCheck + 1, nextCheck), true);
  assert.throws(() => marketRecoveryStatusProbeDue(Number.NaN, nextCheck), /finite and non-negative/);
  assert.throws(() => marketRecoveryStatusProbeDue(nextCheck, -1), /finite and non-negative/);
});

test("v16 recovery ignores configured/retired slots but includes drain-only assets", () => {
  const currentSlot = 200_000n;
  const { data, market } = recoveryMarketFixture({
    currentSlot,
    lifecycles: [0, 1, 4, 3],
    slotLast: [0n, 0n, 0n, currentSlot - 301n],
  });
  const status = readV16RecoveryStatus(data, market, 300n);
  assert.deepEqual(status.laggingAssetIndexes, [3]);
  assert.equal(status.maxActiveAssetClockLag, 301n);
  assert.equal(status.needsCatchUp, true);
});

test("v16 recovery ignores Recovery clocks without hiding Active or DrainOnly debt", () => {
  const currentSlot = 200_000n;
  const { data, market } = recoveryMarketFixture({
    currentSlot,
    lifecycles: [2, 3, 5, 5],
    slotLast: [currentSlot - 301n, currentSlot - 450n, 0n, currentSlot + 1n],
  });
  assert.deepEqual(readV16RecoveryStatus(data, market, 300n), {
    laggingAssetIndexes: [0, 1],
    lossStaleActive: false,
    marketCurrentSlot: currentSlot,
    maxActiveAssetClockLag: 450n,
    needsCatchUp: true,
  });
});

test("v16 recovery parsing fails closed on identity, layout, lifecycle, clock, and config errors", () => {
  const fixture = recoveryMarketFixture();
  assert.throws(
    () => readV16RecoveryStatus(fixture.data, new Uint8Array(32), 300n),
    /identity does not match/,
  );
  assert.throws(
    () => readV16RecoveryStatus(fixture.data.subarray(0, -1), fixture.market, 300n),
    /asset-slot capacity/,
  );

  const wrongKind = Buffer.from(fixture.data);
  wrongKind.writeUInt8(2, 10);
  assert.throws(() => readV16RecoveryStatus(wrongKind, fixture.market, 300n), /v16 market kind/);

  const invalidBool = Buffer.from(fixture.data);
  invalidBool.writeUInt8(2, V16_TEST_GROUP_OFFSET + 591);
  assert.throws(() => readV16RecoveryStatus(invalidBool, fixture.market, 300n), /loss-stale flag/);

  const invalidLifecycle = Buffer.from(fixture.data);
  invalidLifecycle.writeUInt8(6, V16_TEST_MARKET_MIN_LEN + V16_TEST_ENGINE_ASSET_OFFSET + 16);
  assert.throws(() => readV16RecoveryStatus(invalidLifecycle, fixture.market, 300n), /lifecycle/);

  const futureClock = Buffer.from(fixture.data);
  futureClock.writeBigUInt64LE(200_001n, V16_TEST_MARKET_MIN_LEN + V16_TEST_ENGINE_ASSET_OFFSET + 41);
  assert.throws(() => readV16RecoveryStatus(futureClock, fixture.market, 300n), /exceeds the market clock/);
  assert.throws(() => readV16RecoveryStatus(fixture.data, fixture.market, -1n), /cannot be negative/);
});

test("keeper recovery clock-lag configuration defaults to the auditor bound and rejects ambiguity", () => {
  assert.equal(parseRecoveryClockLagSlots(undefined), 300n);
  assert.equal(parseRecoveryClockLagSlots(" 450 "), 450n);
  assert.throws(() => parseRecoveryClockLagSlots("-1"), /non-negative integer/);
  assert.throws(() => parseRecoveryClockLagSlots("1.5"), /non-negative integer/);
});

test("sanitizers redact HTTP/WSS URLs, authorization/api-key forms, and unhandled rejections", () => {
  const raw = "wss://provider.example/socket?token=private Authorization: Bearer private bearer private x-api-key: private {\"apiKey\":\"private\"}";
  const safe = safeErrorMessage(raw);
  assert.equal(safe.includes("provider.example"), false);
  assert.equal(safe.includes("private"), false);
  assert.equal(formatUnhandledRejection(new Error(raw)).includes("private"), false);
});
