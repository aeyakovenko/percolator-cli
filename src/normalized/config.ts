import type { Commitment } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

export type SafeCommitment = Extract<Commitment, "confirmed" | "finalized">;

export interface ExplicitRuntimeConfigInput {
  rpcUrl: string;
  programId: string | PublicKey;
  commitment?: SafeCommitment;
  confirmationTimeoutMs?: number;
}

export interface ExplicitRuntimeConfig {
  rpcUrl: string;
  programId: PublicKey;
  commitment: SafeCommitment;
  confirmationTimeoutMs: number;
}

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;
const MIN_CONFIRMATION_TIMEOUT_MS = 1_000;
const MAX_CONFIRMATION_TIMEOUT_MS = 120_000;

function validateRpcUrl(value: string): string {
  if (!value) throw new Error("rpcUrl is required; no cluster is selected by default");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("rpcUrl must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("rpcUrl must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("rpcUrl must not embed HTTP credentials");
  }
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value)
    || value < MIN_CONFIRMATION_TIMEOUT_MS
    || value > MAX_CONFIRMATION_TIMEOUT_MS) {
    throw new Error(
      `confirmationTimeoutMs must be an integer from ${MIN_CONFIRMATION_TIMEOUT_MS} to ${MAX_CONFIRMATION_TIMEOUT_MS}`,
    );
  }
  return value;
}

export function resolveExplicitRuntimeConfig(
  input: ExplicitRuntimeConfigInput,
): ExplicitRuntimeConfig {
  const commitment = input.commitment ?? "confirmed";
  const confirmationTimeoutMs = validateTimeout(
    input.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS,
  );
  let programId: PublicKey;
  try {
    programId = typeof input.programId === "string"
      ? new PublicKey(input.programId)
      : input.programId;
  } catch {
    throw new Error("programId must be a base58 Solana public key");
  }

  return {
    rpcUrl: validateRpcUrl(input.rpcUrl),
    programId,
    commitment,
    confirmationTimeoutMs,
  };
}

export function redactRpcUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}/[redacted]`;
  } catch {
    return "[invalid RPC URL]";
  }
}
