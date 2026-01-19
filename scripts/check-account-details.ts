import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseUsedIndices, parseAccount } from "../src/solana/slab.js";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

async function main() {
  console.log("=== Account Details ===\n");

  const data = await fetchSlab(conn, SLAB);
  const indices = parseUsedIndices(data);

  console.log("Used indices:", indices);
  console.log("\nAll accounts:");

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== SYSTEM_PROGRAM.toBase58();

    console.log(`\nAccount ${idx}:`);
    console.log("  owner:", acc.owner?.toBase58());
    console.log("  capital:", Number(acc.capital) / 1e9, "SOL");
    console.log("  position:", acc.positionSize.toString());
    console.log("  pnl:", Number(acc.pnl) / 1e9, "SOL");
    console.log("  isLP:", isLP);
    if (isLP) {
      console.log("  matcherContext:", acc.matcherContext?.toBase58());
    }
  }
}

main();
