import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function keeperSource(): string {
  return readFileSync(new URL("./oracle-keeper-v16.ts", import.meta.url), "utf8");
}

test("production wiring performs maintenance after push and before LP without legacy cached heal", () => {
  const source = keeperSource();
  const tick = source.slice(source.indexOf("async function tickInner"), source.indexOf("async function tick()"));
  assert.ok(tick.indexOf("const push = await pushAssetsWithIsolation") < tick.indexOf("const crank = await maintainBeforeLp"));
  assert.match(tick, /runBatch: plan => maintainClocks\(plan, signal\)/);
  assert.doesNotMatch(tick, /sendIxs\(\[ixCrank\(LP_PORTFOLIO/);
  assert.doesNotMatch(tick, /knownMarketNeedsCatchUp|nextMarketStatusCheckMs|await selfHeal/);
  assert.ok(tick.indexOf("const crank = await maintainBeforeLp") < tick.indexOf("if (shouldResetRpcCircuitAfterPush"));
});

test("runtime couples LP and maintenance, retains capped continuation, and covers all configured live assets", () => {
  const source = keeperSource();
  const batch = source.slice(source.indexOf("async function maintainClocks"), source.indexOf("async function readLpHealth"));
  assert.match(batch, /length: layout.leglessCranks/);
  assert.match(batch, /if \(layout.settlesLp\) ixs.push\(ixCrank\(LP_PORTFOLIO/);
  assert.match(batch, /sendIxs\(ixs, 1_400_000/);
  assert.match(batch, /action: layout.settlesLp \? "lp-crank" : "loss-stale-heal"/);
  assert.equal((batch.match(/sendIxs\(/g) ?? []).length, 1);
  const entry = source.slice(source.indexOf("async function resumeMaintenance"), source.indexOf("async function tick()"));
  assert.equal((entry.match(/if \(!crank.settlesLp\)/g) ?? []).length, 2);
  assert.doesNotMatch(entry, /fetchMaintenancePlan\(readSignal, (pushed|work.assetIndexes)/);
});

test("entry point reconciliation precedes plan construction; send path never hides a reconcile", () => {
  const source = keeperSource();
  const tick = source.slice(source.indexOf("async function tickInner"), source.indexOf("async function tick()"));
  assert.ok(tick.indexOf("resumeBeforeFreshPush") < tick.indexOf("readOraclePrices(signal)"));
  const send = source.slice(source.indexOf("async function sendIxs"), source.indexOf("async function simulateIxs"));
  assert.doesNotMatch(send, /await reconcilePendingBroadcast/);
  assert.match(send, /pendingBroadcasts.hasPending\(\)/);
  assert.match(send, /assetIndexes: \[\.\.\.\(intent\?\.assetIndexes/);
  assert.match(send, /maintenanceContinuation.recordConfirmed\(resolved.context, err\)/);
});

test("runtime admission follows feed latency and precedes push; deferred tick has no second batch", () => {
  const source = keeperSource();
  const tick = source.slice(source.indexOf("async function tickInner"), source.indexOf("async function tick()"));
  assert.ok(tick.indexOf("readOraclePrices(signal)") < tick.indexOf("await admitFreshPush"));
  assert.ok(tick.indexOf("await admitFreshPush") < tick.indexOf("const push = await pushAssetsWithIsolation"));
  assert.match(tick, /if \(!admission.admitted\) \{[\s\S]*?return;\s*\}/);
  assert.match(tick, /const nowSlot = admission.observedSlot/);
  assert.doesNotMatch(tick, /conn.getSlot/);
  assert.match(tick, /if \(admission.maintenanceUsed\) \{[\s\S]*?return;\s*\}/);
});

test("keeper reports startup, periodic, and rejected-crank health without funding", () => {
  const source = keeperSource();
  assert.match(source, /reportLpHealth\("startup", signal\)/);
  assert.match(source, /reportLpHealth\("periodic", signal\)/);
  assert.match(source, /reportLpHealth\("crank rejected", signal\)/);
  assert.match(source, /LP_HEALTH_CHECK_MS = 5 \* 60_000/);
  assert.match(source, /LP_FAILURE_HEALTH_CHECK_MS = 60_000/);
  assert.doesNotMatch(source, /fund-current-market-lp|mintTo|topUpBacking|depositInstruction/);
});
