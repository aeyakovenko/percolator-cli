import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Transaction,
  Keypair,
  SendOptions,
  Commitment,
  AccountMeta,
} from "@solana/web3.js";
import { parseErrorFromLogs } from "../abi/errors.js";

export interface BuildIxParams {
  programId: PublicKey;
  keys: AccountMeta[];
  data: Buffer;
}

/**
 * Build a transaction instruction.
 */
export function buildIx(params: BuildIxParams): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.programId,
    keys: params.keys,
    data: params.data,
  });
}

export interface TxResult {
  signature: string;
  slot: number;
  err: string | null;
  logs: string[];
}

export interface SimulateOrSendParams {
  connection: Connection;
  ix: TransactionInstruction;
  signers: Keypair[];
  simulate: boolean;
  commitment?: Commitment;
}

/**
 * Simulate or send a transaction.
 * Returns consistent output for both modes.
 */
export async function simulateOrSend(
  params: SimulateOrSendParams
): Promise<TxResult> {
  const { connection, ix, signers, simulate, commitment = "confirmed" } = params;

  const tx = new Transaction().add(ix);
  const latestBlockhash = await connection.getLatestBlockhash(commitment);
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.feePayer = signers[0].publicKey;

  if (simulate) {
    tx.sign(...signers);
    const result = await connection.simulateTransaction(tx, signers);
    const logs = result.value.logs ?? [];
    let err: string | null = null;

    if (result.value.err) {
      const parsed = parseErrorFromLogs(logs);
      err = parsed ? `${parsed.name} (${parsed.code})` : JSON.stringify(result.value.err);
    }

    return {
      signature: "(simulated)",
      slot: result.context.slot,
      err,
      logs,
    };
  }

  // Send
  const options: SendOptions = {
    skipPreflight: false,
    preflightCommitment: commitment,
  };

  try {
    const signature = await connection.sendTransaction(tx, signers, options);

    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      commitment
    );

    // Fetch logs
    const txInfo = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    const logs = txInfo?.meta?.logMessages ?? [];
    let err: string | null = null;

    if (confirmation.value.err) {
      const parsed = parseErrorFromLogs(logs);
      err = parsed ? `${parsed.name} (${parsed.code})` : JSON.stringify(confirmation.value.err);
    }

    return {
      signature,
      slot: txInfo?.slot ?? 0,
      err,
      logs,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      signature: "",
      slot: 0,
      err: message,
      logs: [],
    };
  }
}

/**
 * Format transaction result for output.
 */
export function formatResult(result: TxResult, jsonMode: boolean): string {
  if (jsonMode) {
    return JSON.stringify(result, null, 2);
  }

  const lines: string[] = [];

  if (result.err) {
    lines.push(`Error: ${result.err}`);
  } else {
    lines.push(`Signature: ${result.signature}`);
    lines.push(`Slot: ${result.slot}`);
    if (result.signature !== "(simulated)") {
      lines.push(`Explorer: https://explorer.solana.com/tx/${result.signature}`);
    }
  }

  return lines.join("\n");
}
