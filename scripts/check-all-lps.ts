import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseUsedIndices, parseAccount } from "../src/solana/slab.js";

const SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const conn = new Connection("https://api.devnet.solana.com");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const indices = parseUsedIndices(data);
  console.log("All used indices:", indices, "\n");

  console.log("All LPs found:");
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== SYSTEM_PROGRAM.toBase58();
    if (isLP) {
      console.log("  Index " + idx + ":");
      console.log("    matcherProgram:", matcher);
      console.log("    matcherContext:", acc.matcherContext?.toBase58() || "null");
      console.log("    capital:", Number(acc.capital) / 1e9 + " SOL");
    }
  }

  // Also check index 8 explicitly
  console.log("\nChecking index 8 explicitly:");
  try {
    const acc8 = parseAccount(data, 8);
    console.log("  matcherProgram:", acc8.matcherProgram?.toBase58() || "null");
    console.log("  capital:", Number(acc8.capital) / 1e9 + " SOL");
  } catch (e) {
    console.log("  Error:", e);
  }
}

main();
