import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseUsedIndices, parseAccount } from "../src/solana/slab.js";

const SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const conn = new Connection("https://api.devnet.solana.com");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const indices = parseUsedIndices(data);
  console.log("Used indices:", indices);

  // Check all indices for matcher_program
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcherStr = acc.matcherProgram?.toBase58() || "null";
    const isLP = acc.matcherProgram && acc.matcherProgram.toBase58() !== SYSTEM_PROGRAM.toBase58();
    console.log(`Index ${idx} - matcherProgram: ${matcherStr} - isLP: ${isLP}`);
    console.log(`         capital: ${acc.capital} position: ${acc.positionSize}`);
  }

  // Also check index 0 explicitly
  console.log("\nChecking index 0 explicitly:");
  const acc0 = parseAccount(data, 0);
  console.log("Index 0 - matcherProgram:", acc0.matcherProgram?.toBase58() || "null");
  console.log("Index 0 - capital:", acc0.capital.toString());
  console.log("Index 0 - owner:", acc0.owner?.toBase58() || "null");
}

main();
