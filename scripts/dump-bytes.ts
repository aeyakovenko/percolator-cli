import { Connection, PublicKey } from "@solana/web3.js";
import { parseUsedIndices, parseAccount } from "../src/solana/slab.js";
import * as fs from "fs";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const market = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const slab = new PublicKey(market.slab);
const ENGINE_OFF = 328;
const ENGINE_ACCOUNTS_OFF = 95256;
const ACCOUNT_SIZE = 248;

async function main() {
  const info = await connection.getAccountInfo(slab);
  if (!info) { console.log("Not found"); return; }

  // Dump engine header (first 100 bytes after ENGINE_OFF)
  console.log("=== Engine Header ===");
  console.log("ENGINE_OFF =", ENGINE_OFF);
  for (let i = 0; i < 100; i += 8) {
    let hex = "";
    for (let j = 0; j < 8 && i+j < 100; j++) hex += info.data[ENGINE_OFF+i+j].toString(16).padStart(2,'0') + " ";
    const val = info.data.readBigUInt64LE(ENGINE_OFF + i);
    console.log("  @" + i.toString().padStart(3) + ": " + hex + "(u64=" + val + ")");
  }

  // Parse all accounts
  const indices = parseUsedIndices(info.data);
  console.log("Used indices:", indices);

  for (const idx of indices) {
    const base = ENGINE_OFF + ENGINE_ACCOUNTS_OFF + idx * ACCOUNT_SIZE;
    console.log("\nAccount", idx + " raw bytes (ALL 248 bytes):");
    for (let i = 0; i < 248; i += 8) {
      let hex = "";
      for (let j = 0; j < 8 && i+j < 248; j++) hex += info.data[base+i+j].toString(16).padStart(2,'0') + " ";
      const val = i + 8 <= 248 ? info.data.readBigUInt64LE(base + i) : 0n;
      console.log("  @" + i.toString().padStart(3) + ": " + hex + "(u64=" + val + ")");
    }

    // Search for any byte value of 1 (potential kind=LP)
    console.log("\n  Searching for any byte with value 1:");
    for (let i = 0; i < 248; i++) {
      if (info.data[base + i] === 1) {
        console.log("    Found 1 at offset", i);
      }
    }

    // Show both interpretations
    console.log("\n  Rust repr(C) interpretation (kind first):");
    console.log("    kind @0:", info.data[base + 0], "(0=User, 1=LP)");
    console.log("    account_id @8:", info.data.readBigUInt64LE(base + 8));
    console.log("    capital @16 (u128):", info.data.readBigUInt64LE(base + 16) + info.data.readBigUInt64LE(base + 24) * BigInt(2**64));

    console.log("\n  Empirical interpretation (slab.ts):");
    console.log("    account_id @0:", info.data.readBigUInt64LE(base + 0));
    console.log("    capital @8 (u128):", info.data.readBigUInt64LE(base + 8) + info.data.readBigUInt64LE(base + 16) * BigInt(2**64));
    console.log("    kind @24:", info.data[base + 24], "(0=User, 1=LP)");

    // Look for known values to identify the layout
    console.log("\n  Looking for matcher pubkeys and owner (32 bytes each):");
    console.log("    @120 (matcher_program):", Buffer.from(info.data.subarray(base+120, base+152)).toString('hex'));
    console.log("    @152 (matcher_context):", Buffer.from(info.data.subarray(base+152, base+184)).toString('hex'));
    console.log("    @184 (owner):", Buffer.from(info.data.subarray(base+184, base+216)).toString('hex'));

    // Convert owner to base58
    try {
      const ownerPubkey = new PublicKey(info.data.subarray(base+184, base+216));
      console.log("    owner (base58):", ownerPubkey.toBase58());
    } catch (e) {}
  }

}
main().catch(console.error);
