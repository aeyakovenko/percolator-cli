import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseAccount } from "../src/solana/slab.js";

const SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const conn = new Connection("https://api.devnet.solana.com");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  
  // Check LP at index 0
  const lp = parseAccount(data, 0);
  console.log("LP Account at index 0:");
  console.log("  matcherProgram:", lp.matcherProgram?.toBase58() || "null");
  console.log("  matcherContext:", lp.matcherContext?.toBase58() || "null");
  console.log("  capital:", Number(lp.capital) / 1e9, "SOL");
  console.log("  owner:", lp.owner?.toBase58() || "null");
}

main();
