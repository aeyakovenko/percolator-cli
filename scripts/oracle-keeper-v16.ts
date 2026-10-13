/**
 * Oracle Keeper (v16) — keeps the v16 market's marks tracking live Pyth.
 *
 * v16 oracle = AuthMark: PushAuthMark sets a target mark, and a
 * PermissionlessCrank walks the stored *effective* price toward it (bounded
 * per slot) and settles a portfolio.
 *
 * v2 (2026-07-16) — hardened after the 11h silent hang that loss-stale-locked
 * the whole market (see KANBAN "loss-stale incident"):
 *  - PUSHES and CRANK are SEPARATE txs. The old bundled tx meant a failing
 *    crank also blocked every price push, so the market could never catch up.
 *  - SELF-HEAL: if the LP crank fails with Custom 21 (loss-stale deadlock —
 *    an asset's clock can't advance+settle in one call once it lags too far),
 *    run batched cranks against a LEGLESS buffer portfolio: with nothing to
 *    settle, the bounded clock advance sticks (~180 slots/tx), until the LP
 *    crank works again. The bounded path remains active until loss-stale is
 *    clear and every active/drain-only asset clock is within the configured
 *    audit bound; clearing the lock alone cannot strand residual clock lag.
 *  - WATCHDOG: every tick is hard-timeboxed; if no successful push lands for
 *    150s the process exits(1) and Fly restarts the machine. The v1 hang was
 *    an un-timeboxed await keeping the `isPushing` guard latched forever.
 *
 * Current scheduling: push -> freshly planned bounded legless maintenance ->
 * LP settlement. No 30s cached healthy decision or second recovery batch.
 *
 * Required environment: RPC_URL, KEEPER_SECRET_KEY, PROGRAM_ID, MARKET,
 * LP_PORTFOLIO, KEEPER_MODE, and KEEPER_ASSETS_JSON.
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import {
  abortableSleep,
  classifyKeeperError,
  confirmConnectionTransaction,
  confirmedTransactionError,
  crankBufferSeedForMarket,
  ensureUsableCrankBuffer,
  fetchAvailableHermesFeeds,
  formatUnhandledRejection,
  HermesFeedEntitlementQuarantine,
  isUsableLeglessCrankBuffer,
  KeeperLifecycle,
  KeeperFailure,
  isCustomProgramError,
  parseRecoveryClockLagSlots,
  parseKeeperSecretKey,
  PendingBroadcastGate,
  PushWatchdog,
  RpcCircuitBreaker,
  RpcOperationSignalScope,
  requireKeeperConfiguration,
  runDeadlineBoundOperation,
  runHardDeadlineOperation,
  safeErrorMessage,
  scheduleForcedExit,
  SingleTickRunner,
  systemClock,
  retryAfterMs,
  type ConfirmationStrategy,
} from "./keeper-runtime.ts";
import { maintainBeforeLp, decodeMaintenanceResponse, KeeperMaintenanceContinuation,
  resumeBeforeFreshPush, admitFreshPush, maintenanceBatchLayout, type KeeperSendContext, type MaintenanceContinuation,
  type ClockMaintenancePlan } from "./keeper-maintenance.ts";
import {
  AssetQuarantine,
  BoundedShadowDecisionLog,
  classifyPlannedInstructionSimulationFailure,
  executeKeeperPlan,
  FileDecisionSink,
  instructionSimulationErrorIndex,
  isolateRejectedAssets,
  recordSuccessfulShadowDecision,
  shouldResetRpcCircuitAfterPush,
  type KeeperAction,
} from "./keeper-shadow.ts";
import {
  assessV16MarketHealth,
  formatV16MarketHealth,
  parseUsdcFloor,
  readV16MarketCollateralMint,
  readV16MarketHealthSnapshot,
} from "./v16-market-health.ts";
import {
  pythHermesHeaders,
  pythHermesUrl,
  requirePythHermesConfiguration,
} from "./pyth-hermes.ts";
import {
  PythPriceUnavailableError,
  readPythPushPrices,
  requirePythPriceSourceConfiguration,
  validatePythPrice,
  type AvailablePythPushPrices,
} from "./pyth-solana-push.ts";
import {
  MAGICBLOCK_DEMO_RPC_URL,
  MagicBlockPriceIntegrityError,
  MagicBlockPriceUnavailableError,
  readMagicBlockDemoPrices,
  requireMagicBlockDemoConfiguration,
  type ValidatedMagicBlockPrice,
} from "./magicblock-demo-prices.ts";
import {
  assertOracleSourceLifecycleCompatibility,
  requireOraclePriceSource,
} from "./oracle-price-source.ts";
import { requireKeeperExecutableConfiguration } from "./keeper-executable-config.ts";

const executableConfiguration = requireKeeperExecutableConfiguration(process.env);
const keeperConfiguration = requireKeeperConfiguration({
  RPC_URL: executableConfiguration.runtime.rpcUrl,
  KEEPER_SECRET_KEY: process.env.KEEPER_SECRET_KEY,
});
const KEEPER_MODE = executableConfiguration.mode;
const RPC_URL = executableConfiguration.runtime.rpcUrl;
const PROGRAM_ID = executableConfiguration.runtime.programId;
const MARKET = executableConfiguration.market;
const LP_PORTFOLIO = executableConfiguration.lpPortfolio;
const KEEPER_ASSETS = executableConfiguration.assets;
const RPC_HTTP_REQUEST_TIMEOUT_MS = 5_000;
const oraclePriceSource = requireOraclePriceSource(process.env);
const pythPriceSource = requirePythPriceSourceConfiguration({
  ...process.env,
  PYTH_PRICE_SOURCE: oraclePriceSource === "pyth-hermes" ? "hermes" : "solana-push",
});
const pythHermes = oraclePriceSource === "pyth-hermes"
  ? requirePythHermesConfiguration(process.env)
  : null;
const magicBlockDemoConfiguration = oraclePriceSource === "magicblock-demo"
  ? requireMagicBlockDemoConfiguration(process.env)
  : null;

const PUSH_INTERVAL_MS = 5000;
const TICK_DEADLINE_MS = 20_000;   // abort budget; a hard hang forces bounded restart
const WATCHDOG_MS = 150_000;       // no successful push for this long -> exit(1)
const WATCHDOG_FORCE_EXIT_MS = 10_000;
const TX_TIMEOUT_MS = 8000;
const PENDING_WATCHDOG_GRACE_MS = 120_000;
const MAX_BACKOFF_MS = 30_000;
const MARKET_MAX_CLOCK_LAG_SLOTS = parseRecoveryClockLagSlots(
  process.env.MARKET_MAX_CLOCK_LAG_SLOTS,
);
const LP_HEALTH_CHECK_MS = 5 * 60_000;
const LP_FAILURE_HEALTH_CHECK_MS = 60_000;
const LP_MIN_CAPITAL = parseUsdcFloor(process.env.LP_MIN_CAPITAL_USDC);
const PORTFOLIO_ACCOUNT_LEN = 9411;
// Recovery is deliberately one transaction per normal oracle tick. A large
// backlog on an empty market uses the guarded re-anchor; background catch-up
// must never monopolize the singleton writer or starve fresh price pushes.
const CATCHUP_BATCH_DEADLINE_MS = 6_000;
const SHADOW_DECISION_LOG_MAX_BYTES = 10 * 1024 * 1024;
const shadowDecisionLog = KEEPER_MODE === "shadow"
  ? new BoundedShadowDecisionLog(
    new FileDecisionSink(process.env.SHADOW_DECISION_LOG_PATH ?? "/tmp/ninja-keeper-shadow.jsonl"),
    SHADOW_DECISION_LOG_MAX_BYTES,
  )
  : null;

function loadKeypair(): Keypair {
  try {
    return Keypair.fromSecretKey(parseKeeperSecretKey(keeperConfiguration.encodedSecretKey));
  } catch {
    // Do not leak a malformed source fragment through boot/unhandled handlers.
    throw new KeeperFailure("unknown", "invalid KEEPER_SECRET_KEY");
  }
}

const rpcOperationSignals = new RpcOperationSignalScope();
const conn = new Connection(RPC_URL, {
  commitment: "confirmed",
  // web3.js otherwise retries every 429 several times inside each logical RPC.
  // The keeper owns the retry policy so provider failures cannot amplify.
  disableRetryOnRateLimit: true,
  confirmTransactionInitialTimeout: TX_TIMEOUT_MS,
  // fetchMiddleware only rewrites request arguments; a custom fetch is needed
  // to put the actual HTTP request behind a wall-clock deadline.
  fetch: (url, options) => runHardDeadlineOperation({
    phase: "base-rpc-http",
    parentSignal: rpcOperationSignals.currentSignal()
      ?? options?.signal
      ?? new AbortController().signal,
    timeoutMs: RPC_HTTP_REQUEST_TIMEOUT_MS,
    work: async (requestSignal) => {
      const response = await fetch(url, {
        ...(options ?? {}),
        signal: requestSignal,
      });
      // web3 reads the body after custom fetch resolves. Buffer it while the
      // deadline signal is live so a headers-only response cannot hang later.
      const body = await response.arrayBuffer();
      return new Response(body, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    },
  }),
});
const magicBlockDemoConnection = oraclePriceSource === "magicblock-demo"
  ? new Connection(MAGICBLOCK_DEMO_RPC_URL, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: TX_TIMEOUT_MS,
    fetch: (url, options) => runHardDeadlineOperation({
      phase: "magicblock-rpc-http",
      parentSignal: rpcOperationSignals.currentSignal()
        ?? options?.signal
        ?? new AbortController().signal,
      timeoutMs: RPC_HTTP_REQUEST_TIMEOUT_MS,
      work: async (requestSignal) => {
        const response = await fetch(url, {
          ...(options ?? {}),
          signal: requestSignal,
        });
        const body = await response.arrayBuffer();
        return new Response(body, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      },
    }),
  })
  : null;
const payer = loadKeypair();
type PendingKeeperAction = KeeperAction | "crank-buffer-create";
const pendingBroadcasts = new PendingBroadcastGate<KeeperSendContext & { action: PendingKeeperAction }>();
const maintenanceContinuation = new KeeperMaintenanceContinuation();
let crankBuffer: PublicKey; // legless portfolio used only for catch-up cranks
let shadowCrankBufferUsable = false;

function releaseMetadata(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new KeeperFailure("unknown", `${name} has an invalid format`);
  }
  return value;
}

const RELEASE_SOURCE = releaseMetadata("NINJA_RELEASE_SOURCE", "local");
const RELEASE_ID = releaseMetadata("NINJA_RELEASE_ID", "local");
let releasePushProofLogged = false;

// PushAuthMark (tag 63): [63, asset_index:u16, now_slot:u64, mark_e6:u64]
function ixPushAuthMark(assetIndex: number, nowSlot: bigint, markE6: bigint): TransactionInstruction {
  const d = Buffer.alloc(1 + 2 + 8 + 8);
  d.writeUInt8(63, 0);
  d.writeUInt16LE(assetIndex, 1);
  d.writeBigUInt64LE(nowSlot, 3);
  d.writeBigUInt64LE(markE6, 11);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: true },
    ],
    data: d,
  });
}

// PermissionlessCrank (tag 5): [5, now_slot:u64, n:u8, (asset_index:u16, oracle_accounts:u8)×n]
function ixCrank(portfolio: PublicKey, assetIndexes: number[], nowSlot: bigint): TransactionInstruction {
  const n = assetIndexes.length;
  const d = Buffer.alloc(1 + 8 + 1 + 3 * n);
  d.writeUInt8(5, 0);
  d.writeBigUInt64LE(nowSlot, 1);
  d.writeUInt8(n, 9);
  assetIndexes.forEach((a, i) => {
    d.writeUInt16LE(a, 10 + i * 3);   // asset_index
    d.writeUInt8(0, 12 + i * 3);      // oracle_accounts = 0 (AuthMark reads the stored target)
  });
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: portfolio, isSigner: false, isWritable: true },
    ],
    data: d,
  });
}

function confirmKeeperTransaction(strategy: ConfirmationStrategy, signal: AbortSignal): Promise<unknown> {
  return confirmConnectionTransaction({
    connection: conn,
    parentSignal: signal,
    runWithOperationSignal: (operationSignal, work) => rpcOperationSignals.run(operationSignal, work),
    reportUnexpectedFallbackError: (message) => console.error(`  ${message}`),
    strategy,
    timeoutMs: TX_TIMEOUT_MS,
  });
}

async function reconcilePendingBroadcast(signal: AbortSignal): Promise<void> {
  const pending = pendingBroadcasts.snapshot();
  if (!pending) return;
  const resolved = await pendingBroadcasts.reconcile({
    confirm: (strategy) => confirmKeeperTransaction(strategy, signal),
    rebroadcast: (rawTransaction) => conn.sendRawTransaction(Buffer.from(rawTransaction), {
      skipPreflight: true,
      maxRetries: 0,
    }),
    reportRebroadcastError: (message) => console.error(`  ${message}`),
    signal,
  });
  if (!resolved) return;
  const err = confirmedTransactionError(resolved.result);
  maintenanceContinuation.recordConfirmed(resolved.context, err);
  const signaturePrefix = resolved.strategy.signature.slice(0, 8);
  if (err === null) {
    console.log(`  reconciled ${resolved.context.action} ${signaturePrefix}… at confirmed commitment`);
    if (resolved.context.action === "oracle-push") {
      watchdog.recordConfirmedPush(Date.now(), true);
      watchdogSuppressedUntil = 0;
      // A late push is not a completed healthy tick. Resume its maintenance
      // before allowing another feed read/push or resetting failure history.
    }
  } else {
    console.error(`  reconciled ${resolved.context.action} ${signaturePrefix}… with an on-chain rejection`);
  }
}

async function withRpcSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new KeeperFailure("cancelled", "keeper RPC work cancelled");
  if (rpcOperationSignals.currentSignal()) {
    throw new KeeperFailure("unknown", "concurrent keeper RPC work rejected");
  }
  return rpcOperationSignals.run(signal, async () => {
    try {
      return await work();
    } catch (error) {
      if (signal.aborted) {
        throw new KeeperFailure("timeout", "keeper RPC deadline exceeded");
      }
      throw error;
    }
  });
}

async function sendIxs(
  ixs: TransactionInstruction[],
  cuLimit: number,
  signal: AbortSignal,
  intent?: { action: KeeperAction; assetIndexes: readonly number[]; observedSlot: bigint },
): Promise<{ sig: string; err: unknown | null; confirmed: boolean }> {
  if (signal.aborted) throw new Error("keeper operation cancelled");
  // Reconciliation belongs at tick/boot entry, before instruction planning.
  // Never confirm an old push here and silently submit a newly planned one.
  if (KEEPER_MODE === "live" && pendingBroadcasts.hasPending()) {
    throw new KeeperFailure("pending", "keeper transaction requires entry-point reconciliation");
  }
  if (KEEPER_MODE === "live" && intent?.action === "oracle-push") maintenanceContinuation.assertCanPush();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  if (signal.aborted) throw new Error("keeper operation cancelled");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  const plannedIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
    ...ixs,
  ];
  tx.add(...plannedIxs);
  tx.sign(payer);
  const rawTransaction = tx.serialize();
  const localSignature = tx.signature;
  if (!localSignature) throw new KeeperFailure("unknown", "signed keeper transaction has no payer signature");
  const derivedSignature = bs58.encode(localSignature);

  if (KEEPER_MODE === "shadow" && (!intent || !shadowDecisionLog)) {
    throw new KeeperFailure("unknown", "shadow keeper send intent is missing");
  }
  const execution = await executeKeeperPlan({
    mode: KEEPER_MODE,
    simulate: async () => {
      if (signal.aborted) throw new KeeperFailure("cancelled", "keeper simulation cancelled");
      const error = (await conn.simulateTransaction(tx)).value.err ?? null;
      if (signal.aborted) throw new KeeperFailure("cancelled", "keeper simulation cancelled");
      return error;
    },
    onShadowAccepted: async () => {
      if (signal.aborted) throw new KeeperFailure("cancelled", "keeper simulation cancelled");
      return recordSuccessfulShadowDecision({
        simulationError: null,
        log: shadowDecisionLog!,
        decision: {
          action: intent!.action,
          assetIndexes: intent!.assetIndexes,
          createdAt: new Date().toISOString(),
          instructions: plannedIxs,
          market: MARKET.toBase58(),
          observedSlot: intent!.observedSlot,
          payer: payer.publicKey.toBase58(),
        },
      });
    },
    broadcast: async () => {
      if (signal.aborted) throw new KeeperFailure("cancelled", "keeper transaction submission cancelled");
      const action = intent?.action ?? "crank-buffer-create";
      pendingBroadcasts.record({
        context: { action, assetIndexes: [...(intent?.assetIndexes ?? [])], observedSlot: intent?.observedSlot ?? 0n },
        rawTransaction,
        strategy: { signature: derivedSignature, blockhash, lastValidBlockHeight },
      });
      const sig = await conn.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 0,
      });
      if (sig !== derivedSignature) {
        throw new KeeperFailure("pending", "keeper submission returned a different signature");
      }
      // Confirmation owns and settles all fallback work before this tick can
      // release its single-flight signal.
      const resolved = await pendingBroadcasts.reconcile({
        confirm: (strategy) => confirmKeeperTransaction(strategy, signal),
        signal,
      });
      if (!resolved) throw new KeeperFailure("unknown", "keeper pending broadcast disappeared before confirmation");
      const err = confirmedTransactionError(resolved.result);
      maintenanceContinuation.recordConfirmed(resolved.context, err);
      return { sig, err, confirmed: true };
    },
  });
  if (execution.mode === "live") return execution.value;
  if (execution.simulationError !== null || !execution.value) {
    return { sig: "shadow_rejected", err: execution.simulationError, confirmed: false };
  }
  return { sig: `shadow_${execution.value.decisionId.slice(0, 16)}`, err: null, confirmed: false };
}

async function simulateIxs(
  ixs: TransactionInstruction[],
  cuLimit: number,
  signal: AbortSignal,
): Promise<unknown | null> {
  if (signal.aborted) throw new KeeperFailure("cancelled", "keeper simulation cancelled");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  if (signal.aborted) throw new KeeperFailure("cancelled", "keeper simulation cancelled");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }));
  tx.add(...ixs);
  tx.sign(payer);
  const simulation = await conn.simulateTransaction(tx);
  if (signal.aborted) throw new KeeperFailure("cancelled", "keeper simulation cancelled");
  return simulation.value.err ?? null;
}

/** Ensure the legless crank-buffer portfolio exists (created once, ~0.066 SOL rent). */
async function ensureCrankBuffer(signal: AbortSignal): Promise<void> {
  // v1 used one authority-wide seed, so a valid buffer for an old market
  // occupied the live keeper's address. v2 scopes the deterministic address to
  // this market; old accounts are never selected, repurposed, or deleted.
  const crankBufferSeed = crankBufferSeedForMarket(MARKET.toBytes());
  crankBuffer = await PublicKey.createWithSeed(payer.publicKey, crankBufferSeed, PROGRAM_ID);
  const isUsableBuffer = (info: Awaited<ReturnType<typeof conn.getAccountInfo>>) => info !== null
    && isUsableLeglessCrankBuffer({
      data: info.data,
      expectedLength: PORTFOLIO_ACCOUNT_LEN,
      expectedMarket: MARKET.toBytes(),
      expectedPortfolio: crankBuffer.toBytes(),
      programOwnerMatches: info.owner.equals(PROGRAM_ID),
    });
  if (KEEPER_MODE === "shadow") {
    const existing = await conn.getAccountInfo(crankBuffer, "confirmed");
    shadowCrankBufferUsable = isUsableBuffer(existing);
    console.log(`  shadow crank buffer: ${shadowCrankBufferUsable ? "usable" : "unavailable (self-heal simulation disabled)"}`);
    return;
  }
  const rent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  const initData = Buffer.from([1]); // InitPortfolio (tag 1)
  await ensureUsableCrankBuffer({
    read: () => conn.getAccountInfo(crankBuffer, "confirmed"),
    isUsable: isUsableBuffer,
    create: async () => {
      const { err } = await sendIxs([
        SystemProgram.createAccountWithSeed({
          fromPubkey: payer.publicKey, newAccountPubkey: crankBuffer,
          basePubkey: payer.publicKey, seed: crankBufferSeed,
          lamports: rent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID,
        }),
        new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
            { pubkey: MARKET, isSigner: false, isWritable: true },
            { pubkey: crankBuffer, isSigner: false, isWritable: true },
          ],
          data: initData,
        }),
      ], 200_000, signal, {
        action: "loss-stale-heal",
        assetIndexes: [],
        observedSlot: BigInt(await conn.getSlot("confirmed")),
      });
      if (err) throw new KeeperFailure("onchain", "crank buffer create rejected on-chain");
    },
  });
  console.log(`  crank buffer ready: ${crankBuffer.toBase58()}`);
}

/** Fresh after every successful push; no healthy-result cache. */
async function fetchMaintenancePlan(
  signal: AbortSignal, pushed: readonly number[], minimumContextSlot: bigint,
): Promise<ClockMaintenancePlan> {
  if (minimumContextSlot < 0n || minimumContextSlot > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new KeeperFailure("onchain", "maintenance minimum context is invalid");
  }
  const response = await fetch(RPC_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "keeper-maintenance", method: "getAccountInfo",
      params: [MARKET.toBase58(), { commitment: "confirmed", encoding: "base64",
        minContextSlot: Number(minimumContextSlot) }] }), signal,
  });
  if (!response.ok) throw new KeeperFailure(response.status === 429 ? "rate_limit" : "transport",
    `maintenance status HTTP ${response.status}`, retryAfterMs(response.headers, Date.now()));
  return decodeMaintenanceResponse(await response.json(), { expectedOwner: PROGRAM_ID.toBase58(),
    expectedMarket: MARKET.toBytes(), minimumContextSlot,
    pushedAssetIndexes: pushed });
}

async function maintainClocks(plan: ClockMaintenancePlan, signal: AbortSignal) {
  const layout = maintenanceBatchLayout(plan);
  if (KEEPER_MODE === "shadow" && !shadowCrankBufferUsable) {
    throw new KeeperFailure("onchain", "shadow maintenance requires a usable legless buffer");
  }
  currentTickPhase = "self-heal-transaction";
  const startedAt = Date.now();
  const result = await runDeadlineBoundOperation({
    parentSignal: signal, timeoutMs: CATCHUP_BATCH_DEADLINE_MS,
    work: (batchSignal) => rpcOperationSignals.run(batchSignal, async () => {
      const ixs = Array.from({ length: layout.leglessCranks },
        () => ixCrank(crankBuffer, plan.assetIndexes, plan.observedSlot));
      if (layout.settlesLp) ixs.push(ixCrank(LP_PORTFOLIO, plan.assetIndexes, plan.observedSlot));
      const result = await sendIxs(ixs, 1_400_000, batchSignal, {
        action: layout.settlesLp ? "lp-crank" : "loss-stale-heal",
        assetIndexes: plan.assetIndexes, observedSlot: plan.observedSlot,
      });
      if (result.err !== null) throw new KeeperFailure("onchain", "clock maintenance rejected");
      if (KEEPER_MODE === "live" && !result.confirmed) {
        throw new KeeperFailure("pending", "clock maintenance is not confirmed");
      }
      return result;
    }),
  });
  console.log(`  clock maintenance ${KEEPER_MODE === "shadow" ? "simulated" : "confirmed"}: cranks=${layout.leglessCranks + Number(layout.settlesLp)} plannedMinimum=${plan.cranks} lpAtomic=${layout.settlesLp} debt=${plan.maxDebtSlots} cap=${plan.maxAccrualDtSlots} bounded=${plan.capped} unavailable=${plan.blockedAssetIndexes.join(",") || "none"} elapsedMs=${Date.now() - startedAt}`);
  return { ...result, settlesLp: layout.settlesLp };
}

async function readLpHealth() {
  const [marketInfo, lpInfo] = await conn.getMultipleAccountsInfo(
    [MARKET, LP_PORTFOLIO],
    "confirmed",
  );
  if (!marketInfo || !marketInfo.owner.equals(PROGRAM_ID)) {
    throw new KeeperFailure("onchain", "configured v16 market account is unavailable");
  }
  if (!lpInfo || !lpInfo.owner.equals(PROGRAM_ID)) {
    throw new KeeperFailure("onchain", "configured matcher LP portfolio is unavailable");
  }
  const marketData = Buffer.from(marketInfo.data);
  const collateralMint = new PublicKey(readV16MarketCollateralMint(marketData, MARKET.toBytes()));
  const vaultAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), MARKET.toBuffer()],
    PROGRAM_ID,
  )[0];
  const vaultAta = getAssociatedTokenAddressSync(collateralMint, vaultAuthority, true);
  const custodyBalance = BigInt((await conn.getTokenAccountBalance(vaultAta, "confirmed")).value.amount);
  return assessV16MarketHealth(readV16MarketHealthSnapshot({
    custodyBalance,
    expectedLpPortfolio: LP_PORTFOLIO.toBytes(),
    expectedMarket: MARKET.toBytes(),
    lpData: Buffer.from(lpInfo.data),
    marketData,
  }), LP_MIN_CAPITAL);
}

async function reportLpHealth(
  context: "startup" | "periodic" | "crank rejected",
  signal: AbortSignal,
): Promise<void> {
  const now = Date.now();
  if (context === "crank rejected") {
    if (now < nextLpFailureHealthCheckMs) return;
    nextLpFailureHealthCheckMs = now + LP_FAILURE_HEALTH_CHECK_MS;
  } else {
    if (context !== "startup" && now < nextLpHealthCheckMs) return;
    nextLpHealthCheckMs = now + LP_HEALTH_CHECK_MS;
  }
  try {
    currentTickPhase = "lp-health";
    const assessment = await readLpHealth();
    const message = `  [${context}] ${formatV16MarketHealth(assessment)}`;
    if (assessment.level === "healthy") console.log(message);
    else console.error(message);
  } catch (error) {
    if (signal.aborted) throw error;
    console.error(`  [${context}] LP health unavailable: ${safeErrorMessage(error)}`);
  }
}

console.log("Oracle Keeper (v16, hardened v2) started");
console.log(`  Program: ${PROGRAM_ID.toBase58()}`);
console.log(`  Market:  ${MARKET.toBase58()}`);
console.log(`  Active feeds: ${KEEPER_ASSETS.map((a) => `${a.index}=${a.symbol}`).join(", ")}`);
console.log(`  Auth:    ${payer.publicKey.toBase58()}`);
console.log(`  Mode:    ${KEEPER_MODE}`);
console.log(`  Prices:  ${oraclePriceSource}${oraclePriceSource === "pyth-solana-push" ? " (sponsored shard 0)" : ""}`);
console.log(`  Release: ${RELEASE_SOURCE} (${RELEASE_ID})`);
console.log(`  Recovery clock bound: ${MARKET_MAX_CLOCK_LAG_SLOTS} slots`);
console.log(`  Push:    every ${PUSH_INTERVAL_MS}ms\n`);

let consecutiveErrors = 0;
const rpcCircuit = new RpcCircuitBreaker(systemClock);
const assetQuarantine = new AssetQuarantine(Date.now);
const feedEntitlementQuarantine = new HermesFeedEntitlementQuarantine(Date.now);
type KeeperTickPhase = "idle" | "oracle-read" | "slot-read" | "oracle-push"
  | "lp-crank" | "lp-health" | "recovery-status" | "self-heal-slot"
  | "self-heal-transaction";
let currentTickPhase: KeeperTickPhase = "idle";
const tickRunner = new SingleTickRunner(systemClock, TICK_DEADLINE_MS, onTickDeadline);
const bootRunner = new SingleTickRunner(systemClock, TICK_DEADLINE_MS);
const watchdog = new PushWatchdog(Date.now());
const shutdown = new AbortController();
const lifecycle = new KeeperLifecycle(
  { clearInterval, setInterval },
  (code) => process.exit(code),
  (error) => console.error(`  keeper shutdown drain failed: ${safeErrorMessage(error)}`),
);
let watchdogSuppressedUntil = 0;
let transientBackoffUntil = 0;
let nextLpHealthCheckMs = 0;
let nextLpFailureHealthCheckMs = 0;
let lastUnavailableFeedSet = "";

interface AssetPushPlan {
  index: number;
  instruction: TransactionInstruction;
  display: string;
}

interface ValidatedOraclePrice {
  priceE6: bigint;
  displayPrice: number;
  publishTime: number;
}

interface AvailableOraclePrices {
  prices: Map<number, ValidatedOraclePrice | ValidatedMagicBlockPrice>;
  unavailableIndexes: number[];
}

async function pushAssetsWithIsolation(
  plans: readonly AssetPushPlan[],
  observedSlot: bigint,
  signal: AbortSignal,
): Promise<{ confirmed: boolean; plans: AssetPushPlan[]; sig: string }> {
  const eligible = assetQuarantine.eligible(plans);
  const open = assetQuarantine.snapshot().filter((state) => assetQuarantine.isOpen(state.assetIndex));
  if (open.length > 0) {
    console.error(`  degraded oracle set: quarantined asset indexes ${open.map((state) => state.assetIndex).join(",")}`);
  }
  if (eligible.length === 0) {
    throw new KeeperFailure("onchain", "all oracle assets are temporarily quarantined");
  }

  const send = (batch: readonly AssetPushPlan[]) => sendIxs(
    batch.map((plan) => plan.instruction),
    400_000,
    signal,
    { action: "oracle-push", assetIndexes: batch.map((plan) => plan.index), observedSlot },
  );
  const first = await send(eligible);
  if (first.err === null) {
    if (first.confirmed) {
      for (const plan of eligible) assetQuarantine.recordConfirmedSuccess(plan.index);
    }
    return { confirmed: first.confirmed, plans: eligible, sig: first.sig };
  }

  if (KEEPER_MODE === "shadow") {
    const instructionIndex = instructionSimulationErrorIndex(first.err);
    const firstAssetInstruction = 2; // compute-budget limit + heap-frame precede pushes
    if (instructionIndex === null
      || instructionIndex < firstAssetInstruction
      || instructionIndex >= firstAssetInstruction + eligible.length) {
      throw new KeeperFailure(
        "transport",
        "oracle batch simulation was inconclusive; no assets quarantined",
      );
    }
  }

  const isolated = await isolateRejectedAssets({
    assets: eligible,
    quarantine: assetQuarantine,
    simulate: (plan) => simulateIxs([plan.instruction], 200_000, signal),
    // Each isolated transaction has two compute-budget instructions followed
    // by exactly one asset push at index 2. Anything else is an inconclusive
    // RPC/transaction failure, not evidence against this asset.
    classifyFailure: (_plan, error) => instructionSimulationErrorIndex(error) === 2
      ? "asset-rejection"
      : "inconclusive",
  });
  if (isolated.inconclusive) {
    throw new KeeperFailure(
      "transport",
      "oracle isolation simulation was inconclusive; no assets quarantined",
    );
  }
  if (isolated.rejected.length > 0) {
    console.error(`  isolated rejected oracle asset indexes ${isolated.rejected.map((state) => state.assetIndex).join(",")}`);
  }
  if (isolated.healthy.length === 0) {
    throw new KeeperFailure("onchain", "oracle push rejected for every eligible asset");
  }

  // A single smaller retry salvages healthy majors without creating an
  // unbounded retry tree or letting one bad feed stall the entire market.
  const retry = await send(isolated.healthy);
  if (retry.err !== null) {
    throw new KeeperFailure("onchain", "healthy oracle retry batch rejected on-chain");
  }
  if (retry.confirmed) {
    for (const plan of isolated.healthy) assetQuarantine.recordConfirmedSuccess(plan.index);
  }
  return { confirmed: retry.confirmed, plans: isolated.healthy, sig: retry.sig };
}

function stopKeeper(): void {
  if (lifecycle.isTerminal()) return;
  // Mark terminal before waiting: intervals are cleared immediately, then the
  // process exits only after cancellation reaches active RPC/confirmation work.
  void lifecycle.terminate(async () => {
    shutdown.abort();
    tickRunner.abortActive();
    bootRunner.abortActive();
    await Promise.all([tickRunner.drain(), bootRunner.drain()]);
  });
}

process.once("SIGINT", stopKeeper);
process.once("SIGTERM", stopKeeper);

async function readHermesPrices(signal: AbortSignal): Promise<AvailablePythPushPrices> {
  if (!pythHermes) throw new KeeperFailure("unknown", "Hermes source is not configured");
  // Keep the Hermes operation signal alive through headers, body parsing, and
  // configured-feed validation; a headers-only response must not outlive tick.
  const feedResult = await runHardDeadlineOperation({
    phase: "hermes-feed",
    parentSignal: signal,
    timeoutMs: 5000,
    work: (hermesSignal) => fetchAvailableHermesFeeds({
      feeds: KEEPER_ASSETS,
      quarantine: feedEntitlementQuarantine,
      fetchBatch: async (requested) => {
        const url = pythHermesUrl(
          pythHermes,
          "/v2/updates/price/latest",
          requested.map((asset) => ["ids[]", asset.feedId] as const),
        );
        const resp = await fetch(url, {
          headers: pythHermesHeaders(pythHermes),
          signal: hermesSignal,
        });
        if (resp.status === 403) return { kind: "denied" as const };
        if (!resp.ok) {
          throw new KeeperFailure(
            resp.status === 401
              ? "provider_denied"
              : resp.status === 429 ? "rate_limit" : "transport",
            `Pyth HTTP ${resp.status}`,
            retryAfterMs(resp.headers, Date.now()),
          );
        }
        const data: unknown = await resp.json();
        const parsed = data && typeof data === "object" && Array.isArray((data as { parsed?: unknown }).parsed)
          ? (data as { parsed: Array<{
            id: string;
            price: { price: string; conf: string; expo: number; publish_time: number };
          }> }).parsed
          : [];
        return { items: parsed, kind: "ok" as const };
      },
    }),
  });

  const feeds = new Map<string, ReturnType<typeof validatePythPrice>>();
  const unavailable = new Set(feedResult.unavailableIndexes);
  const nowSecs = Math.floor(Date.now() / 1000);
  for (const asset of KEEPER_ASSETS) {
    const item = feedResult.feeds.get(asset.feedId);
    if (!item) continue;
    try {
      feeds.set(asset.feedId, validatePythPrice({
        price: item.price.price,
        confidence: item.price.conf,
        exponent: item.price.expo,
        publishTime: item.price.publish_time,
      }, pythPriceSource, nowSecs));
    } catch (error) {
      if (error instanceof PythPriceUnavailableError) {
        unavailable.add(asset.index);
        continue;
      }
      throw error;
    }
  }
  if (feeds.size === 0) {
    throw new KeeperFailure("transport", "no fresh Pyth Hermes feeds are available");
  }
  return { feeds, unavailableIndexes: [...unavailable].sort((a, b) => a - b) };
}

function indexPythPrices(result: AvailablePythPushPrices): AvailableOraclePrices {
  const prices = new Map<number, ValidatedOraclePrice>();
  for (const asset of KEEPER_ASSETS) {
    const price = result.feeds.get(asset.feedId);
    if (price) prices.set(asset.index, price);
  }
  return { prices, unavailableIndexes: result.unavailableIndexes };
}

async function readOraclePrices(signal: AbortSignal): Promise<AvailableOraclePrices> {
  if (signal.aborted) throw new KeeperFailure("cancelled", "oracle price read cancelled");
  if (oraclePriceSource === "magicblock-demo") {
    if (!magicBlockDemoConnection || !magicBlockDemoConfiguration) {
      throw new KeeperFailure("unknown", "MagicBlock demo source is not configured");
    }
    try {
      return {
        prices: await readMagicBlockDemoPrices({
          connection: magicBlockDemoConnection,
          configuration: magicBlockDemoConfiguration,
          nowSecs: Math.floor(Date.now() / 1000),
        }),
        unavailableIndexes: [],
      };
    } catch (error) {
      if (error instanceof MagicBlockPriceIntegrityError) {
        throw new KeeperFailure("provider_denied", error.message);
      }
      if (error instanceof MagicBlockPriceUnavailableError) {
        throw new KeeperFailure("transport", error.message);
      }
      throw error;
    }
  }
  if (oraclePriceSource === "pyth-hermes") {
    return indexPythPrices(await readHermesPrices(signal));
  }
  try {
    return indexPythPrices(await readPythPushPrices({
      connection: conn,
      feeds: KEEPER_ASSETS,
      configuration: pythPriceSource,
      nowSecs: Math.floor(Date.now() / 1000),
    }));
  } catch (error) {
    if (error instanceof PythPriceUnavailableError) {
      // Treat a complete sponsored-feed outage like a provider transport
      // failure so the existing circuit suppresses Fly restart amplification.
      throw new KeeperFailure("transport", error.message);
    }
    throw error;
  }
}

async function resumeMaintenance(work: MaintenanceContinuation, signal: AbortSignal): Promise<void> {
  // Freshly size bounded work. A late maintenance confirmation may itself be
  // old by now; do not replay that transaction or use its cached slot/plan.
  const crank = await maintainBeforeLp({
    signal,
    readPlan: () => runHardDeadlineOperation({ phase: "maintenance-plan", parentSignal: signal, timeoutMs: 5_000,
      work: (readSignal) => fetchMaintenancePlan(readSignal, KEEPER_ASSETS.map(a => a.index), work.minimumContextSlot) }),
    runBatch: plan => maintainClocks(plan, signal),
  });
  if (!crank) throw new KeeperFailure("onchain", "no active confirmed-push continuation assets");
  if (crank.err !== null) throw new KeeperFailure("onchain", "resumed LP settlement rejected");
  if (!crank.confirmed) throw new KeeperFailure("pending", "resumed LP settlement not confirmed");
  if (!crank.settlesLp) {
    console.log("  bounded recovery confirmed; LP certification still pending");
    return;
  }
  console.log(`  resumed maintenance+LP confirmed ${crank.sig.slice(0, 8)}…`);
  await reportLpHealth("periodic", signal);
  rpcCircuit.recordConfirmedSuccess();
  consecutiveErrors = 0;
}

async function tickInner(signal: AbortSignal) {
  if (KEEPER_MODE === "live" && await resumeBeforeFreshPush({
    signal, continuation: maintenanceContinuation,
    reconcile: () => reconcilePendingBroadcast(signal),
    resume: work => resumeMaintenance(work, signal),
  })) return;
  currentTickPhase = "oracle-read";
  let feedResult = await readOraclePrices(signal);

  const unavailableKey = feedResult.unavailableIndexes.join(",");
  if (unavailableKey !== lastUnavailableFeedSet) {
    lastUnavailableFeedSet = unavailableKey;
    if (feedResult.unavailableIndexes.length > 0) {
      console.error(`  ${oraclePriceSource} unavailable for asset indexes ${unavailableKey}; healthy feeds remain active`);
    } else {
      console.log(`  complete configured ${oraclePriceSource} feed set restored`);
    }
  }

  // Replace the slot-only read with a validated account+context read AFTER
  // external feed latency. Late LP reconciliation may have left an old market
  // clock; use this tick's one maintenance batch before attempting another push.
  currentTickPhase = "recovery-status";
  const admission = await admitFreshPush({
    signal,
    readPlan: () => runHardDeadlineOperation({ phase: "maintenance-plan", parentSignal: signal, timeoutMs: 5_000,
      work: readSignal => fetchMaintenancePlan(readSignal, KEEPER_ASSETS.map(a => a.index), 0n) }),
    maintain: async plan => { await maintainClocks(plan, signal); },
    refreshFeed: async () => {
      currentTickPhase = "oracle-read";
      feedResult = await readOraclePrices(signal);
      currentTickPhase = "recovery-status";
    },
  });
  if (!admission.admitted) {
    console.log("  pre-push clock maintenance completed; fresh push deferred to next tick");
    return;
  }
  const nowSlot = admission.observedSlot;
  const plans: AssetPushPlan[] = [];
  for (const a of KEEPER_ASSETS) {
    const item = feedResult.prices.get(a.index);
    if (!item) continue;
    plans.push({
      index: a.index,
      instruction: ixPushAuthMark(a.index, nowSlot, item.priceE6),
      display: `${a.symbol} $${item.displayPrice.toFixed(item.displayPrice >= 1000 ? 0 : 2)}`,
    });
  }
  // Tx 1: PUSHES ONLY — must always land, whatever the crank thinks.
  currentTickPhase = "oracle-push";
  const push = await pushAssetsWithIsolation(plans, nowSlot, signal);
  const pushed = push.plans.map((plan) => plan.index);
  const parts = push.plans.map((plan) => plan.display);
  // The watchdog advances only after a live confirmation with an explicit null
  // on-chain error. A successful shadow simulation still proves RPC recovery,
  // so it resets only the provider circuit and never the watchdog.
  if (push.confirmed) {
    watchdog.recordConfirmedPush(Date.now(), true);
    watchdogSuppressedUntil = 0;
    if (!releasePushProofLogged) {
      releasePushProofLogged = true;
      console.log(`NINJA_KEEPER_HEALTH ${JSON.stringify({
        event: "confirmed-push",
        releaseId: RELEASE_ID,
        source: RELEASE_SOURCE,
        oraclePriceSource,
      })}`);
    }
  }
  if (admission.maintenanceUsed) {
    // This tick spent its only maintenance budget before the push. Its newly
    // confirmed push owns a continuation, resumed BEFORE prices next tick.
    // No second batch or LP settlement against a not-yet-maintained new mark.
    console.log(`  fresh push ${push.confirmed ? "confirmed; follow-up retained" : "simulated"} after pre-push maintenance; next tick required`);
    return;
  }
  // Tx 2: bounded maintenance plus atomic LP certification. Capped batches
  // are recovery-only; their continuation cannot claim LP health.
  const crank = await maintainBeforeLp({
    signal,
    readPlan: () => {
      currentTickPhase = "recovery-status";
      return runHardDeadlineOperation({ phase: "maintenance-plan", parentSignal: signal, timeoutMs: 5_000,
        work: (readSignal) => fetchMaintenancePlan(readSignal, KEEPER_ASSETS.map(a => a.index), nowSlot) });
    },
    runBatch: plan => maintainClocks(plan, signal),
  });
  if (!crank) throw new KeeperFailure("onchain", "no pushed active asset is available for maintenance");
  if (!crank.settlesLp) {
    console.log("  bounded recovery completed; LP certification still pending");
    return;
  }
  const time = new Date().toISOString().slice(11, 19);
  if (crank.err) {
    if (KEEPER_MODE === "shadow") {
      const crankInstructionIndex = 2; // compute-budget limit + heap-frame precede the crank
      const failure = classifyPlannedInstructionSimulationFailure(crank.err, crankInstructionIndex);
      if (failure === "inconclusive") {
        throw new KeeperFailure("transport", "crank simulation was inconclusive");
      }
      if (failure === "other-instruction") {
        throw new KeeperFailure("onchain", "crank simulation failed outside the crank instruction");
      }
    }
    const isLossStale = isCustomProgramError(crank.err, 21);
    console.log(`  [${time}] ${parts.join("  ")} ${KEEPER_MODE === "shadow" ? "shadow push simulated" : "push ✓"}, crank rejected${isLossStale ? " -> replan next tick" : ""}`);
    await reportLpHealth("crank rejected", signal);
    // Never send a second maintenance batch in the same tick. Fresh state is
    // replanned after the next push; all error/confirmation gates remain intact.
  } else {
    console.log(`  [${time}] ${parts.join("  ")} ${KEEPER_MODE === "shadow" ? "shadow push+crank simulated" : "push+crank ✓"} ${crank.sig.slice(0, 8)}…`);
    await reportLpHealth("periodic", signal);
  }
  // Do not erase repeated maintenance read/send failures just because the
  // preceding price push succeeded. The watchdog still tracks pushes above.
  if (shouldResetRpcCircuitAfterPush(KEEPER_MODE, push.confirmed)) {
    rpcCircuit.recordConfirmedSuccess();
  }
  consecutiveErrors = 0;
}

async function tick() {
  if (lifecycle.isTerminal() || shutdown.signal.aborted || rpcCircuit.isOpen() || Date.now() < transientBackoffUntil) return;
  try {
    const started = await tickRunner.run((signal) => withRpcSignal(signal, () => tickInner(signal)));
    if (!started) return;
  } catch (err: unknown) {
    const failure = classifyKeeperError(err);
    if (failure.kind === "pending") {
      const pending = pendingBroadcasts.snapshot();
      const label = pending
        ? `${pending.context.action} ${pending.strategy.signature.slice(0, 8)}…`
        : "keeper transaction";
      watchdogSuppressedUntil = Math.max(
        watchdogSuppressedUntil,
        Date.now() + PENDING_WATCHDOG_GRACE_MS,
      );
      console.error(`  ${label} is still pending; replacement signing is blocked`);
      return;
    }
    consecutiveErrors++;
    console.error(`  [${new Date().toISOString().slice(11, 19)}] Error #${consecutiveErrors}: phase=${failure.phase ?? currentTickPhase} elapsedMs=${failure.elapsedMs ?? "unknown"} kind=${failure.kind} ${safeErrorMessage(failure).slice(0, 140)}`);
    const circuitBackoff = rpcCircuit.recordFailure(failure);
    if (circuitBackoff !== null) {
      // A provider outage must not create a Fly restart loop. Give a recovered
      // endpoint a full watchdog window to land the first push.
      watchdogSuppressedUntil = Date.now() + circuitBackoff + WATCHDOG_MS;
      console.error(`  RPC circuit open for ${(circuitBackoff / 1000).toFixed(0)}s`);
    } else if (consecutiveErrors >= 3) {
      const backoff = Math.min(PUSH_INTERVAL_MS * Math.pow(2, consecutiveErrors - 2), MAX_BACKOFF_MS);
      transientBackoffUntil = Date.now() + backoff;
      console.error(`  Backing off ${(backoff / 1000).toFixed(0)}s…`);
    }
  } finally {
    if (!tickRunner.isActive()) currentTickPhase = "idle";
  }
}

function requestKeeperRestart(reason: string): void {
  if (lifecycle.isTerminal()) return;
  console.error(`KEEPER RESTART: ${reason}`);
  const cancelForcedExit = scheduleForcedExit({
    delayMs: WATCHDOG_FORCE_EXIT_MS,
    code: 1,
    exit: (code) => process.exit(code),
  });
  void lifecycle.terminate(async () => {
    shutdown.abort();
    tickRunner.abortActive();
    bootRunner.abortActive();
    await Promise.all([tickRunner.drain(), bootRunner.drain()]);
  }, 1).finally(cancelForcedExit);
}

function onTickDeadline(): void {
  const pending = pendingBroadcasts.snapshot();
  console.error(
    `TICK DEADLINE: phase=${currentTickPhase} pending=${pending?.context.action ?? "none"}`,
  );
  // With no retained signed bytes, a forced process restart cannot race a
  // still-valid state transition. If a broadcast is pending, preserve the
  // existing reconcile-or-expire gate and let the conservative watchdog own
  // the eventual restart instead of signing a replacement too early.
  if (!pending) requestKeeperRestart(`hung ${currentTickPhase} operation with no pending broadcast`);
}

// WATCHDOG: if pushes stop landing, die loudly — Fly restarts the machine.
lifecycle.every(() => {
  if (KEEPER_MODE === "shadow") return;
  if (Date.now() < watchdogSuppressedUntil) return;
  if (watchdog.shouldRestart(Date.now(), WATCHDOG_MS)) {
    requestKeeperRestart(`no successful push for ${WATCHDOG_MS / 1000}s`);
  }
}, 15_000);

process.on("unhandledRejection", (reason) => {
  console.error(`  ${formatUnhandledRejection(reason)}`);
});

async function boot(): Promise<void> {
  for (;;) {
    try {
      if (shutdown.signal.aborted) throw new KeeperFailure("cancelled", "keeper shutdown requested");
      await bootRunner.run((signal) => withRpcSignal(signal, async () => {
        if (KEEPER_MODE === "live") await reconcilePendingBroadcast(signal);
        if (oraclePriceSource === "magicblock-demo") {
          const assessment = await readLpHealth();
          assertOracleSourceLifecycleCompatibility(oraclePriceSource, assessment.assets);
        }
        await ensureCrankBuffer(signal);
        await reportLpHealth("startup", signal);
      }));
      break;
    } catch (error) {
      const failure = classifyKeeperError(error);
      if (failure.kind === "pending") {
        const pending = pendingBroadcasts.snapshot();
        const label = pending
          ? `${pending.context.action} ${pending.strategy.signature.slice(0, 8)}…`
          : "keeper transaction";
        watchdogSuppressedUntil = Math.max(
          watchdogSuppressedUntil,
          Date.now() + PENDING_WATCHDOG_GRACE_MS,
        );
        console.error(`boot ${label} is still pending; waiting to reconcile`);
        await abortableSleep(PUSH_INTERVAL_MS, shutdown.signal);
        continue;
      }
      const backoff = rpcCircuit.recordFailure(failure);
      if (backoff === null) throw failure;
      watchdogSuppressedUntil = Date.now() + backoff + WATCHDOG_MS;
      console.error(`boot RPC circuit open for ${Math.ceil(backoff / 1000)}s`);
      await abortableSleep(backoff, shutdown.signal);
    }
  }
  if (lifecycle.isTerminal()) return;
  void tick();
  lifecycle.every(() => { void tick(); }, PUSH_INTERVAL_MS);
}

boot().catch((error) => {
  if (lifecycle.isTerminal()) return;
  console.error("boot failed:", safeErrorMessage(error));
  void lifecycle.terminate(async () => {
    shutdown.abort();
    tickRunner.abortActive();
    bootRunner.abortActive();
    await Promise.all([tickRunner.drain(), bootRunner.drain()]);
  }, 1);
});
