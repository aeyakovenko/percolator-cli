import test from "node:test";
import assert from "node:assert/strict";
import { planClockMaintenance, maintainBeforeLp, decodeMaintenanceResponse,
  KeeperMaintenanceContinuation, resumeBeforeFreshPush, admitFreshPush,
  MAX_PRE_PUSH_MARKET_LAG, maintenanceBatchLayout, type KeeperSendContext } from "./keeper-maintenance.ts";
import { KeeperFailure, SingleTickRunner, PendingBroadcastGate } from "./keeper-runtime.ts";

function fixture(slots = [1000n, 1000n, 1000n], lifecycle = slots.map(() => 2)) {
  const market = new Uint8Array(32).fill(7);
  const data = Buffer.alloc(1190 + slots.length * 1797);
  data.writeBigUInt64LE(0x5045524356313600n, 0); data.writeUInt16LE(16, 8); data[10] = 1;
  data.set(market, 464); data.writeUInt32LE(slots.length, 464 + 281);
  data.writeBigUInt64LE(1000n, 464 + 581); data.writeBigUInt64LE(20n, 614);
  slots.forEach((slot, i) => { data[1190+i*1797] = 3; data[1190+i*1797+512+16] = lifecycle[i]; data.writeBigUInt64LE(slot,1190+i*1797+512+41); });
  return { marketData: data, expectedMarket: market, contextSlot: 1030n,
    minimumContextSlot: 1020n, pushedAssetIndexes: [0,1,2] };
}

test("fresh head context triggers proactive work even with a clear lock and zero market-relative debt", () => {
  const p = planClockMaintenance(fixture());
  assert.equal(p.cranks, 4); assert.equal(p.maxDebtSlots, 30n);
  assert.equal(p.maxAccrualDtSlots,20n); assert.equal(p.capped,false);
});
test("ordinary batch keeps the full bounded landing envelope after an initially small debt", () => {
  const plan = planClockMaintenance(fixture());
  assert.equal(plan.cranks, 4);
  const landingDebt = plan.maxDebtSlots + 90n;
  assert.ok(BigInt(plan.cranks) * plan.maxAccrualDtSlots < landingDebt);
  const layout = maintenanceBatchLayout(plan);
  assert.equal(layout.settlesLp, true);
  assert.equal(layout.leglessCranks + 1, 9);
  assert.ok(BigInt(layout.leglessCranks) * plan.maxAccrualDtSlots >= landingDebt);
});
test("RPC response must have the expected owner, encoding and safe fresh context",()=>{
  const f=fixture();
  const input={...f,expectedOwner:"expected-program"};
  const response={result:{context:{slot:1030},value:{owner:"expected-program",data:[f.marketData.toString("base64"),"base64"]}}};
  assert.equal(decodeMaintenanceResponse(response,input).cranks,4);
  for(const payload of [null,{}, {error:{code:429}},
    {result:{...response.result,value:{...response.result.value,owner:"wrong"}}},
    {result:{...response.result,value:{...response.result.value,data:["bad","json"]}}},
    {result:{...response.result,context:{slot:"1030"}}},
    {result:{...response.result,context:{slot:Number.MAX_SAFE_INTEGER+1}}},
    {result:{...response.result,context:{slot:1019}}},
  ]) assert.throws(()=>decodeMaintenanceResponse(payload,input));
});
test("slow slots reduce work; healthy decisions are never cached", () => {
  const f = fixture(); f.contextSlot=1000n; f.minimumContextSlot=1000n;
  assert.equal(planClockMaintenance(f).cranks,2);
  f.contextSlot=1040n;
  assert.equal(planClockMaintenance(f).cranks,4);
  f.marketData.writeBigUInt64LE(100n,614);
  assert.equal(planClockMaintenance(f).cranks,1);
});
test("worst eligible asset controls planning, not the LP-selected first asset", () => {
  const p = planClockMaintenance(fixture([1000n, 940n, 960n]));
  assert.equal(p.maxDebtSlots,90n); assert.equal(p.cranks,7);
});
test("large debt is bounded to the existing nine-crank envelope", () => {
  const p=planClockMaintenance(fixture([0n,0n,0n]));
  assert.equal(p.cranks,9); assert.equal(p.capped,true);
});
test("Recovery/retired assets and unavailable feeds are excluded, drain-only included", () => {
  const f=fixture([1000n,990n,0n,0n,0n],[2,3,5,4,2]);
  f.pushedAssetIndexes=[0,1,2,3];
  const p=planClockMaintenance(f);
  assert.deepEqual(p.assetIndexes,[0,1]); assert.deepEqual(p.blockedAssetIndexes,[4]);
  assert.equal(p.maxDebtSlots,40n);
  f.pushedAssetIndexes=[]; assert.equal(planClockMaintenance(f).cranks,0);
});
test("parser rejects wrong identity, layout, lifecycle, cap and stale/inconsistent context", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.expectedMarket=new Uint8Array(32); },
    (f: ReturnType<typeof fixture>) => { f.marketData=f.marketData.subarray(0,-1); },
    (f: ReturnType<typeof fixture>) => { f.marketData[1190+512+16]=6; },
    (f: ReturnType<typeof fixture>) => { f.marketData.writeBigUInt64LE(0n,614); },
    (f: ReturnType<typeof fixture>) => { f.contextSlot=999n; },
    (f: ReturnType<typeof fixture>) => { f.minimumContextSlot=1040n; },
    (f: ReturnType<typeof fixture>) => { f.pushedAssetIndexes=[0,0]; },
    (f: ReturnType<typeof fixture>) => { f.pushedAssetIndexes=[3]; },
    (f: ReturnType<typeof fixture>) => { f.marketData.writeBigUInt64LE(1001n,1190+512+41); },
  ]) { const f=fixture(); mutate(f); assert.throws(()=>planClockMaintenance(f)); }
});

// Model the engine's per-asset min(dt, cap) rule, NOT future clock advancement.
// Distinct from a real SBF/CU test; regression verifies the scheduler's capacity.
for (const slotsPerTick of [30n,40n]) test(`sustained ${slotsPerTick} slots/tick stays current after maintenance`, () => {
  let slots=[1000n,1000n,1000n], now=1000n;
  for (let tick=0;tick<500;tick++) {
    now+=slotsPerTick;
    const f=fixture(slots); f.marketData.writeBigUInt64LE(now,464+581);
    f.contextSlot=now; f.minimumContextSlot=now;
    const p=planClockMaintenance(f);
    const executionSlot=now+35n; // within explicit40-slot execution allowance
    slots=slots.map(s=>s+((executionSlot-s)<20n*BigInt(p.cranks)?executionSlot-s:20n*BigInt(p.cranks)));
    assert.ok(slots.every(s=>s===executionSlot));
    assert.ok(p.cranks<=9);
    now=executionSlot;
  }
});
test("a forty-second gap recovers over bounded ticks without pretending the first batch is enough", () => {
  let slots=[1000n,1000n,1000n], now=1240n, caughtUp=false;
  for(let tick=0;tick<5;tick++) {
    const f=fixture(slots); f.marketData.writeBigUInt64LE(now,464+581);
    f.contextSlot=now; f.minimumContextSlot=now;
    const p=planClockMaintenance(f); if(tick===0)assert.equal(p.capped,true);
    slots=slots.map(s=>s+(now-s<20n*BigInt(p.cranks)?now-s:20n*BigInt(p.cranks)));
    if(slots.every(s=>s===now)){caughtUp=true;break;}
    now+=40n;
  }
  assert.equal(caughtUp,true);
});
test("legacy one-crank cadence accumulates debt at thirty slots/tick", () => {
  let state=1000n, now=1000n;
  for(let i=0;i<6;i++){now+=30n;state+=20n;}
  assert.equal(now-state,60n);
});
test("one fresh plan sends exactly one atomic maintenance/LP batch", async () => {
  const calls:string[]=[]; const plan=planClockMaintenance(fixture());
  const result=await maintainBeforeLp({signal:new AbortController().signal,
    readPlan:async()=>{calls.push("read");return plan;},
    runBatch:async()=>{calls.push("atomic-maintenance-lp");return 7;}});
  assert.equal(result,7); assert.deepEqual(calls,["read","atomic-maintenance-lp"]);
});
for (const kind of ["rate_limit","pending","timeout","onchain"] as const) test(`${kind} stops LP and does not start a second batch`,async()=>{
  let batches=0;const failure=new KeeperFailure(kind,"test");
  await assert.rejects(maintainBeforeLp({signal:new AbortController().signal,
    readPlan:async()=>planClockMaintenance(fixture()),runBatch:async()=>{batches++;throw failure;}}),e=>e===failure);
  assert.equal(batches,1);
});
test("failed fresh read never reuses an earlier successful plan",async()=>{
  let sends=0;await assert.rejects(maintainBeforeLp({signal:new AbortController().signal,
    readPlan:async()=>{throw new KeeperFailure("rate_limit","probe");},
    runBatch:async()=>{sends++;}}));assert.equal(sends,0);
});
test("cancellation after the atomic batch prevents caller success without a second send",async()=>{
  const c=new AbortController();let sends=0;
  await assert.rejects(maintainBeforeLp({signal:c.signal,readPlan:async()=>planClockMaintenance(fixture()),
    runBatch:async()=>{sends++;c.abort();}}));assert.equal(sends,1);
});
test("atomic LP failure propagates without a second batch or separate LP retry",async()=>{
  let batches=0;
  await assert.rejects(maintainBeforeLp({signal:new AbortController().signal,readPlan:async()=>planClockMaintenance(fixture()),
    runBatch:async()=>{batches++;throw new Error("LP failure");}}));assert.equal(batches,1);
});
test("slow maintenance retains the singleton tick guard and original pending signature",async()=>{
  const runner=new SingleTickRunner(); const gate=new PendingBroadcastGate<string>();
  let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  let sends=0;
  const first=runner.run(signal=>maintainBeforeLp({signal,
    readPlan:async()=>planClockMaintenance(fixture()),
    runBatch:async()=>{
      sends++;
      gate.record({context:"maintenance",rawTransaction:Uint8Array.of(1,2,3),
        strategy:{signature:"original",blockhash:"hash",lastValidBlockHeight:200}});
      entered();await waiting;throw new KeeperFailure("pending","still unconfirmed");
    }}));
  await started;
  assert.equal(await runner.run(async()=>{throw new Error("overlap");}),false);
  assert.equal(gate.snapshot()?.strategy.signature,"original");
  release();await assert.rejects(first);
  assert.equal(sends,1);assert.equal(gate.snapshot()?.strategy.signature,"original");
  assert.throws(()=>gate.record({context:"replacement",rawTransaction:Uint8Array.of(4),
    strategy:{signature:"new",blockhash:"hash",lastValidBlockHeight:201}}));
});

const pushContext = (): KeeperSendContext => ({ action: "oracle-push", assetIndexes: [0, 1, 2], observedSlot: 1030n });

test("normal batches reserve exactly one of nine crank instructions for LP",()=>{
  const plan=planClockMaintenance(fixture());
  for(let cranks=1;cranks<=9;cranks++) {
    assert.deepEqual(maintenanceBatchLayout({...plan,cranks,capped:false}),{leglessCranks:8,settlesLp:true});
    assert.deepEqual(maintenanceBatchLayout({...plan,cranks,capped:true}),{leglessCranks:cranks,settlesLp:false});
  }
  for(const bad of [{cranks:0},{cranks:10},{cranks:1.5},{assetIndexes:[]},
    {blockedAssetIndexes:[3]},{authMarkAssetIndexes:[0]}]) {
    assert.throws(()=>maintenanceBatchLayout({...plan,...bad}));
  }
});

test("capped recovery retains continuation until an atomic LP batch is confirmed",()=>{
  const c=new KeeperMaintenanceContinuation();c.recordConfirmed(pushContext(),null);
  let now=1400n,slots=[1000n,1000n,1000n],completed=false,recovery=0;
  for(let tick=0;tick<10;tick++) {
    const f=fixture(slots);f.marketData.writeBigUInt64LE(now,464+581);f.contextSlot=now;f.minimumContextSlot=now;
    const plan=planClockMaintenance(f),layout=maintenanceBatchLayout(plan);
    const landing=now+30n;
    slots=slots.map(s=>s+20n*BigInt(plan.cranks)>landing?landing:s+20n*BigInt(plan.cranks));
    const action=layout.settlesLp?"lp-crank":"loss-stale-heal";
    c.recordConfirmed({...pushContext(),action,observedSlot:now},null);
    if(layout.settlesLp){assert.ok(slots.every(s=>s===landing));assert.equal(c.snapshot(),null);completed=true;break;}
    recovery++;assert.ok(c.snapshot());assert.throws(()=>c.assertCanPush());now=landing+30n;
  }
  assert.ok(completed&&recovery>0);
});

test("late atomic confirmation consumes pending bytes and continuation exactly once",async()=>{
  const c=new KeeperMaintenanceContinuation(),gate=new PendingBroadcastGate<KeeperSendContext>();
  c.recordConfirmed(pushContext(),null);
  gate.record({context:{...pushContext(),action:"lp-crank"},rawTransaction:Uint8Array.of(8,9),
    strategy:{signature:"atomic-original",blockhash:"hash",lastValidBlockHeight:100}});
  let resumes=0;
  const result=await resumeBeforeFreshPush({signal:new AbortController().signal,continuation:c,
    reconcile:async()=>{const p=gate.snapshot()!;c.recordConfirmed(p.context,null);},
    resume:async()=>{resumes++;}});
  assert.equal(result,false);assert.equal(resumes,0);assert.equal(c.snapshot(),null);
  assert.equal(gate.snapshot()?.strategy.signature,"atomic-original"); // transport still owns bytes until its normal resolution
});

test("continuation validates and copies confirmed push context; blocks replacement push", () => {
  const c = new KeeperMaintenanceContinuation(), context = pushContext();
  c.recordConfirmed(context, null);
  (context.assetIndexes as number[])[0] = 7;
  c.snapshot()!.assetIndexes[1] = 7;
  assert.deepEqual(c.snapshot(), { assetIndexes: [0, 1, 2], minimumContextSlot: 1030n });
  assert.throws(() => c.assertCanPush());
  assert.throws(() => c.recordConfirmed(pushContext(), null));
  for (const bad of [{...pushContext(),assetIndexes:[]}, {...pushContext(),assetIndexes:[0,0]},
    {...pushContext(),assetIndexes:[8]}, {...pushContext(),observedSlot:-1n}]) {
    assert.throws(() => new KeeperMaintenanceContinuation().recordConfirmed(bad,null));
  }
});

test("only terminal confirmation drives continuation, including rejection and boot isolation", () => {
  const c = new KeeperMaintenanceContinuation();
  c.recordConfirmed(pushContext(), {InstructionError:[2,21]}); assert.equal(c.snapshot(),null);
  c.recordConfirmed({...pushContext(),action:"loss-stale-heal",assetIndexes:[]},null);
  assert.equal(c.snapshot(),null);
  c.recordConfirmed(pushContext(),null);
  c.recordConfirmed({...pushContext(),action:"loss-stale-heal"},null);
  assert.ok(c.snapshot());
  c.recordConfirmed({...pushContext(),action:"lp-crank"},null);
  assert.equal(c.snapshot(),null);
  for (const action of ["loss-stale-heal","lp-crank"]) {
    c.recordConfirmed(pushContext(),null);
    c.recordConfirmed({...pushContext(),action}, {InstructionError:[2,21]});
    assert.equal(c.snapshot(),null);
    assert.doesNotThrow(()=>c.assertCanPush());
  }
});

test("late push: reconcile identical bytes, maintain then LP, no second push or feed read", async () => {
  const c = new KeeperMaintenanceContinuation(), gate = new PendingBroadcastGate<KeeperSendContext>();
  const calls:string[]=[];
  gate.record({context:pushContext(),rawTransaction:Uint8Array.of(1,2),
    strategy:{signature:"old-push",blockhash:"hash",lastValidBlockHeight:200}});
  let landed=false;
  const tick = () => resumeBeforeFreshPush({signal:new AbortController().signal,continuation:c,
    reconcile:async()=>{
      const r=await gate.reconcile({
        rebroadcast:async(bytes)=>{assert.deepEqual(bytes,Uint8Array.of(1,2));calls.push("same-bytes");return "old-push";},
        confirm:async()=>{if(!landed)throw new KeeperFailure("pending","late");return {value:{err:null}};}});
      if(r){calls.push("old-confirmed");c.recordConfirmed(r.context,null);}
    },resume:async work=>{
      assert.deepEqual(work.assetIndexes,[0,1,2]);assert.equal(work.minimumContextSlot,1030n);
      calls.push("fresh-maintenance-read","maintenance","lp");
      c.recordConfirmed({...pushContext(),action:"lp-crank"},null);
    }});
  await assert.rejects(tick());assert.equal(c.snapshot(),null);
  landed=true;
  const resumed=await tick();
  if(!resumed)calls.push("new-feed-read","new-push");
  assert.deepEqual(calls,["same-bytes","same-bytes","old-confirmed","fresh-maintenance-read","maintenance","lp"]);
  assert.equal(gate.hasPending(),false);assert.equal(c.snapshot(),null);
});

test("late maintenance is reconciled before fresh bounded maintenance, never another push",async()=>{
  const c=new KeeperMaintenanceContinuation();c.recordConfirmed(pushContext(),null);
  const calls:string[]=[];
  const resumed=await resumeBeforeFreshPush({signal:new AbortController().signal,continuation:c,
    reconcile:async()=>{calls.push("old-maintenance-confirmed");c.recordConfirmed({...pushContext(),action:"loss-stale-heal"},null);},
    resume:async()=>{calls.push("fresh-plan","one-new-bounded-batch","lp");c.recordConfirmed({...pushContext(),action:"lp-crank"},null);}});
  assert.equal(resumed,true);
  assert.deepEqual(calls,["old-maintenance-confirmed","fresh-plan","one-new-bounded-batch","lp"]);
});

test("late LP confirmation clears work, so next cycle does not duplicate settlement",async()=>{
  const c=new KeeperMaintenanceContinuation();c.recordConfirmed(pushContext(),null);
  assert.equal(await resumeBeforeFreshPush({signal:new AbortController().signal,continuation:c,
    reconcile:async()=>c.recordConfirmed({...pushContext(),action:"lp-crank"},null),
    resume:async()=>{assert.fail("duplicate settlement");}}),false);
});

test("expiry plus history miss does not mark maintenance or LP complete",async()=>{
  for (const action of ["oracle-push","loss-stale-heal","lp-crank"]) {
    const c=new KeeperMaintenanceContinuation(),gate=new PendingBroadcastGate<KeeperSendContext>();
    if(action!=="oracle-push")c.recordConfirmed(pushContext(),null);
    gate.record({context:{...pushContext(),action},rawTransaction:Uint8Array.of(1),
      strategy:{signature:"expired",blockhash:"hash",lastValidBlockHeight:1}});
    await assert.rejects(resumeBeforeFreshPush({signal:new AbortController().signal,continuation:c,
      reconcile:async()=>{await gate.reconcile({confirm:async()=>{throw new KeeperFailure("expired","final history miss");}});},
      resume:async()=>{assert.fail("expiry is not a successful confirmation");}}));
    assert.equal(gate.hasPending(),false);
    assert.equal(c.snapshot()!==null,action!=="oracle-push");
  }
});

test("cancelled or failed resume retains continuation and does not read a new feed",async()=>{
  for(const cancel of [true,false]){
    const c=new KeeperMaintenanceContinuation();c.recordConfirmed(pushContext(),null);
    const signal=new AbortController();let resumed=0;
    await assert.rejects(resumeBeforeFreshPush({signal:signal.signal,continuation:c,
      reconcile:async()=>{if(cancel)signal.abort();},resume:async()=>{resumed++;throw new KeeperFailure("rate_limit","read blocked");}}));
    assert.equal(resumed,cancel?0:1);assert.ok(c.snapshot());assert.throws(()=>c.assertCanPush());
  }
});

test("pre-push admission retains sixteen slots of the unchanged audit bound",async()=>{
  assert.equal(MAX_PRE_PUSH_MARKET_LAG,48n);
  for(const debt of [0n,48n,49n,82n,1000n]){
    const f=fixture();f.contextSlot=1000n+debt;f.minimumContextSlot=1000n;
    let batches=0;
    const result=await admitFreshPush({signal:new AbortController().signal,
      refreshFeed:async()=>{},
      readPlan:async()=>planClockMaintenance(f),maintain:async p=>{batches++;assert.ok(p.cranks<=9);}});
    assert.equal(result.admitted,debt<=48n);assert.equal(batches,debt<=48n?0:1);
    assert.equal(result.observedSlot,f.contextSlot);
  }
});

test("late LP confirmation followed by 82-slot debt gets maintenance, not another push",async()=>{
  const c=new KeeperMaintenanceContinuation();c.recordConfirmed(pushContext(),null);
  const calls:string[]=[];
  assert.equal(await resumeBeforeFreshPush({signal:new AbortController().signal,continuation:c,
    reconcile:async()=>{c.recordConfirmed({...pushContext(),action:"lp-crank"},null);calls.push("late-lp");},
    resume:async()=>assert.fail("LP already confirmed")}),false);
  const f=fixture();f.contextSlot=1082n;
  const result=await admitFreshPush({signal:new AbortController().signal,
    refreshFeed:async()=>{calls.push("fresh-feed");},
    readPlan:async()=>{calls.push("fresh-read");return planClockMaintenance(f);},
    maintain:async()=>{calls.push("maintenance-only");}});
  if(result.admitted)calls.push("push","post-push-maintenance","lp");
  assert.deepEqual(calls,["late-lp","fresh-read","maintenance-only","fresh-feed","fresh-read"]);
  assert.equal(c.snapshot(),null);
});

test("pre-push read/maintenance failure and cancellation cannot grant admission",async()=>{
  const f=fixture();f.contextSlot=1082n;
  for(const phase of ["read","maintain","cancel-before","cancel-after-read","cancel-after-maintain"]){
    const c=new AbortController();let batches=0;
    if(phase==="cancel-before")c.abort();
    await assert.rejects(admitFreshPush({signal:c.signal,
      refreshFeed:async()=>{},
      readPlan:async()=>{if(phase==="read")throw new KeeperFailure("rate_limit","read");
        if(phase==="cancel-after-read")c.abort();return planClockMaintenance(f);},
      maintain:async()=>{batches++;if(phase==="cancel-after-maintain")c.abort();
        if(phase==="maintain")throw new KeeperFailure("pending","same signed bytes pending");}}));
    assert.equal(batches,["maintain","cancel-after-maintain"].includes(phase)?1:0);
  }
});

test("pre-push validates every live asset; Recovery is exempt, not unsupported live feeds",async()=>{
  const f=fixture([1000n,1000n,0n],[2,3,5]);f.contextSlot=1082n;
  f.marketData[1190+2*1797]=0;
  const run=(input:ReturnType<typeof fixture>)=>admitFreshPush({signal:new AbortController().signal,
    refreshFeed:async()=>{},
    readPlan:async()=>planClockMaintenance(input),maintain:async p=>assert.deepEqual(p.assetIndexes,[0,1])});
  assert.equal((await run(f)).admitted,false);
  await assert.rejects(run({...f,pushedAssetIndexes:[0]}));
  f.marketData[1190+1797]=0;await assert.rejects(run(f));
  await assert.rejects(run(fixture([0n,0n,0n],[5,5,5])));
});

test("maintenance-only tick converges then admits fresh pushes without a permanent latch",async()=>{
  let now=1082n,market=1000n,slots=[1000n,1000n,1000n],pushes=0,maintenanceOnly=0;
  for(let tick=0;tick<200;tick++){
    const f=fixture(slots);f.marketData.writeBigUInt64LE(market,464+581);
    f.contextSlot=now;f.minimumContextSlot=market;
    let batches=0;
    const r=await admitFreshPush({signal:new AbortController().signal,
      refreshFeed:async()=>{},
      readPlan:async()=>planClockMaintenance(f),maintain:async p=>{
        batches++;maintenanceOnly++;market=now;
        slots=slots.map(s=>s+BigInt(p.cranks)*20n>now?now:s+BigInt(p.cranks)*20n);
      }});
    if(r.admitted){pushes++;market=now;slots=slots.map(()=>now);}
    assert.ok(batches<=1);now+=30n;
  }
  assert.equal(maintenanceOnly,1);assert.equal(pushes,199);
});

test("repeated slow cycles refresh once after maintenance and push without a second batch",async()=>{
  for(let cycle=0;cycle<100;cycle++){
    const f=fixture();f.contextSlot=1082n;
    let reads=0,batches=0,feeds=0;
    const c=new KeeperMaintenanceContinuation();
    const r=await admitFreshPush({signal:new AbortController().signal,
      readPlan:async()=>{reads++;return planClockMaintenance(f);},
      maintain:async()=>{batches++;f.marketData.writeBigUInt64LE(1082n,464+581);},
      refreshFeed:async()=>{feeds++;f.contextSlot=1092n;}});
    assert.deepEqual([reads,batches,feeds],[2,1,1]);
    assert.deepEqual(r,{admitted:true,observedSlot:1092n,maintenanceUsed:true});
    c.recordConfirmed({...pushContext(),observedSlot:r.observedSlot},null);
    assert.ok(c.snapshot());assert.throws(()=>c.assertCanPush());
    // Tick exits here; the existing continuation (not another push/LP now)
    // owns the subsequent maintenance and settlement on the next tick.
  }
});

test("post-maintenance feed failure and second-read regression never permit a push",async()=>{
  for(const bad of ["feed","context","market"]){
    const f=fixture();f.contextSlot=1082n;let batches=0;
    await assert.rejects(admitFreshPush({signal:new AbortController().signal,
      readPlan:async()=>planClockMaintenance(f),maintain:async()=>{batches++;},
      refreshFeed:async()=>{if(bad==="feed")throw new KeeperFailure("transport","feed unavailable");
        if(bad==="context")f.contextSlot=1081n;
        else {f.marketData.writeBigUInt64LE(999n,464+581);f.marketData.writeBigUInt64LE(999n,1190+512+41);
          f.marketData.writeBigUInt64LE(999n,1190+1797+512+41);f.marketData.writeBigUInt64LE(999n,1190+2*1797+512+41);}}}));
    assert.equal(batches,1);
  }
});
