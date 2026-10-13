import { strict as assert } from "node:assert";
import {
  TransactionExpiredBlockheightExceededError,
  type BlockheightBasedTransactionConfirmationStrategy,
  type Commitment,
  type ConnectionConfig,
  type RpcResponseAndContext,
  type SignatureResult,
} from "@solana/web3.js";
import {
  TransactionConfirmationError,
  confirmRecentTransaction,
  createSafeConnection,
  redactRpcUrl,
  resolveExplicitRuntimeConfig,
  validateBps,
  validateI128,
  validatePublicKey,
  validateU16,
  validateU64,
  type ConfirmationConnection,
} from "../../src/normalized/index.js";

const PROGRAM_ID = "11111111111111111111111111111111";
const SIGNATURE = "1".repeat(64);

function expectThrow(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, pattern);
}

function config(overrides: Partial<Parameters<typeof resolveExplicitRuntimeConfig>[0]> = {}) {
  return resolveExplicitRuntimeConfig({
    rpcUrl: "https://rpc.example.invalid/api-key-value",
    programId: PROGRAM_ID,
    ...overrides,
  });
}

{
  const resolved = config();
  assert.equal(resolved.commitment, "confirmed");
  assert.equal(resolved.confirmationTimeoutMs, 60_000);
  assert.equal(resolved.programId.toBase58(), PROGRAM_ID);
  expectThrow(
    () => resolveExplicitRuntimeConfig({ rpcUrl: "", programId: PROGRAM_ID }),
    /no cluster is selected by default/,
  );
  expectThrow(
    () => config({ rpcUrl: "file:///tmp/rpc" }),
    /HTTP or HTTPS/,
  );
  expectThrow(
    () => config({ rpcUrl: "https://user:secret@rpc.example.invalid" }),
    /must not embed HTTP credentials/,
  );
  assert.equal(
    redactRpcUrl("https://rpc.example.invalid/private-token?key=secret"),
    "https://rpc.example.invalid/[redacted]",
  );
}

{
  let endpoint = "";
  let options: ConnectionConfig | undefined;
  const fakeConnection = {} as never;
  const made = createSafeConnection(config(), (nextEndpoint, nextOptions) => {
    endpoint = nextEndpoint;
    options = nextOptions;
    return fakeConnection;
  });
  assert.equal(made, fakeConnection);
  assert.equal(endpoint, "https://rpc.example.invalid/api-key-value");
  assert.equal(options?.commitment, "confirmed");
  assert.equal(options?.disableRetryOnRateLimit, true);
  assert.equal(options?.confirmTransactionInitialTimeout, 60_000);
}

{
  assert.equal(validateU16("65535", "asset"), 65535);
  assert.equal(validateU64("18446744073709551615", "amount"), (1n << 64n) - 1n);
  assert.equal(validateI128("-1", "position"), -1n);
  assert.equal(validateBps("10000", "fee"), 10_000);
  assert.equal(validatePublicKey(PROGRAM_ID, "program").toBase58(), PROGRAM_ID);
  for (const value of ["", "01", "1e3", "1.0", " 1", "+1", "1x"]) {
    expectThrow(() => validateU16(value, "asset"), /canonical unsigned decimal/);
  }
  expectThrow(() => validateBps("10001", "fee"), /basis points/);
}

function connectionWith(
  implementation: (
    strategy: BlockheightBasedTransactionConfirmationStrategy,
    commitment?: Commitment,
  ) => Promise<RpcResponseAndContext<SignatureResult>>,
): ConfirmationConnection {
  return { confirmTransaction: implementation };
}

function confirm(
  connection: ConfirmationConnection,
  overrides: Partial<Parameters<typeof confirmRecentTransaction>[0]> = {},
) {
  return confirmRecentTransaction({
    connection,
    signature: SIGNATURE,
    blockhash: "blockhash",
    lastValidBlockHeight: 123,
    commitment: "confirmed",
    timeoutMs: 100,
    ...overrides,
  });
}

{
  await assert.rejects(
    confirm(connectionWith(async () => ({
      context: { slot: 0 },
      value: { err: null },
    })), { timeoutMs: 120_001 }),
    /timeoutMs must be an integer from 1 to 120000/,
  );
}

{
  const result = await confirm(connectionWith(async (strategy, commitment) => {
    assert.equal(strategy.signature, SIGNATURE);
    assert.equal(commitment, "confirmed");
    return { context: { slot: 77 }, value: { err: null } };
  }));
  assert.deepEqual(result, { signature: SIGNATURE, slot: 77 });
}

{
  await assert.rejects(
    confirm(connectionWith(async () => ({
      context: { slot: 78 },
      value: { err: { InstructionError: [0, "Custom"] } },
    }))),
    (error: unknown) => error instanceof TransactionConfirmationError
      && error.failure === "on-chain",
  );
}

{
  await assert.rejects(
    confirm(connectionWith(async (strategy) => new Promise((_, reject) => {
      strategy.abortSignal?.addEventListener(
        "abort",
        () => reject(strategy.abortSignal?.reason),
        { once: true },
      );
    })), { timeoutMs: 5 }),
    (error: unknown) => error instanceof TransactionConfirmationError
      && error.failure === "timeout",
  );
}

{
  const controller = new AbortController();
  const pending = confirm(connectionWith(async (strategy) => new Promise((_, reject) => {
    strategy.abortSignal?.addEventListener(
      "abort",
      () => reject(strategy.abortSignal?.reason),
      { once: true },
    );
  })), { signal: controller.signal });
  controller.abort(new Error("test cancellation"));
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof TransactionConfirmationError
      && error.failure === "aborted",
  );
}

{
  await assert.rejects(
    confirm(connectionWith(async () => {
      throw new TransactionExpiredBlockheightExceededError(SIGNATURE);
    })),
    (error: unknown) => error instanceof TransactionConfirmationError
      && error.failure === "expired",
  );
}

{
  await assert.rejects(
    confirm(connectionWith(async () => {
      throw new Error("provider unavailable");
    })),
    (error: unknown) => error instanceof TransactionConfirmationError
      && error.failure === "transport",
  );
}

console.log("normalized foundation: all tests passed");
