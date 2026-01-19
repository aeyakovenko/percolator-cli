import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseUsedIndices, parseAccount } from "../src/solana/slab.js";

const SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const conn = new Connection("https://api.devnet.solana.com");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const indices = parseUsedIndices(data);
  console.log("Used indices:", indices, "\n");

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== SYSTEM_PROGRAM.toBase58();
    console.log("Index " + idx + ":");
    console.log("  Type: " + (isLP ? "LP" : "USER"));
    console.log("  capital: " + (Number(acc.capital) / 1e9) + " SOL");
    console.log("  position: " + acc.positionSize);
    console.log("  pnl: " + (Number(acc.pnl) / 1e9) + " SOL");
    console.log("  matcherProgram: " + matcher);
    if (isLP) {
      console.log("  matcherContext: " + (acc.matcherContext?.toBase58() || "null"));
    }
    console.log();
  }
}

main();
