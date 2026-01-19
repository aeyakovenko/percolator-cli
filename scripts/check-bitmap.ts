import { Connection, PublicKey } from "@solana/web3.js";

const SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const conn = new Connection("https://api.devnet.solana.com");

// Correct offsets from slab.ts
const ENGINE_OFF = 328;
const ENGINE_BITMAP_OFF = 86520;  // Correct offset!
const BITMAP_WORDS = 16;

async function main() {
  const info = await conn.getAccountInfo(SLAB);
  const data = Buffer.from(info!.data);
  
  console.log("Slab data length:", data.length);
  
  // Read the bitmap (16 words of 64 bits each = 1024 possible indices)
  const base = ENGINE_OFF + ENGINE_BITMAP_OFF;
  console.log("Bitmap offset:", base);
  
  const indices: number[] = [];
  for (let word = 0; word < BITMAP_WORDS; word++) {
    const bits = data.readBigUInt64LE(base + word * 8);
    if (bits !== 0n) {
      console.log(`Word ${word} (bits ${word*64}-${word*64+63}):`, bits.toString(2).padStart(64, '0'));
      for (let bit = 0; bit < 64; bit++) {
        if ((bits >> BigInt(bit)) & 1n) {
          indices.push(word * 64 + bit);
        }
      }
    }
  }
  
  console.log("\nUsed indices:", indices);
  
  // Also check crank state at correct offsets
  const CRANK_STEP_OFF = 200;  // This might be wrong too
  console.log("\nFirst 300 bytes of engine (for debugging):");
  const engineStart = data.subarray(ENGINE_OFF, ENGINE_OFF + 50);
  console.log(engineStart.toString('hex'));
}

main();
