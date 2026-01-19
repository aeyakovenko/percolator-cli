import { PublicKey } from "@solana/web3.js";

const SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");

function deriveLpPda(slabPubkey: PublicKey, lpIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp'), slabPubkey.toBuffer(), Buffer.from([lpIndex & 0xff, (lpIndex >> 8) & 0xff])],
    PROGRAM_ID
  );
  return pda;
}

console.log("LP index 0 PDA:", deriveLpPda(SLAB, 0).toBase58());
console.log("LP index 3 PDA:", deriveLpPda(SLAB, 3).toBase58());

// Check what the devnet-market.json says
import fs from "fs";
const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
console.log("\ndevnet-market.json LP PDA:", marketInfo.lp.pda);
