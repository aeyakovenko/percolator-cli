import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseUsedIndices, parseAccount, parseEngine } from "../src/solana/slab.js";

const OLD_SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

async function main() {
  console.log("=== OLD SLAB (GKRv...) ===\n");
  
  const data = await fetchSlab(conn, OLD_SLAB);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);
  
  console.log("Vault:", Number(engine.vault) / 1e9, "SOL");
  console.log("Insurance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Used indices:", indices);
  
  let lpCount = 0;
  let userCount = 0;
  let totalPositions = 0n;
  
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== SYSTEM_PROGRAM.toBase58();
    
    if (isLP) {
      lpCount++;
      console.log("\nLP at index " + idx + ":");
      console.log("  capital:", Number(acc.capital) / 1e9 + " SOL");
      console.log("  matcherContext:", acc.matcherContext?.toBase58());
    } else if (acc.positionSize !== 0n) {
      userCount++;
      totalPositions += acc.positionSize > 0n ? acc.positionSize : -acc.positionSize;
    }
  }
  
  console.log("\nSummary:");
  console.log("  LPs:", lpCount);
  console.log("  Users with positions:", userCount);
  console.log("  Total position size:", totalPositions.toString());
}

main();
