import { KeeperFailure, readV16RecoveryStatus } from "./keeper-runtime.ts";
import { DEFAULT_MAX_ORACLE_LEAD_SLOTS } from "./keeper-policy.ts";

// Existing v16 deployment envelope: no larger batch/CU budget or engine dt.
export const MAX_MAINTENANCE_CRANKS = 9;
export const MAINTENANCE_HEADROOM_SLOTS = 40n;
// Operational admission headroom, not a guarantee about future landing time.
export const MAX_PRE_PUSH_MARKET_LAG = DEFAULT_MAX_ORACLE_LEAD_SLOTS - 16n;
const GROUP = 16 + 448;
const ASSETS = GROUP + 726;
const ASSET_BYTES = 1797;
const MAX_ACCRUAL_DT = GROUP + 32 + 118;

export interface ClockMaintenancePlan {
  assetIndexes: number[];
  blockedAssetIndexes: number[];
  observedSlot: bigint;
  marketCurrentSlot: bigint;
  authMarkAssetIndexes: number[];
  maxDebtSlots: bigint;
  maxAccrualDtSlots: bigint;
  cranks: number;
  capped: boolean;
}

export interface MaintenanceContinuation {
  assetIndexes: number[];
  minimumContextSlot: bigint;
}

export interface KeeperSendContext {
  action: string;
  assetIndexes: readonly number[];
  observedSlot: bigint;
}

/** Logical follow-up work, not a second owner of signed bytes. Only a terminal
 * confirmation may update it. It survives tick cancellation, not process exit. */
export class KeeperMaintenanceContinuation {
  private work: MaintenanceContinuation | null = null;

  snapshot(): MaintenanceContinuation | null {
    return this.work ? { ...this.work, assetIndexes: [...this.work.assetIndexes] } : null;
  }

  assertCanPush(): void {
    if (this.work) throw new KeeperFailure("pending", "confirmed push still requires maintenance and LP settlement");
  }

  recordConfirmed(context: KeeperSendContext, err: unknown | null): void {
    // Buffer initialization is tagged as heal by the legacy shadow recorder;
    // an empty asset list must never create or finish price-follow-up work.
    if (context.assetIndexes.length === 0) {
      if (context.action === "oracle-push") throw new KeeperFailure("onchain", "confirmed push has no assets");
      return;
    }
    if (context.action === "oracle-push") {
      this.assertCanPush();
      if (err !== null) return;
      if (context.observedSlot < 0n || context.observedSlot > BigInt(Number.MAX_SAFE_INTEGER)
        || new Set(context.assetIndexes).size !== context.assetIndexes.length
        || context.assetIndexes.some(i => !Number.isSafeInteger(i) || i < 0 || i >= 8)) {
        throw new KeeperFailure("onchain", "confirmed push continuation is invalid");
      }
      this.work = { assetIndexes: [...context.assetIndexes], minimumContextSlot: context.observedSlot };
    } else if (context.action === "lp-crank" || (context.action === "loss-stale-heal" && err !== null)) {
      // Confirmed rejection is definitive: allow a new feed cycle rather than
      // indefinitely trying to maintain against a stale/rejected oracle mark.
      this.work = null;
    }
  }
}

/** Reconcile before constructing ANY new oracle plan. A late confirmed push
 * must consume its saved continuation, even when the new feed is unavailable. */
export async function resumeBeforeFreshPush(input: {
  signal: AbortSignal;
  continuation: KeeperMaintenanceContinuation;
  reconcile(): Promise<void>;
  resume(work: MaintenanceContinuation): Promise<void>;
}): Promise<boolean> {
  const check = () => {
    if (input.signal.aborted) throw new KeeperFailure("cancelled", "keeper continuation cancelled");
  };
  check();
  await input.reconcile();
  check();
  const work = input.continuation.snapshot();
  if (!work) return false;
  await input.resume(work);
  check();
  return true;
}

/** Treat the RPC envelope as untrusted, including owner and context. */
export function decodeMaintenanceResponse(payload: unknown, input: {
  expectedOwner: string; expectedMarket: Uint8Array; minimumContextSlot: bigint;
  pushedAssetIndexes: readonly number[];
}): ClockMaintenancePlan {
  const response = payload as { result?: { context?: { slot?: unknown };
    value?: { owner?: unknown; data?: unknown } } } | null;
  const value = response?.result?.value;
  const slot = response?.result?.context?.slot;
  if (!value || value.owner !== input.expectedOwner || typeof slot !== "number"
    || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value.data)
    || typeof value.data[0] !== "string" || value.data[1] !== "base64") {
    throw new KeeperFailure("onchain", "maintenance market owner/layout/context unavailable");
  }
  return planClockMaintenance({ ...input, marketData: Buffer.from(value.data[0], "base64"),
    contextSlot: BigInt(slot) });
}

/** Use individual clocks and the response context, not just the last-touched
 * asset's loss-stale summary or a 300-slot monitoring tolerance. Headroom sizes
 * work for time until execution; it never advances an asset into the future. */
export function planClockMaintenance(input: {
  marketData: Uint8Array;
  expectedMarket: Uint8Array;
  contextSlot: bigint;
  minimumContextSlot: bigint;
  pushedAssetIndexes: readonly number[];
}): ClockMaintenancePlan {
  const status = readV16RecoveryStatus(input.marketData, input.expectedMarket, 0n);
  if (input.contextSlot > BigInt(Number.MAX_SAFE_INTEGER)
    || input.contextSlot < input.minimumContextSlot || input.minimumContextSlot < 0n
    || input.contextSlot < status.marketCurrentSlot) {
    throw new KeeperFailure("onchain", "maintenance context slot is stale or inconsistent");
  }
  const view = new DataView(input.marketData.buffer, input.marketData.byteOffset, input.marketData.byteLength);
  const dt = view.getBigUint64(MAX_ACCRUAL_DT, true);
  if (dt === 0n) throw new KeeperFailure("onchain", "maintenance accrual cap is zero");
  const count = view.getUint32(GROUP + 281, true);
  const pushed = new Set(input.pushedAssetIndexes);
  if (pushed.size !== input.pushedAssetIndexes.length
    || [...pushed].some(i => !Number.isSafeInteger(i) || i < 0 || i >= count)) {
    throw new KeeperFailure("onchain", "maintenance asset indexes are invalid");
  }
  const assetIndexes: number[] = [], blockedAssetIndexes: number[] = [], authMarkAssetIndexes: number[] = [];
  let maxDebtSlots = 0n;
  for (let i = 0; i < count; i++) {
    const engine = ASSETS + i * ASSET_BYTES + 512;
    const lifecycle = view.getUint8(engine + 16);
    if (lifecycle !== 2 && lifecycle !== 3) continue;
    if (!pushed.has(i)) { blockedAssetIndexes.push(i); continue; }
    assetIndexes.push(i);
    if (view.getUint8(ASSETS + i * ASSET_BYTES) === 3) authMarkAssetIndexes.push(i);
    const debt = input.contextSlot - view.getBigUint64(engine + 41, true);
    if (debt > maxDebtSlots) maxDebtSlots = debt;
  }
  const needed = (maxDebtSlots + MAINTENANCE_HEADROOM_SLOTS + dt - 1n) / dt;
  const capped = needed > BigInt(MAX_MAINTENANCE_CRANKS);
  return { assetIndexes, blockedAssetIndexes, observedSlot: input.contextSlot,
    marketCurrentSlot: status.marketCurrentSlot, authMarkAssetIndexes,
    maxDebtSlots, maxAccrualDtSlots: dt,
    cranks: assetIndexes.length === 0 ? 0 : Number(capped ? BigInt(MAX_MAINTENANCE_CRANKS) : needed),
    capped: assetIndexes.length > 0 && capped };
}

/** Normal upkeep certifies LP in its final instruction. Capped recovery keeps
 * making bounded clock progress, but cannot claim a current LP certificate. */
export function maintenanceBatchLayout(plan: ClockMaintenancePlan): {
  leglessCranks: number; settlesLp: boolean;
} {
  if (!Number.isInteger(plan.cranks) || plan.cranks < 1 || plan.cranks > MAX_MAINTENANCE_CRANKS
    || plan.assetIndexes.length === 0 || plan.blockedAssetIndexes.length !== 0
    || plan.authMarkAssetIndexes.length !== plan.assetIndexes.length) {
    throw new KeeperFailure("onchain", "maintenance batch requires all live configured AuthMark assets and a bounded plan");
  }
  // Planning context is not landing time. Use the already-reviewed nine-IX
  // envelope even for ordinary upkeep: idle instructions do not move clocks
  // into the future, while spare accrual capacity absorbs delayed inclusion.
  // This is not a guarantee through an arbitrary RPC outage; capped recovery
  // remains legless, and the independent audit remains authoritative.
  return { leglessCranks: plan.capped ? plan.cranks : MAX_MAINTENANCE_CRANKS - 1, settlesLp: !plan.capped };
}

/** A delayed LP/idle period must not knowingly become an oversized new push.
 * Pre-push work uses the SAME batch budget as post-push work. Normal batches
 * certify LP atomically; capped work is recovery-only. Neither refreshes oracle
 * timestamps. The independent audit retains its limits. */
export async function admitFreshPush(input: {
  signal: AbortSignal;
  readPlan(): Promise<ClockMaintenancePlan>;
  maintain(plan: ClockMaintenancePlan): Promise<void>;
  refreshFeed(): Promise<void>;
}): Promise<{ admitted: boolean; observedSlot: bigint; maintenanceUsed: boolean }> {
  const check = () => {
    if (input.signal.aborted) throw new KeeperFailure("cancelled", "pre-push admission cancelled");
  };
  check();
  const read = async () => {
    const plan = await input.readPlan();
    check();
    if (plan.assetIndexes.length === 0 || plan.blockedAssetIndexes.length !== 0
      || plan.authMarkAssetIndexes.length !== plan.assetIndexes.length) {
      throw new KeeperFailure("onchain", "pre-push admission requires all live assets to be configured AuthMark assets");
    }
    return plan;
  };
  const plan = await read();
  if (plan.observedSlot - plan.marketCurrentSlot <= MAX_PRE_PUSH_MARKET_LAG) {
    return { admitted: true, observedSlot: plan.observedSlot, maintenanceUsed: false };
  }
  await input.maintain(plan);
  check();
  // Do not wait an entire tick cadence after catch-up or reuse a price fetched
  // before it. Refresh once, re-read once, and never run a second batch here.
  await input.refreshFeed();
  check();
  const after = await read();
  if (after.observedSlot < plan.observedSlot || after.marketCurrentSlot < plan.marketCurrentSlot) {
    throw new KeeperFailure("onchain", "pre-push market/context regressed after maintenance");
  }
  return { admitted: after.observedSlot - after.marketCurrentSlot <= MAX_PRE_PUSH_MARKET_LAG,
    observedSlot: after.observedSlot, maintenanceUsed: true };
}

/** One fresh plan and one atomic maintenance/LP (or capped recovery-only) batch.
 * No separate LP send may expose an epoch/certificate gap. Pending bytes remain
 * owned by the existing gate; no second batch or hidden retry. */
export async function maintainBeforeLp<T>(input: {
  signal: AbortSignal;
  readPlan(): Promise<ClockMaintenancePlan>;
  runBatch(plan: ClockMaintenancePlan): Promise<T>;
}): Promise<T | undefined> {
  const checkCancelled = () => {
    if (input.signal.aborted) throw new KeeperFailure("cancelled", "clock maintenance cancelled");
  };
  checkCancelled();
  const plan = await input.readPlan();
  checkCancelled();
  if (plan.cranks === 0) return undefined;
  const result = await input.runBatch(plan);
  checkCancelled();
  return result;
}
