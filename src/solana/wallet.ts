import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { expandPath } from "../config.js";

/**
 * Load a keypair from a JSON file (Solana CLI format).
 * Supports ~ expansion.
 */
export function loadKeypair(path: string): Keypair {
  const resolved = expandPath(path);
  try {
    const raw = readFileSync(resolved, "utf-8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error("Invalid keypair format: expected 64-byte array");
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch (e) {
    throw new Error(`Failed to load keypair from ${resolved}: ${e}`);
  }
}
