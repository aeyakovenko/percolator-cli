import {
  TransactionExpiredBlockheightExceededError,
  type BlockheightBasedTransactionConfirmationStrategy,
  type Commitment,
  type RpcResponseAndContext,
  type SignatureResult,
} from "@solana/web3.js";

export type ConfirmationFailure =
  | "aborted"
  | "expired"
  | "on-chain"
  | "timeout"
  | "transport";

export class TransactionConfirmationError extends Error {
  constructor(
    public readonly failure: ConfirmationFailure,
    public readonly signature: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TransactionConfirmationError";
  }
}

export interface ConfirmationConnection {
  confirmTransaction(
    strategy: BlockheightBasedTransactionConfirmationStrategy,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>>;
}

export interface ConfirmRecentTransactionInput {
  connection: ConfirmationConnection;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  commitment: Extract<Commitment, "confirmed" | "finalized">;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ConfirmedTransaction {
  signature: string;
  slot: number;
}

const MAX_CONFIRMATION_TIMEOUT_MS = 120_000;

export async function confirmRecentTransaction(
  input: ConfirmRecentTransactionInput,
): Promise<ConfirmedTransaction> {
  if (!Number.isInteger(input.timeoutMs)
    || input.timeoutMs <= 0
    || input.timeoutMs > MAX_CONFIRMATION_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer from 1 to ${MAX_CONFIRMATION_TIMEOUT_MS}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const onExternalAbort = (): void => {
    externallyAborted = true;
    controller.abort(input.signal?.reason);
  };
  if (input.signal?.aborted) onExternalAbort();
  else input.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("transaction confirmation timed out"));
  }, input.timeoutMs);

  try {
    const result = await input.connection.confirmTransaction(
      {
        signature: input.signature,
        blockhash: input.blockhash,
        lastValidBlockHeight: input.lastValidBlockHeight,
        abortSignal: controller.signal,
      },
      input.commitment,
    );

    if (result.value.err) {
      throw new TransactionConfirmationError(
        "on-chain",
        input.signature,
        `transaction failed on chain: ${JSON.stringify(result.value.err)}`,
      );
    }
    return { signature: input.signature, slot: result.context.slot };
  } catch (error) {
    if (error instanceof TransactionConfirmationError) throw error;
    if (externallyAborted) {
      throw new TransactionConfirmationError(
        "aborted",
        input.signature,
        "transaction confirmation was aborted",
        { cause: error },
      );
    }
    if (timedOut) {
      throw new TransactionConfirmationError(
        "timeout",
        input.signature,
        "transaction confirmation timed out",
        { cause: error },
      );
    }
    if (controller.signal.aborted) {
      throw new TransactionConfirmationError(
        "aborted",
        input.signature,
        "transaction confirmation was aborted",
        { cause: error },
      );
    }
    if (error instanceof TransactionExpiredBlockheightExceededError) {
      throw new TransactionConfirmationError(
        "expired",
        input.signature,
        "transaction blockhash expired before confirmation",
        { cause: error },
      );
    }
    throw new TransactionConfirmationError(
      "transport",
      input.signature,
      "transaction confirmation failed before an on-chain result was established",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
}
