import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Transaction,
  Keypair,
  SendOptions,
  Commitment,
  AccountMeta,
  ComputeBudgetProgram,
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
  hint?: string;
  logs: string[];
  unitsConsumed?: number;
  cluster?: string;
}

export interface SimulateOrSendParams {
  connection: Connection;
  ix: TransactionInstruction;
  signers: Keypair[];
  simulate: boolean;
  commitment?: Commitment;
  computeUnitLimit?: number; // Custom compute unit limit (default: 200,000, max: 1,400,000)
}

/**
 * Simulate or send a transaction.
 * Returns consistent output for both modes.
 */
export async function simulateOrSend(
  params: SimulateOrSendParams
): Promise<TxResult> {
  const { connection, ix, signers, simulate, commitment = "confirmed", computeUnitLimit } = params;

  const tx = new Transaction();

  // Add compute budget instruction if custom limit is specified
  if (computeUnitLimit !== undefined) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnitLimit,
      })
    );
  }

  tx.add(ix);
  const latestBlockhash = await connection.getLatestBlockhash(commitment);
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.feePayer = signers[0].publicKey;

  if (simulate) {
    tx.sign(...signers);
    const result = await connection.simulateTransaction(tx, signers);
    const logs = result.value.logs ?? [];
    let err: string | null = null;
    let hint: string | undefined;

    if (result.value.err) {
      const parsed = parseErrorFromLogs(logs);
      if (parsed) {
        err = `${parsed.name} (0x${parsed.code.toString(16)})`;
        hint = parsed.hint;
      } else {
        err = JSON.stringify(result.value.err);
      }
    }

    return {
      signature: "(simulated)",
      slot: result.context.slot,
      err,
      hint,
      logs,
      unitsConsumed: result.value.unitsConsumed ?? undefined,
      cluster: detectCluster(connection.rpcEndpoint),
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
    let hint: string | undefined;

    if (confirmation.value.err) {
      const parsed = parseErrorFromLogs(logs);
      if (parsed) {
        err = `${parsed.name} (0x${parsed.code.toString(16)})`;
        hint = parsed.hint;
      } else {
        err = JSON.stringify(confirmation.value.err);
      }
    }

    return {
      signature,
      slot: txInfo?.slot ?? 0,
      err,
      hint,
      logs,
      cluster: detectCluster(connection.rpcEndpoint),
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      signature: "",
      slot: 0,
      err: message,
      logs: [],
      cluster: detectCluster(connection.rpcEndpoint),
    };
  }
}

/**
 * Detect Solana cluster from RPC endpoint URL.
 */
function detectCluster(rpcUrl: string): string | undefined {
  if (rpcUrl.includes("devnet")) return "devnet";
  if (rpcUrl.includes("testnet")) return "testnet";
  return undefined; // mainnet or unknown — no query param needed
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
    if (result.hint) {
      lines.push(`Hint: ${result.hint}`);
    }
    if (result.unitsConsumed !== undefined) {
      lines.push(`Compute Units: ${result.unitsConsumed.toLocaleString()}`);
    }
    if (result.logs.length > 0) {
      lines.push("Logs:");
      result.logs.forEach((log) => lines.push(`  ${log}`));
    }
  } else {
    lines.push(`Signature: ${result.signature}`);
    lines.push(`Slot: ${result.slot}`);
    if (result.unitsConsumed !== undefined) {
      lines.push(`Compute Units: ${result.unitsConsumed.toLocaleString()}`);
    }
    if (result.signature !== "(simulated)") {
      lines.push(`Explorer: https://explorer.solana.com/tx/${result.signature}${result.cluster ? `?cluster=${result.cluster}` : ""}`);
    }
  }

  return lines.join("\n");
}
