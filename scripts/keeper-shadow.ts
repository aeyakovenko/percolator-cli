import { createHash } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { TransactionInstruction } from "@solana/web3.js";

export type KeeperMode = "live" | "shadow";
export type KeeperAction = "oracle-push" | "lp-crank" | "loss-stale-heal";

export async function executeKeeperPlan<TLive, TShadow>(input: {
  mode: KeeperMode;
  broadcast: () => Promise<TLive>;
  simulate: () => Promise<unknown | null>;
  onShadowAccepted: () => Promise<TShadow>;
}): Promise<
  | { mode: "live"; value: TLive }
  | { mode: "shadow"; simulationError: unknown | null; value: TShadow | null }
> {
  if (input.mode === "live") {
    return { mode: "live", value: await input.broadcast() };
  }
  const simulationError = await input.simulate();
  return {
    mode: "shadow",
    simulationError,
    value: simulationError === null ? await input.onShadowAccepted() : null,
  };
}

export function keeperModeFromEnv(env: Readonly<Record<string, string | undefined>>): KeeperMode {
  const mode = (env.KEEPER_MODE ?? "live").trim().toLowerCase();
  if (mode === "live" || mode === "shadow") return mode;
  throw new Error("KEEPER_MODE must be live or shadow");
}

/**
 * A returned shadow push has already completed a successful RPC simulation,
 * while a returned live push is successful only after explicit confirmation.
 * Both prove provider recovery for circuit-breaking purposes; only the live
 * confirmation is allowed to advance the push watchdog.
 */
export function shouldResetRpcCircuitAfterPush(mode: KeeperMode, confirmed: boolean): boolean {
  return mode === "shadow" || confirmed;
}

function digest(parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : part;
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    hash.update(len);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function instructionDigest(instructions: readonly TransactionInstruction[]): string {
  const parts: Array<string | Uint8Array> = ["ninja/keeper-instructions/v1"];
  for (const instruction of instructions) {
    parts.push(instruction.programId.toBytes());
    parts.push(Uint8Array.of(instruction.keys.length));
    for (const key of instruction.keys) {
      parts.push(key.pubkey.toBytes());
      parts.push(Uint8Array.of(key.isSigner ? 1 : 0, key.isWritable ? 1 : 0));
    }
    parts.push(instruction.data);
  }
  return digest(parts);
}

export interface ShadowDecision {
  version: 1;
  decisionId: string;
  actionFingerprint: string;
  instructionDigest: string;
  action: KeeperAction;
  observedSlot: string;
  market: string;
  payer: string;
  assetIndexes: number[];
  createdAt: string;
}

/**
 * A fingerprint intentionally excludes the observed slot and instruction bytes.
 * A live and shadow keeper will usually observe adjacent slots, so comparison is
 * `(actionFingerprint, bounded slot window)`. `decisionId` and
 * `instructionDigest` preserve the exact shadow plan for audit/replay.
 */
export function buildShadowDecision(input: {
  action: KeeperAction;
  assetIndexes: readonly number[];
  createdAt: string;
  instructions: readonly TransactionInstruction[];
  market: string;
  observedSlot: bigint;
  payer: string;
}): ShadowDecision {
  const assetIndexes = [...new Set(input.assetIndexes)].sort((left, right) => left - right);
  if (assetIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 0xffff)) {
    throw new Error("shadow decision has an invalid asset index");
  }
  const actionFingerprint = digest([
    "ninja/keeper-action/v1",
    input.action,
    input.market,
    assetIndexes.join(","),
  ]);
  const exactInstructionDigest = instructionDigest(input.instructions);
  const observedSlot = input.observedSlot.toString();
  return {
    version: 1,
    decisionId: digest([
      "ninja/keeper-decision/v1",
      actionFingerprint,
      observedSlot,
      exactInstructionDigest,
    ]),
    actionFingerprint,
    instructionDigest: exactInstructionDigest,
    action: input.action,
    observedSlot,
    market: input.market,
    payer: input.payer,
    assetIndexes,
    createdAt: input.createdAt,
  };
}

export async function recordSuccessfulShadowDecision(input: {
  simulationError: unknown | null;
  log: BoundedShadowDecisionLog;
  decision: Parameters<typeof buildShadowDecision>[0];
}): Promise<ShadowDecision | null> {
  if (input.simulationError !== null) return null;
  const decision = buildShadowDecision(input.decision);
  await input.log.append(decision);
  return decision;
}

export interface DecisionSink {
  append(line: string): Promise<void>;
  bytes(): Promise<number>;
  rotate(): Promise<void>;
}

export class BoundedShadowDecisionLog {
  constructor(
    private readonly sink: DecisionSink,
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
      throw new Error("shadow decision log maxBytes must be at least 1024");
    }
  }

  async append(decision: ShadowDecision): Promise<void> {
    const line = `${JSON.stringify(decision)}\n`;
    if (Buffer.byteLength(line) > this.maxBytes) {
      throw new Error("shadow decision exceeds the bounded log size");
    }
    if (await this.sink.bytes() + Buffer.byteLength(line) > this.maxBytes) {
      await this.sink.rotate();
    }
    await this.sink.append(line);
  }
}

export class FileDecisionSink implements DecisionSink {
  constructor(private readonly path: string) {
    if (!path.trim()) throw new Error("shadow decision log path is required");
  }

  async bytes(): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  async rotate(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await rename(this.path, `${this.path}.1`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async append(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
  }
}

export interface AssetQuarantineSnapshot {
  assetIndex: number;
  failures: number;
  openUntilMs: number;
  reason: string;
}

export type AssetSimulationFailure = "asset-rejection" | "inconclusive";
export type PlannedInstructionSimulationFailure =
  | "planned-instruction"
  | "other-instruction"
  | "inconclusive";

/**
 * Return the failing instruction index only for Solana's validated
 * `InstructionError` transaction shape. RPC-level failures such as
 * `BlockhashNotFound` deliberately return null: they do not prove that any
 * particular asset instruction is bad.
 */
export function instructionSimulationErrorIndex(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const instructionError = (error as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(instructionError) || instructionError.length < 2) return null;
  const index = instructionError[0];
  return Number.isSafeInteger(index) && Number(index) >= 0 ? Number(index) : null;
}

/** Attribute a shadow simulation error without treating an RPC-level failure as program evidence. */
export function classifyPlannedInstructionSimulationFailure(
  error: unknown,
  plannedInstructionIndex: number,
): PlannedInstructionSimulationFailure {
  const instructionIndex = instructionSimulationErrorIndex(error);
  if (instructionIndex === null) return "inconclusive";
  return instructionIndex === plannedInstructionIndex ? "planned-instruction" : "other-instruction";
}

/** Bounded, per-asset isolation for deterministic on-chain push failures. */
export class AssetQuarantine {
  private readonly states = new Map<number, AssetQuarantineSnapshot>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly baseBackoffMs = 60_000,
    private readonly maxBackoffMs = 15 * 60_000,
  ) {}

  isOpen(assetIndex: number): boolean {
    const state = this.states.get(assetIndex);
    return state !== undefined && this.now() < state.openUntilMs;
  }

  eligible<T extends { index: number }>(assets: readonly T[]): T[] {
    return assets.filter((asset) => !this.isOpen(asset.index));
  }

  recordFailure(assetIndex: number, reason = "push simulation rejected"): AssetQuarantineSnapshot {
    const previous = this.states.get(assetIndex);
    const failures = (previous?.failures ?? 0) + 1;
    const delay = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** Math.min(failures - 1, 8),
    );
    const next = { assetIndex, failures, openUntilMs: this.now() + delay, reason };
    this.states.set(assetIndex, next);
    return { ...next };
  }

  recordConfirmedSuccess(assetIndex: number): void {
    this.states.delete(assetIndex);
  }

  snapshot(): AssetQuarantineSnapshot[] {
    return [...this.states.values()]
      .map((state) => ({ ...state }))
      .sort((left, right) => left.assetIndex - right.assetIndex);
  }
}

/** Diagnose one rejected batch with at most one simulation per asset. */
export async function isolateRejectedAssets<T extends { index: number }>(input: {
  assets: readonly T[];
  quarantine: AssetQuarantine;
  simulate: (asset: T) => Promise<unknown | null>;
  classifyFailure: (asset: T, error: unknown) => AssetSimulationFailure;
}): Promise<{ healthy: T[]; rejected: AssetQuarantineSnapshot[]; inconclusive: boolean }> {
  const healthy: T[] = [];
  const rejectedAssets: T[] = [];
  let inconclusive = false;
  for (const asset of input.assets) {
    const error = await input.simulate(asset);
    if (error === null) healthy.push(asset);
    else if (input.classifyFailure(asset, error) === "asset-rejection") rejectedAssets.push(asset);
    else inconclusive = true;
  }
  // Never partially quarantine after an RPC/transaction-level failure. A
  // load-balanced RPC can return a fresh blockhash from one backend and reject
  // it on another; whichever asset was probed first must not be blamed.
  if (inconclusive) {
    return { healthy: [], rejected: [], inconclusive: true };
  }
  // If every individual simulation fails, the evidence points to a shared
  // market/account condition, not one poisonous asset. Leave quarantine
  // untouched so a global incident cannot silently remove the full oracle set.
  const rejected = healthy.length === 0
    ? []
    : rejectedAssets.map((asset) => input.quarantine.recordFailure(asset.index));
  return { healthy, rejected, inconclusive: false };
}
