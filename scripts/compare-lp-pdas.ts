import { Connection, PublicKey } from "@solana/web3.js";

const OLD_SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const NEW_SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");

// Matcher contexts used
const MATCHER_CTXS = [
  { name: "AY7Gb...", key: new PublicKey("AY7GbUGzEsdQfiPqHuu8H8KAghvxow5KLWHMfHWxqtLM") },
  { name: "Ek3EZ...", key: new PublicKey("Ek3EZVpyTH981GYqMqir4oFejoEYuQnUTAHpTzHFQ8yG") },
  { name: "1hMy2...", key: new PublicKey("1hMy2Af55rhsQ59jde9GCZgfjVT9jfBaMVfzTFvXR3q") },
];

function deriveLpPda(slabPubkey: PublicKey, lpIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), slabPubkey.toBuffer(), Buffer.from([lpIndex & 0xff, (lpIndex >> 8) & 0xff])],
    PROGRAM_ID
  );
  return pda;
}

async function main() {
  const conn = new Connection("https://api.devnet.solana.com");

  console.log("=== LP PDA Comparison ===\n");

  console.log("OLD Slab LP PDAs:");
  for (const idx of [0, 5, 8, 13]) {
    console.log(`  LP ${idx}:`, deriveLpPda(OLD_SLAB, idx).toBase58());
  }

  console.log("\nNEW Slab LP PDAs:");
  for (const idx of [0, 3, 8, 13]) {
    console.log(`  LP ${idx}:`, deriveLpPda(NEW_SLAB, idx).toBase58());
  }

  console.log("\n=== Matcher Context LP PDA Storage ===\n");

  for (const ctx of MATCHER_CTXS) {
    const info = await conn.getAccountInfo(ctx.key);
    if (info) {
      // LP PDA is stored at offset 64 (32 bytes)
      const storedPda = new PublicKey(info.data.slice(64, 96));
      console.log(`${ctx.name}:`);
      console.log(`  Stored LP PDA: ${storedPda.toBase58()}`);

      // Check which slab/index this matches
      let found = false;
      for (const idx of [0, 3, 5, 8, 13, 14, 15]) {
        const oldPda = deriveLpPda(OLD_SLAB, idx);
        const newPda = deriveLpPda(NEW_SLAB, idx);
        if (oldPda.equals(storedPda)) {
          console.log(`  Matches: OLD slab LP index ${idx}`);
          found = true;
        }
        if (newPda.equals(storedPda)) {
          console.log(`  Matches: NEW slab LP index ${idx}`);
          found = true;
        }
      }
      if (!found) {
        console.log(`  No match found!`);
      }
    } else {
      console.log(`${ctx.name}: NOT FOUND`);
    }
    console.log();
  }
}

main();
