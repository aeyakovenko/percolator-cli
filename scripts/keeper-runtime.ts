import { createHash } from "node:crypto";

export type KeeperFailureKind = "cancelled" | "expired" | "onchain" | "pending" | "provider_denied" | "rate_limit" | "timeout" | "transport" | "unknown";
export type KeeperOperationPhase = "base-rpc-http" | "magicblock-rpc-http" | "hermes-feed" | "maintenance-plan" | "confirmation-read";

export class KeeperFailure extends Error {
  phase?: KeeperOperationPhase;
  elapsedMs?: number;
  constructor(
    public readonly kind: KeeperFailureKind,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "KeeperFailure";
  }
}

export interface Clock {
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  now(): number;
  random(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
}

export const systemClock: Clock = {
  clearTimeout,
  now: Date.now,
  random: Math.random,
  setTimeout,
};

/** Link a child operation to its parent synchronously. The second aborted
 * check closes the small "already aborted before listener" race: a child
 * confirmation must never be able to outlive the tick that owns it. */
export function linkedAbortController(parent: AbortSignal): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  return {
    controller,
    dispose: () => parent.removeEventListener("abort", abort),
  };
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

export function retryAfterMs(headers: unknown, nowMs: number): number | undefined {
  const value = headerValue(headers, "retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === "number" ? status : undefined;
}

function headersOf(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as { headers?: unknown; response?: { headers?: unknown } }).headers
    ?? (error as { response?: { headers?: unknown } }).response?.headers;
}

export function classifyKeeperError(error: unknown, signal?: AbortSignal, nowMs = Date.now()): KeeperFailure {
  if (error instanceof KeeperFailure) return error;
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new KeeperFailure("cancelled", "keeper operation cancelled");
  }
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const retryAfter = retryAfterMs(headersOf(error), nowMs);
  if (status === 429 || /(?:429|too many requests|rate.?limit|max(?:imum)? usage|quota|credits? exhausted)/i.test(message)) {
    return new KeeperFailure("rate_limit", "RPC rate limit or quota exhaustion", retryAfter);
  }
  if ((status !== undefined && status >= 500) || /(?:fetch failed|network|socket|econn|etimedout|connection reset|service unavailable)/i.test(message)) {
    return new KeeperFailure("transport", "RPC transport failure");
  }
  return new KeeperFailure("unknown", "keeper operation failed");
}

export function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:https?|wss?):\/\/\S+/gi, "[url]")
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s,;]+/gi, "Authorization: Bearer [redacted]")
    .replace(/\bbearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(["'])(x-api-key|api[-_]?key|token|authorization)\1\s*:\s*["'][^"']*["']/gi, "$1$2$1:[redacted]")
    .replace(/\b(x-api-key|api[-_]?key|token|authorization)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,}&]+)/gi, "$1$2[redacted]");
}

export function formatUnhandledRejection(reason: unknown): string {
  return `[unhandledRejection] ${safeErrorMessage(reason).slice(0, 140)}`;
}

export function abortableSleep(ms: number, signal: AbortSignal, clock: Clock = systemClock): Promise<void> {
  if (signal.aborted) return Promise.reject(new KeeperFailure("cancelled", "keeper wait cancelled"));
  return new Promise((resolve, reject) => {
    const timeout = clock.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clock.clearTimeout(timeout);
      reject(new KeeperFailure("cancelled", "keeper wait cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A Solana confirmation is successful only when it explicitly carries
 * `value.err === null`. Missing/null/aborted confirmation payloads are failure
 * states, never an implicit success. */
export function confirmedTransactionError(result: unknown): unknown | null {
  if (!result || typeof result !== "object") {
    throw new KeeperFailure("timeout", "keeper confirmation returned no result");
  }
  const value = (result as { value?: unknown }).value;
  if (!value || typeof value !== "object" || !("err" in value)) {
    throw new KeeperFailure("timeout", "keeper confirmation returned an incomplete result");
  }
  const err = (value as { err: unknown }).err;
  if (err === undefined) {
    throw new KeeperFailure("timeout", "keeper confirmation returned an incomplete result");
  }
  return err;
}

export function isCustomProgramError(error: unknown, code: number): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { Custom?: unknown; InstructionError?: unknown };
  if (candidate.Custom === code) return true;
  // Solana/web3 serializes instruction failures as
  // { InstructionError: [instructionIndex, { Custom: code }] }.
  const instructionError = candidate.InstructionError;
  return Array.isArray(instructionError)
    && instructionError.length >= 2
    && Boolean(instructionError[1]
      && typeof instructionError[1] === "object"
      && (instructionError[1] as { Custom?: unknown }).Custom === code);
}

function rawInstructionCustomError(error: unknown): { InstructionError: [number, { Custom: number }] } | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { InstructionError?: unknown };
  const instructionError = candidate.InstructionError;
  if (!Array.isArray(instructionError) || instructionError.length !== 2) return null;
  const [instructionIndex, detail] = instructionError;
  if (!Number.isSafeInteger(instructionIndex) || instructionIndex < 0
    || !detail || typeof detail !== "object"
    || !Number.isSafeInteger((detail as { Custom?: unknown }).Custom)
    || (detail as { Custom: number }).Custom < 0
    || Object.keys(detail).length !== 1) return null;
  return { InstructionError: [instructionIndex, { Custom: (detail as { Custom: number }).Custom }] };
}

/** web3 may reject the fallback confirmation path while still attaching an
 * on-chain result. Preserve that result so a Custom 21 reaches self-heal. */
export function confirmationResultFromError(error: unknown): { value: { err: unknown } } | null {
  if (!error || typeof error !== "object") return null;
  const root = error as { value?: unknown; error?: { value?: unknown } };
  const value = root.value ?? root.error?.value;
  if (value && typeof value === "object" && "err" in value) {
    return { value: { err: (value as { err: unknown }).err } };
  }
  // getSignatureStatus fallback can reject the raw Solana TransactionError
  // itself instead of decorating an Error with value.err.
  const raw = rawInstructionCustomError(error);
  return raw ? { value: { err: raw } } : null;
}

export interface ConfirmationStrategy {
  blockhash: string;
  lastValidBlockHeight: number;
  signature: string;
}

export interface ConfirmationConnection {
  getBlockHeight?(commitment: "confirmed"): Promise<number>;
  getSignatureStatus(signature: string): Promise<unknown>;
  getSignatureStatuses?(
    signatures: string[],
    config: { searchTransactionHistory: true },
  ): Promise<unknown>;
  onSignature(
    signature: string,
    callback: (result: { err: unknown }, context: unknown) => void,
    commitment: "confirmed",
  ): number;
  removeSignatureListener(subscriptionId: number): Promise<void>;
  _onSubscriptionStateChange?(subscriptionId: number, callback: (state: string) => void): () => void;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

class OwnedAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}

function abortOwned(controller: AbortController, message: string): void {
  if (!controller.signal.aborted) controller.abort(new OwnedAbortError(message));
}

function isOwnedAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error === signal.reason && isAbortError(error);
}

function fallbackConfirmationResult(response: unknown): { context: unknown; value: { err: unknown } } | null {
  if (!response || typeof response !== "object") return null;
  const { context, value } = response as { context?: unknown; value?: unknown };
  if (!value || typeof value !== "object" || !("err" in value)) return null;
  const status = value as { confirmationStatus?: unknown; err: unknown };
  // The keeper confirms at "confirmed". A processed-only status is not
  // terminal even when it carries an execution error: that fork can still be
  // abandoned, so clearing the pending signature could permit a replacement
  // while the original remains valid elsewhere.
  if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") return null;
  return { context, value: { err: status.err } };
}

function historicalConfirmationResult(response: unknown): {
  found: boolean;
  result: { context: unknown; value: { err: unknown } } | null;
} {
  if (!response || typeof response !== "object") return { found: false, result: null };
  const { context, value } = response as { context?: unknown; value?: unknown };
  if (!Array.isArray(value) || value.length !== 1) return { found: false, result: null };
  const status = value[0];
  if (!status || typeof status !== "object" || !("err" in status)) return { found: false, result: null };
  return {
    found: true,
    result: fallbackConfirmationResult({ context, value: status }),
  };
}

export function formatConfirmationFallbackError(error: unknown): string {
  return `[confirmation fallback] ${safeErrorMessage(error).slice(0, 140)}`;
}

/**
 * Own the same websocket subscription plus getSignatureStatus fallback shape
 * used by web3, but retain and settle the fallback before releasing the tick.
 * web3's internal fallback is detached from the promise it returns, so it
 * cannot safely share an operation abort signal with the keeper.
 */
export async function confirmConnectionTransaction(input: {
  clock?: Clock;
  connection: ConfirmationConnection;
  parentSignal: AbortSignal;
  pollIntervalMs?: number;
  rpcReadTimeoutMs?: number;
  runWithOperationSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  reportUnexpectedFallbackError?: (message: string) => void;
  strategy: ConfirmationStrategy;
  timeoutMs: number;
}): Promise<unknown> {
  const linked = linkedAbortController(input.parentSignal);
  const confirmation = linked.controller;
  const clock = input.clock ?? systemClock;
  const rpcReadTimeoutMs = Math.max(
    250,
    Math.min(input.rpcReadTimeoutMs ?? 4_000, input.timeoutMs),
  );
  const timeout = clock.setTimeout(() => abortOwned(confirmation, "keeper transaction confirmation timed out"), input.timeoutMs);
  try {
    return await input.runWithOperationSignal(confirmation.signal, async () => {
      const hardRead = <T>(work: () => Promise<T>) => runHardDeadlineOperation({
        clock,
        parentSignal: confirmation.signal,
        timeoutMs: rpcReadTimeoutMs,
        // The complete confirmation already owns the operation signal scope.
        // A nested scope can restore the outer signal only after the returned
        // confirmation has resolved. The hard deadline still releases this
        // await even if the RPC ignores the outer abort.
        work: async () => work(),
      });
      let subscriptionId: number | null = null;
      let subscriptionDelivered = false;
      let settled = false;
      let resolveOutcome!: (result: unknown) => void;
      let rejectOutcome!: (error: unknown) => void;
      const outcome = new Promise<unknown>((resolve, reject) => {
        resolveOutcome = resolve;
        rejectOutcome = reject;
      });
      const settle = (result: unknown, error?: unknown) => {
        if (settled) return;
        settled = true;
        confirmation.signal.removeEventListener("abort", onAbort);
        if (error !== undefined) rejectOutcome(error);
        else resolveOutcome(result);
      };
      const onAbort = () => settle(undefined, confirmation.signal.reason ?? new Error("confirmation aborted"));
      if (confirmation.signal.aborted) onAbort();
      else confirmation.signal.addEventListener("abort", onAbort, { once: true });
      let fallback: Promise<void> | null = null;
      try {
        try {
          subscriptionId = input.connection.onSignature(
            input.strategy.signature,
            (result, context) => {
              // web3.js 1.98.4 auto-removes signature subscriptions after this
              // callback returns; do not issue a second unsubscribe in cleanup.
              subscriptionDelivered = true;
              settle({ context, value: result });
            },
            "confirmed",
          );
        } catch (error) {
          // No caller can await `outcome` if subscription registration itself
          // fails, so leave it pending and propagate that original error.
          settled = true;
          confirmation.signal.removeEventListener("abort", onAbort);
          throw error;
        }
        // Poll throughout the bounded observation window. The previous
        // one-shot fallback could read null before the transaction landed and
        // then depend entirely on one websocket notification for the next
        // eight seconds. Missing that notification produced a false timeout.
        fallback = (async () => {
          let pollCount = 0;
          try {
            while (!settled && !confirmation.signal.aborted) {
              const response = await hardRead(
                () => input.connection.getSignatureStatus(input.strategy.signature),
              );
              const result = fallbackConfirmationResult(response);
              if (result) {
                settle(result);
                return;
              }

              pollCount += 1;
              const shouldCheckExpiry = pollCount === 1 || pollCount % 4 === 0;
              if (shouldCheckExpiry && input.connection.getBlockHeight) {
                const blockHeight = await hardRead(
                  () => input.connection.getBlockHeight!("confirmed"),
                );
                if (blockHeight > input.strategy.lastValidBlockHeight) {
                  if (!input.connection.getSignatureStatuses) {
                    settle(undefined, new KeeperFailure("expired", "keeper transaction expired without a confirmed result"));
                    return;
                  }
                  const historical = historicalConfirmationResult(await hardRead(
                    () => input.connection.getSignatureStatuses!(
                      [input.strategy.signature],
                      { searchTransactionHistory: true },
                    ),
                  ));
                  if (historical.result) {
                    settle(historical.result);
                    return;
                  }
                  if (!historical.found) {
                    settle(undefined, new KeeperFailure("expired", "keeper transaction expired without landing"));
                    return;
                  }
                  // A processed status proves the transaction landed before
                  // expiry but has not reached confirmed commitment. Keep the
                  // same signature pending; never sign a replacement.
                }
              }
              await abortableSleep(input.pollIntervalMs ?? 400, confirmation.signal, clock);
            }
          } catch (error) {
            const ownedCancellation = isOwnedAbort(error, confirmation.signal)
              || (confirmation.signal.aborted
                && error instanceof KeeperFailure
                && error.kind === "cancelled");
            if (ownedCancellation) return;
            if (settled) {
              (input.reportUnexpectedFallbackError ?? console.error)(formatConfirmationFallbackError(error));
            } else {
              settle(undefined, error);
            }
          }
        })();
        const result = await outcome;
        return result;
      } finally {
        // Abort while the RPC operation scope is still active, then await the
        // actual fallback promise. This leaves neither a detached rejection nor
        // live HTTP work after a successful subscription confirmation.
        abortOwned(confirmation, "keeper transaction confirmation completed");
        if (subscriptionId !== null && !subscriptionDelivered) {
          try {
            const cleanupParent = new AbortController();
            await runHardDeadlineOperation({
              clock,
              parentSignal: cleanupParent.signal,
              timeoutMs: 1_000,
              // Unsubscribe cannot mutate chain state, so it is safe to
              // abandon after the hard deadline consumes a late rejection.
              work: async () => input.connection.removeSignatureListener(subscriptionId!),
            });
          } catch (error) {
            (input.reportUnexpectedFallbackError ?? console.error)(formatConfirmationFallbackError(error));
          }
        }
        await fallback;
      }
    });
  } catch (error) {
    const normalized = confirmationResultFromError(error);
    if (normalized) return normalized;
    if (isOwnedAbort(error, confirmation.signal)) {
      throw new KeeperFailure(
        input.parentSignal.aborted ? "cancelled" : "pending",
        input.parentSignal.aborted
          ? "keeper transaction confirmation cancelled"
          : "keeper transaction remains pending after the observation window",
      );
    }
    throw error;
  } finally {
    // Timeout/shutdown can enter before the owned fallback has started.
    abortOwned(confirmation, "keeper transaction confirmation completed");
    clock.clearTimeout(timeout);
    linked.dispose();
  }
}

export interface PendingSignedBroadcast<TContext> {
  context: TContext;
  rawTransaction: Uint8Array;
  strategy: ConfirmationStrategy;
}

/**
 * Retain one signed transaction until the cluster gives a terminal answer.
 * A retry may rebroadcast the exact same bytes (and therefore the same
 * signature), but `record` fails closed while any earlier transaction is
 * unresolved. This prevents a short observation failure from becoming a
 * second, independently signed state transition.
 */
export class PendingBroadcastGate<TContext> {
  private pending: PendingSignedBroadcast<TContext> | null = null;

  hasPending(): boolean {
    return this.pending !== null;
  }

  snapshot(): Omit<PendingSignedBroadcast<TContext>, "rawTransaction"> | null {
    return this.pending
      ? { context: this.pending.context, strategy: { ...this.pending.strategy } }
      : null;
  }

  record(input: PendingSignedBroadcast<TContext>): void {
    if (this.pending) {
      throw new KeeperFailure("pending", "an earlier keeper transaction still requires reconciliation");
    }
    this.pending = {
      context: input.context,
      rawTransaction: Uint8Array.from(input.rawTransaction),
      strategy: { ...input.strategy },
    };
  }

  async reconcile(input: {
    confirm(strategy: ConfirmationStrategy): Promise<unknown>;
    rebroadcast?(rawTransaction: Uint8Array): Promise<string>;
    reportRebroadcastError?(message: string): void;
    signal?: AbortSignal;
  }): Promise<{ context: TContext; result: unknown; strategy: ConfirmationStrategy } | null> {
    const pending = this.pending;
    if (!pending) return null;

    if (input.rebroadcast) {
      let signature: string | null = null;
      try {
        signature = await input.rebroadcast(Uint8Array.from(pending.rawTransaction));
      } catch (error) {
        const failure = classifyKeeperError(error, input.signal);
        if (failure.kind === "cancelled") throw failure;
        (input.reportRebroadcastError ?? console.error)(
          `[keeper rebroadcast] ${safeErrorMessage(failure).slice(0, 140)}`,
        );
        // Submission acknowledgement is not authoritative. Continue checking
        // the locally derived signature because the original or this retry may
        // already have reached the cluster.
      }
      if (signature !== null && signature !== pending.strategy.signature) {
        throw new KeeperFailure("pending", "identical keeper rebroadcast returned a different signature");
      }
    }

    try {
      const result = await input.confirm(pending.strategy);
      this.pending = null;
      return { context: pending.context, result, strategy: { ...pending.strategy } };
    } catch (error) {
      const failure = classifyKeeperError(error, input.signal);
      // Only block-height expiry plus a final history miss proves that these
      // signed bytes can no longer change authoritative state.
      if (failure.kind === "expired") this.pending = null;
      throw failure;
    }
  }
}

/** Keep an abort controller alive through the complete operation, including
 * body decoding and validation after response headers arrive. */
export async function runDeadlineBoundOperation<T>(input: {
  clock?: Pick<Clock, "clearTimeout" | "setTimeout">;
  parentSignal: AbortSignal;
  timeoutMs: number;
  work(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  const linked = linkedAbortController(input.parentSignal);
  const operation = linked.controller;
  const clock = input.clock ?? systemClock;
  const timeout = clock.setTimeout(() => operation.abort(), input.timeoutMs);
  try {
    return await input.work(operation.signal);
  } catch (error) {
    if (operation.signal.aborted) {
      throw new KeeperFailure(
        input.parentSignal.aborted ? "cancelled" : "timeout",
        input.parentSignal.aborted ? "keeper operation cancelled" : "keeper operation timed out",
      );
    }
    throw error;
  } finally {
    operation.abort();
    clock.clearTimeout(timeout);
    linked.dispose();
  }
}

/**
 * Enforce a wall-clock deadline even when an RPC implementation ignores its
 * AbortSignal. The caller must use this only where a late settlement cannot
 * authorize a replacement state transition: read-only RPC work, cleanup, or
 * a submission acknowledgement after the exact signed bytes have already
 * been retained by PendingBroadcastGate.
 *
 * Promise.race attaches handlers to the abandoned work, so a late rejection
 * is consumed. Aborting still gives a cooperative transport the opportunity
 * to release sockets promptly, but the returned promise never depends on it.
 */
export async function runHardDeadlineOperation<T>(input: {
  phase?: KeeperOperationPhase;
  clock?: Pick<Clock, "clearTimeout" | "setTimeout">;
  parentSignal: AbortSignal;
  timeoutMs: number;
  work(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  const startedAt = Date.now();
  const linked = linkedAbortController(input.parentSignal);
  const operation = linked.controller;
  const clock = input.clock ?? systemClock;
  let deadlineExpired = false;
  let removeAbortListener = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new KeeperFailure(
      input.parentSignal.aborted ? "cancelled" : "timeout",
      input.parentSignal.aborted ? "keeper operation cancelled" : "keeper operation timed out",
    ));
    removeAbortListener = () => operation.signal.removeEventListener("abort", onAbort);
    if (operation.signal.aborted) onAbort();
    else operation.signal.addEventListener("abort", onAbort, { once: true });
  });
  const timeout = clock.setTimeout(() => {
    deadlineExpired = true;
    operation.abort();
  }, input.timeoutMs);
  const work = Promise.resolve().then(() => {
    if (operation.signal.aborted) {
      throw new KeeperFailure(
        input.parentSignal.aborted ? "cancelled" : "timeout",
        input.parentSignal.aborted ? "keeper operation cancelled" : "keeper operation timed out",
      );
    }
    return input.work(operation.signal);
  });
  try {
    return await Promise.race([work, stopped]);
  } catch (error) {
    let failure = error;
    if (operation.signal.aborted) {
      failure = new KeeperFailure(
        input.parentSignal.aborted ? "cancelled" : "timeout",
        input.parentSignal.aborted
          ? "keeper operation cancelled"
          : deadlineExpired ? "keeper operation timed out" : "keeper operation cancelled",
      );
      if (failure instanceof KeeperFailure && error instanceof KeeperFailure && error.phase) {
        failure.phase = error.phase;
        failure.elapsedMs = error.elapsedMs;
      }
    }
    // Preserve innermost attribution without changing cancellation precedence.
    // No provider URL, request body, signer, or response is attached.
    if (failure instanceof KeeperFailure && input.phase && !failure.phase) {
      failure.phase = input.phase;
      failure.elapsedMs = Math.max(0, Date.now() - startedAt);
    }
    throw failure;
  } finally {
    clock.clearTimeout(timeout);
    removeAbortListener();
    operation.abort();
    linked.dispose();
  }
}

/** Keep a supervisor-visible exit alive while an asynchronous drain is stuck.
 * Promises alone do not keep Node's event loop alive, so a watchdog needs this
 * timer to preserve its intended nonzero exit code. */
export function scheduleForcedExit(input: {
  clock?: Pick<Clock, "clearTimeout" | "setTimeout">;
  delayMs: number;
  code: number;
  exit(code: number): void;
}): () => void {
  const clock = input.clock ?? systemClock;
  const handle = clock.setTimeout(() => input.exit(input.code), input.delayMs);
  return () => clock.clearTimeout(handle);
}

export interface CircuitState {
  failures: number;
  openUntilMs: number;
}

export class RpcCircuitBreaker {
  private state: CircuitState = { failures: 0, openUntilMs: 0 };

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly rateLimitBaseMs = 30_000,
    private readonly transportBaseMs = 5_000,
    private readonly maxBackoffMs = 15 * 60_000,
  ) {}

  isOpen(): boolean {
    return this.clock.now() < this.state.openUntilMs;
  }

  snapshot(): CircuitState {
    return { ...this.state };
  }

  recordFailure(failure: KeeperFailure): number | null {
    if (failure.kind !== "expired"
      && failure.kind !== "provider_denied"
      && failure.kind !== "rate_limit"
      && failure.kind !== "transport"
      && failure.kind !== "timeout") return null;
    this.state.failures += 1;
    // A deterministic provider denial needs bounded probing, not a watchdog
    // restart storm while an operator repairs the credential or entitlement.
    const base = failure.kind === "rate_limit" || failure.kind === "provider_denied"
      ? this.rateLimitBaseMs
      : this.transportBaseMs;
    const exponential = Math.min(base * 2 ** Math.min(this.state.failures - 1, 5), this.maxBackoffMs);
    // Jitter only the locally chosen exponential component. Retry-After is
    // honored up to maxBackoffMs; beyond that we deliberately probe at the
    // documented maximum instead of leaving the singleton asleep indefinitely.
    const jitteredExponential = Math.min(
      this.maxBackoffMs,
      Math.max(base, Math.round(exponential * (0.8 + this.clock.random() * 0.4))),
    );
    const retryAfter = Math.min(failure.retryAfterMs ?? 0, this.maxBackoffMs);
    const delay = Math.min(this.maxBackoffMs, Math.max(jitteredExponential, retryAfter));
    this.state.openUntilMs = this.clock.now() + delay;
    return delay;
  }

  recordConfirmedSuccess(): void {
    this.state = { failures: 0, openUntilMs: 0 };
  }
}

export class SingleTickRunner {
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly budgetMs = 20_000,
    private readonly onDeadline: () => void = () => {},
  ) {}

  isActive(): boolean {
    return this.active !== null;
  }

  abortActive(): void {
    this.controller?.abort();
  }

  async drain(): Promise<void> {
    await this.active?.catch(() => undefined);
  }

  async run(work: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    if (this.active) return false;
    const controller = new AbortController();
    this.controller = controller;
    const deadline = this.clock.setTimeout(() => {
      controller.abort();
      this.onDeadline();
    }, this.budgetMs);
    let resolveActive!: () => void;
    let rejectActive!: (error: unknown) => void;
    const active = new Promise<void>((resolve, reject) => {
      resolveActive = resolve;
      rejectActive = reject;
    });
    this.active = active;
    // Set active before calling work: synchronous/re-entrant work must see the
    // guard and cannot begin a nested tick.
    void (async () => {
      try {
        await work(controller.signal);
        resolveActive();
      } catch (error) {
        rejectActive(error);
      } finally {
        this.clock.clearTimeout(deadline);
      }
    })();
    try {
      await active;
    } finally {
      if (this.active === active) {
        this.active = null;
        this.controller = null;
      }
    }
    return true;
  }
}

export function requireKeeperConfiguration(env: {
  RPC_URL?: string;
  KEEPER_SECRET_KEY?: string;
}): { rpcUrl: string; encodedSecretKey: string } {
  const rpcUrl = env.RPC_URL?.trim();
  const encodedSecretKey = env.KEEPER_SECRET_KEY?.trim();
  if (!rpcUrl) throw new KeeperFailure("unknown", "keeper requires explicit RPC_URL");
  if (!encodedSecretKey) throw new KeeperFailure("unknown", "keeper requires explicit KEEPER_SECRET_KEY");
  return { rpcUrl, encodedSecretKey };
}

export function parseKeeperSecretKey(encodedSecretKey: string): Uint8Array {
  try {
    const json = encodedSecretKey.startsWith("[")
      ? encodedSecretKey
      : Buffer.from(encodedSecretKey, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== 64
      || parsed.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255)) {
      throw new Error("invalid key material");
    }
    return Uint8Array.from(parsed);
  } catch {
    throw new KeeperFailure("unknown", "invalid KEEPER_SECRET_KEY");
  }
}

/** Nestable scope used by Connection.fetchMiddleware. Confirmation timeouts
 * temporarily replace the tick signal, aborting all of that confirmation's
 * HTTP polls as well as its websocket/subscription work. */
export class RpcOperationSignalScope {
  private signal: AbortSignal | null = null;

  currentSignal(): AbortSignal | null {
    return this.signal;
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const previous = this.signal;
    this.signal = signal;
    try {
      return await work();
    } finally {
      this.signal = previous;
    }
  }
}

/** A successful tick needs every configured market feed. Partial Hermes
 * responses must fail the tick rather than refreshing only a subset forever. */
export function requireConfiguredHermesFeeds<T extends { id: string }>(
  configuredFeedIds: readonly string[],
  parsed: readonly T[],
): Map<string, T> {
  const byId = new Map(parsed.map((item) => [item.id, item]));
  if (configuredFeedIds.some((id) => !byId.has(id))) {
    throw new KeeperFailure("transport", "Pyth response missing configured feed");
  }
  return byId;
}

export interface HermesFeedDescriptor {
  feedId: string;
  index: number;
}

export interface HermesFeedDenialSnapshot {
  failures: number;
  feedId: string;
  index: number;
  openUntilMs: number;
}

/** Bounded, non-secret cache for deterministic per-feed entitlement failures. */
export class HermesFeedEntitlementQuarantine {
  private readonly states = new Map<string, HermesFeedDenialSnapshot>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly baseBackoffMs = 60_000,
    private readonly maxBackoffMs = 15 * 60_000,
  ) {}

  eligible<T extends HermesFeedDescriptor>(feeds: readonly T[]): T[] {
    return feeds.filter((feed) => {
      const state = this.states.get(feed.feedId);
      return state === undefined || this.now() >= state.openUntilMs;
    });
  }

  recordDenied(feed: HermesFeedDescriptor): HermesFeedDenialSnapshot {
    const previous = this.states.get(feed.feedId);
    const failures = (previous?.failures ?? 0) + 1;
    const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.min(failures - 1, 8));
    const next = { failures, feedId: feed.feedId, index: feed.index, openUntilMs: this.now() + delay };
    this.states.set(feed.feedId, next);
    return { ...next };
  }

  recordSuccess(feed: HermesFeedDescriptor): void {
    this.states.delete(feed.feedId);
  }

  snapshot(): HermesFeedDenialSnapshot[] {
    return [...this.states.values()]
      .map((state) => ({ ...state }))
      .sort((left, right) => left.index - right.index);
  }
}

export type HermesBatchFetchResult<T extends { id: string }> =
  | { kind: "denied" }
  | { items: readonly T[]; kind: "ok" };

/** Keep one normal batch; only an entitlement denial triggers bounded probes. */
export async function fetchAvailableHermesFeeds<
  TFeed extends HermesFeedDescriptor,
  TItem extends { id: string },
>(input: {
  feeds: readonly TFeed[];
  fetchBatch(feeds: readonly TFeed[]): Promise<HermesBatchFetchResult<TItem>>;
  quarantine: HermesFeedEntitlementQuarantine;
}): Promise<{ feeds: Map<string, TItem>; unavailableIndexes: number[] }> {
  const eligible = input.quarantine.eligible(input.feeds);
  const alreadyDenied = input.quarantine.snapshot()
    .filter((state) => !eligible.some((feed) => feed.feedId === state.feedId))
    .map((state) => state.index);
  if (eligible.length === 0) {
    throw new KeeperFailure("provider_denied", "Pyth denied every configured feed");
  }

  const batch = await input.fetchBatch(eligible);
  if (batch.kind === "ok") {
    const feeds = requireConfiguredHermesFeeds(eligible.map((feed) => feed.feedId), batch.items);
    for (const feed of eligible) input.quarantine.recordSuccess(feed);
    return { feeds, unavailableIndexes: alreadyDenied };
  }

  const probes = await Promise.allSettled(eligible.map(async (feed) => ({
    feed,
    result: await input.fetchBatch([feed]),
  })));
  const available = new Map<string, TItem>();
  const unavailableIndexes = [...alreadyDenied];
  let firstTransientFailure: unknown;
  for (const probe of probes) {
    if (probe.status === "rejected") {
      firstTransientFailure ??= probe.reason;
      continue;
    }
    const { feed, result } = probe.value;
    if (result.kind === "denied") {
      input.quarantine.recordDenied(feed);
      unavailableIndexes.push(feed.index);
      continue;
    }
    try {
      const parsed = requireConfiguredHermesFeeds([feed.feedId], result.items);
      available.set(feed.feedId, parsed.get(feed.feedId)!);
      input.quarantine.recordSuccess(feed);
    } catch (error) {
      firstTransientFailure ??= error;
    }
  }
  if (available.size === 0) {
    if (firstTransientFailure) throw firstTransientFailure;
    throw new KeeperFailure("provider_denied", "Pyth denied every configured feed");
  }
  return {
    feeds: available,
    unavailableIndexes: [...new Set(unavailableIndexes)].sort((left, right) => left - right),
  };
}

const V16_MAGIC = 0x5045_5243_5631_3600n;
const V16_HEADER_LEN = 16;
const V16_PORTFOLIO_KIND = 2;
const V16_VERSION = 16;
const V16_PROVENANCE_OFF = V16_HEADER_LEN;
const V16_ACTIVE_BITMAP_OFF = V16_HEADER_LEN + 332;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Validate the exact seeded account the keeper will use for catch-up. It must
 * be program-owned, initialized as this market's portfolio, and have no legs. */
export function isUsableLeglessCrankBuffer(input: {
  data: Uint8Array;
  expectedLength: number;
  expectedMarket: Uint8Array;
  expectedPortfolio: Uint8Array;
  programOwnerMatches: boolean;
}): boolean {
  const { data } = input;
  if (!input.programOwnerMatches || data.length !== input.expectedLength || data.length < V16_ACTIVE_BITMAP_OFF + 8) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getBigUint64(0, true) !== V16_MAGIC
    || view.getUint16(8, true) !== V16_VERSION
    || view.getUint8(10) !== V16_PORTFOLIO_KIND
    || !equalBytes(data.subarray(V16_PROVENANCE_OFF, V16_PROVENANCE_OFF + 32), input.expectedMarket)
    || !equalBytes(data.subarray(V16_PROVENANCE_OFF + 32, V16_PROVENANCE_OFF + 64), input.expectedPortfolio)) return false;
  return view.getBigUint64(V16_ACTIVE_BITMAP_OFF, true) === 0n;
}

/**
 * `createWithSeed` accepts at most 32 UTF-8 bytes. Hashing the complete market
 * public-key bytes into this versioned seed makes a recovery buffer exclusive
 * to one market without relying on a short base58 prefix. The domain separator
 * prevents an accidental future reuse of this digest as another seed kind.
 */
export function crankBufferSeedForMarket(market: Uint8Array): string {
  if (market.length !== 32) throw new KeeperFailure("unknown", "invalid market identity for crank buffer");
  const digest = createHash("sha256")
    .update("percolator/crank-buffer/v2", "utf8")
    .update(market)
    .digest("base64url");
  // 7-byte prefix + 25 base64url characters = 32 bytes (150 bits of digest).
  return `ncb-v2-${digest.slice(0, 25)}`;
}

/** Creation can race with a prior transaction or return an on-chain rejection
 * after the account becomes usable. Always re-read; never report boot-ready
 * unless the exact seeded legless buffer validates. */
export async function ensureUsableCrankBuffer<T>(input: {
  create(): Promise<void>;
  read(): Promise<T | null>;
  isUsable(account: T | null): boolean;
}): Promise<void> {
  const existing = await input.read();
  if (input.isUsable(existing)) return;
  if (existing) throw new KeeperFailure("onchain", "existing crank buffer is not a usable legless portfolio");
  let createFailure: unknown;
  try {
    await input.create();
  } catch (error) {
    createFailure = error;
  }
  const reread = await input.read();
  if (input.isUsable(reread)) return;
  throw createFailure instanceof Error
    ? createFailure
    : new KeeperFailure("onchain", "crank buffer was not created as a usable legless portfolio");
}

/** Run only the caller's explicit recovery budget. Returning false stops this
 * tick; another ordinary oracle tick can continue without overlapping the
 * still-active runner or starving fresh pushes. */
export async function runBoundedSelfHeal(input: {
  batchesPerTick: number;
  cranksPerBatch: number;
  signal: AbortSignal;
  runBatch(cranksPerBatch: number, signal: AbortSignal): Promise<boolean>;
}): Promise<number> {
  let completed = 0;
  for (let batch = 0; batch < input.batchesPerTick; batch += 1) {
    if (input.signal.aborted) throw new KeeperFailure("cancelled", "self-heal cancelled");
    if (!await input.runBatch(input.cranksPerBatch, input.signal)) break;
    completed += 1;
  }
  return completed;
}

export interface CatchupCadenceModel {
  catchupTransactionsPerTick: number;
  cadenceMs: number;
  cranksPerTransaction: number;
  healConfirmationMs: number;
  initialLagSlots: number;
  lpConfirmationMs: number;
  pushConfirmationMs: number;
  simulationMs: number;
  slotDurationMs: number;
  slotsPerCrank: number;
  tickBudgetMs: number;
}

/** Deterministic timing model for the deployed 5s cadence. It deliberately
 * models push, LP crank, and all four self-heal confirmations so tests prove
 * no cadence callback can create an orphan/overlap before the 20s budget. */
export function modelCatchupCadence(input: CatchupCadenceModel): {
  completedTicks: number;
  completedHealTransactions: number;
  finalLagSlots: number;
  maxConcurrentTicks: number;
  orphanedConfirmations: number;
  partialDeadlineCancellations: number;
  skippedCadenceCallbacks: number;
} {
  let active: { endsAtMs: number; healTransactions: number; partialDeadlineCancellation: boolean } | null = null;
  let completedTicks = 0;
  let completedHealTransactions = 0;
  let finalLagSlots = input.initialLagSlots;
  let lastWallTimeMs = 0;
  let maxConcurrentTicks = 0;
  let orphanedConfirmations = 0;
  let partialDeadlineCancellations = 0;
  let skippedCadenceCallbacks = 0;

  const accrueTo = (timeMs: number) => {
    finalLagSlots += (timeMs - lastWallTimeMs) / input.slotDurationMs;
    lastWallTimeMs = timeMs;
  };
  const finishActive = () => {
    if (!active) return;
    accrueTo(active.endsAtMs);
    completedTicks += 1;
    completedHealTransactions += active.healTransactions;
    finalLagSlots = Math.max(
      0,
      finalLagSlots - active.healTransactions * input.cranksPerTransaction * input.slotsPerCrank,
    );
    if (active.partialDeadlineCancellation) partialDeadlineCancellations += 1;
    active = null;
  };

  for (let due = 0; due <= input.simulationMs; due += input.cadenceMs) {
    if (active && due >= active.endsAtMs) finishActive();
    accrueTo(due);
    if (active) {
      skippedCadenceCallbacks += 1;
      continue;
    }
    const fixedDuration = input.pushConfirmationMs + input.lpConfirmationMs;
    if (fixedDuration >= input.tickBudgetMs) throw new KeeperFailure("timeout", "catch-up model exceeds tick budget");
    const availableForHealing = input.tickBudgetMs - fixedDuration;
    const healTransactions = Math.min(
      input.catchupTransactionsPerTick,
      Math.floor(availableForHealing / input.healConfirmationMs),
    );
    const partialDeadlineCancellation = healTransactions < input.catchupTransactionsPerTick
      && availableForHealing - healTransactions * input.healConfirmationMs > 0;
    const endsAtMs = due + (partialDeadlineCancellation
      ? input.tickBudgetMs
      : fixedDuration + healTransactions * input.healConfirmationMs);
    if (endsAtMs > due + input.tickBudgetMs) orphanedConfirmations += 1;
    active = { endsAtMs, healTransactions, partialDeadlineCancellation };
    maxConcurrentTicks = Math.max(maxConcurrentTicks, 1);
  }
  if (active && active.endsAtMs <= input.simulationMs) finishActive();
  else accrueTo(input.simulationMs);
  return {
    completedTicks,
    completedHealTransactions,
    finalLagSlots,
    maxConcurrentTicks,
    orphanedConfirmations,
    partialDeadlineCancellations,
    skippedCadenceCallbacks,
  };
}

export interface IntervalScheduler {
  clearInterval(handle: ReturnType<typeof setInterval>): void;
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
}

/** Owns every recurring timer and makes shutdown terminal: no timer can revive
 * work after a signal, and the exit callback runs only after runners drain. */
export class KeeperLifecycle {
  private readonly intervals = new Set<ReturnType<typeof setInterval>>();
  private terminal = false;
  private termination: Promise<void> | null = null;

  constructor(
    private readonly scheduler: IntervalScheduler,
    private readonly exit: (code: number) => void,
    private readonly reportDrainFailure: (error: unknown) => void = () => {},
  ) {}

  isTerminal(): boolean {
    return this.terminal;
  }

  every(callback: () => void, delayMs: number): void {
    if (this.terminal) return;
    const handle = this.scheduler.setInterval(() => {
      if (!this.terminal) callback();
    }, delayMs);
    this.intervals.add(handle);
  }

  terminate(drain: () => Promise<void>, code = 0): Promise<void> {
    if (this.termination) return this.termination;
    this.terminal = true;
    for (const handle of this.intervals) this.scheduler.clearInterval(handle);
    this.intervals.clear();
    this.termination = (async () => {
      try {
        await drain();
      } catch (error) {
        // A cancellation-aware drain can reject while unwinding in-flight RPC
        // work. The terminal exit code must still reach the supervisor.
        this.reportDrainFailure(error);
      } finally {
        this.exit(code);
      }
    })();
    return this.termination;
  }
}

const V16_MARKET_KIND = 1;
const V16_WRAPPER_CONFIG_LEN = 448;
const V16_MARKET_GROUP_OFFSET = V16_HEADER_LEN + V16_WRAPPER_CONFIG_LEN;
const V16_MARKET_GROUP_HEADER_LEN = 726;
const V16_MARKET_MIN_LEN = V16_MARKET_GROUP_OFFSET + V16_MARKET_GROUP_HEADER_LEN;
const V16_ASSET_SLOT_LEN = 1797;
const V16_ENGINE_ASSET_OFFSET = 512;
const V16_MARKET_ID_OFFSET = V16_MARKET_GROUP_OFFSET;
const V16_ASSET_CAPACITY_OFFSET = V16_MARKET_GROUP_OFFSET + 281;
const V16_MARKET_CURRENT_SLOT_OFFSET = V16_MARKET_GROUP_OFFSET + 581;
const V16_ASSET_LIFECYCLE_OFFSET = 16;
const V16_ASSET_SLOT_LAST_OFFSET = 41;
const V16_LIFECYCLE_ACTIVE = 2;
const V16_LIFECYCLE_DRAIN_ONLY = 3;
const V16_MAX_LIFECYCLE = 5;

/** Layout-stable v16 market loss-stale flag. */
export const V16_LOSS_STALE_ACTIVE_OFFSET = V16_MARKET_GROUP_OFFSET + 591;

export interface V16RecoveryStatus {
  laggingAssetIndexes: number[];
  lossStaleActive: boolean;
  marketCurrentSlot: bigint;
  maxActiveAssetClockLag: bigint;
  needsCatchUp: boolean;
}

/**
 * A legless self-heal can only advance assets included in the current oracle
 * set. Do not burn transactions cranking healthy assets when every lagging
 * clock belongs to a deliberately unavailable market.
 */
export function availableRecoveryNeedsCatchUp(
  status: V16RecoveryStatus,
  availableAssetIndexes: readonly number[],
): boolean {
  const available = new Set(availableAssetIndexes);
  if (status.laggingAssetIndexes.some((index) => available.has(index))) return true;
  // A lock without an identified lagging clock still warrants one bounded
  // available-set heal attempt. A lock attributable only to unavailable
  // clocks cannot be progressed by unrelated writes.
  return status.lossStaleActive && status.laggingAssetIndexes.length === 0;
}

export function parseRecoveryClockLagSlots(value: string | undefined, fallback = 300n): bigint {
  const normalized = value?.trim() || fallback.toString();
  if (!/^\d+$/.test(normalized)) {
    throw new KeeperFailure("unknown", "MARKET_MAX_CLOCK_LAG_SLOTS must be a non-negative integer");
  }
  return BigInt(normalized);
}

/**
 * A healthy sample suppresses recovery writes, not future bounded status
 * reads. Passive asset clocks can cross the configured limit without first
 * producing the Custom-21 signal that previously reopened the probe.
 */
export function marketRecoveryStatusProbeDue(nowMs: number, nextCheckMs: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(nextCheckMs) || nowMs < 0 || nextCheckMs < 0) {
    throw new Error("market recovery probe timestamps must be finite and non-negative");
  }
  return nowMs >= nextCheckMs;
}

/**
 * Parse only the state needed to gate bounded recovery. All dynamic-layout and
 * identity checks happen before a lifecycle or slot value can cause a write.
 */
export function readV16RecoveryStatus(
  marketData: Uint8Array,
  expectedMarket: Uint8Array,
  maxClockLagSlots: bigint,
): V16RecoveryStatus {
  if (maxClockLagSlots < 0n) {
    throw new KeeperFailure("unknown", "market recovery clock-lag limit cannot be negative");
  }
  if (expectedMarket.length !== 32) {
    throw new KeeperFailure("unknown", "configured v16 market identity is invalid");
  }
  if (marketData.length < V16_MARKET_MIN_LEN) {
    throw new KeeperFailure("onchain", "v16 market recovery layout is unavailable");
  }
  const view = new DataView(marketData.buffer, marketData.byteOffset, marketData.byteLength);
  if (view.getBigUint64(0, true) !== V16_MAGIC
    || view.getUint16(8, true) !== V16_VERSION
    || view.getUint8(10) !== V16_MARKET_KIND) {
    throw new KeeperFailure("onchain", "market account is not the expected v16 market kind");
  }
  if (!equalBytes(
    marketData.subarray(V16_MARKET_ID_OFFSET, V16_MARKET_ID_OFFSET + 32),
    expectedMarket,
  )) {
    throw new KeeperFailure("onchain", "market account identity does not match the configured market");
  }

  const assetCapacity = view.getUint32(V16_ASSET_CAPACITY_OFFSET, true);
  const expectedLength = V16_MARKET_MIN_LEN + assetCapacity * V16_ASSET_SLOT_LEN;
  if (marketData.length !== expectedLength) {
    throw new KeeperFailure("onchain", "market account length does not match its v16 asset-slot capacity");
  }

  const lossStaleValue = view.getUint8(V16_LOSS_STALE_ACTIVE_OFFSET);
  if (lossStaleValue !== 0 && lossStaleValue !== 1) {
    throw new KeeperFailure("onchain", "v16 market loss-stale flag is invalid");
  }
  const lossStaleActive = lossStaleValue === 1;
  const marketCurrentSlot = view.getBigUint64(V16_MARKET_CURRENT_SLOT_OFFSET, true);
  const laggingAssetIndexes: number[] = [];
  let maxActiveAssetClockLag = 0n;

  for (let asset = 0; asset < assetCapacity; asset += 1) {
    const engineAssetOffset = V16_MARKET_MIN_LEN
      + asset * V16_ASSET_SLOT_LEN
      + V16_ENGINE_ASSET_OFFSET;
    const lifecycle = view.getUint8(engineAssetOffset + V16_ASSET_LIFECYCLE_OFFSET);
    if (lifecycle > V16_MAX_LIFECYCLE) {
      throw new KeeperFailure("onchain", `v16 asset ${asset} lifecycle is invalid`);
    }
    if (lifecycle !== V16_LIFECYCLE_ACTIVE && lifecycle !== V16_LIFECYCLE_DRAIN_ONLY) continue;
    const slotLast = view.getBigUint64(engineAssetOffset + V16_ASSET_SLOT_LAST_OFFSET, true);
    if (slotLast > marketCurrentSlot) {
      throw new KeeperFailure("onchain", `v16 asset ${asset} clock exceeds the market clock`);
    }
    const lag = marketCurrentSlot - slotLast;
    if (lag > maxActiveAssetClockLag) maxActiveAssetClockLag = lag;
    if (lag > maxClockLagSlots) laggingAssetIndexes.push(asset);
  }

  return {
    laggingAssetIndexes,
    lossStaleActive,
    marketCurrentSlot,
    maxActiveAssetClockLag,
    needsCatchUp: lossStaleActive || laggingAssetIndexes.length > 0,
  };
}

export function readV16LossStaleActive(marketData: Uint8Array): boolean {
  if (marketData.length <= V16_LOSS_STALE_ACTIVE_OFFSET) {
    throw new KeeperFailure("onchain", "v16 market status layout is unavailable");
  }
  const value = marketData[V16_LOSS_STALE_ACTIVE_OFFSET];
  if (value === 0) return false;
  if (value === 1) return true;
  throw new KeeperFailure("onchain", "v16 market loss-stale flag is invalid");
}

export class PushWatchdog {
  private lastConfirmedPushMs: number | null = null;

  constructor(private readonly startedMs: number) {}

  recordConfirmedPush(nowMs: number, confirmed: boolean): void {
    if (confirmed) this.lastConfirmedPushMs = nowMs;
  }

  lastSuccessMs(): number | null {
    return this.lastConfirmedPushMs;
  }

  shouldRestart(nowMs: number, watchdogMs: number): boolean {
    return nowMs - (this.lastConfirmedPushMs ?? this.startedMs) > watchdogMs;
  }
}
