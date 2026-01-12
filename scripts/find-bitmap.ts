import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const market = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const slab = new PublicKey(market.slab);
const ENGINE_OFF = 328;

async function main() {
  const info = await connection.getAccountInfo(slab);
  if (!info) { console.log("Not found"); return; }

  console.log("Slab size:", info.data.length);
  console.log("Looking for bitmap (should have value 1 for LP at index 0)...\n");

  // Scan for u64 values of 1 (indicating bit 0 set = account index 0 used)
  for (let off = ENGINE_OFF; off < info.data.length - 8; off += 8) {
    const val = info.data.readBigUInt64LE(off);
    if (val === 1n) {
      console.log(`Found u64=1 at slab offset ${off} (engine offset ${off - ENGINE_OFF})`);
      // Check if next 63 words are 0 (rest of bitmap, 64 words total)
      let allZero = true;
      for (let i = 1; i < 64 && off + i*8 < info.data.length; i++) {
        if (info.data.readBigUInt64LE(off + i*8) !== 0n) {
          allZero = false;
          break;
        }
      }
      if (allZero) {
        console.log("  -> Likely bitmap start (next 63 words are 0)");
        // Check for numUsed after bitmap (64 words * 8 = 512 bytes)
        const numUsedOff = off + 512;
        if (numUsedOff + 2 < info.data.length) {
          const numUsed = info.data.readUInt16LE(numUsedOff);
          console.log(`  -> numUsed at slab ${numUsedOff} (engine ${numUsedOff - ENGINE_OFF}): ${numUsed}`);
          const nextId = info.data.readBigUInt64LE(numUsedOff + 8);
          console.log(`  -> nextAccountId at slab ${numUsedOff + 8} (engine ${numUsedOff + 8 - ENGINE_OFF}): ${nextId}`);
          // Accounts start after nextAccountId + some padding
          // Check for owner pubkey pattern (32 bytes of non-zero)
          const accountsStart = numUsedOff + 8216; // 8 bytes for nextId + 8208 bytes gap
          console.log(`  -> Estimated accounts start: slab ${accountsStart} (engine ${accountsStart - ENGINE_OFF})`);
        }
      }
    }
  }
}
main().catch(console.error);
