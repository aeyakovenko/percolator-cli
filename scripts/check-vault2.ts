import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseConfig } from "../src/solana/slab.js";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const config = parseConfig(data);

  console.log("Slab config:");
  console.log("  collateralMint:", config.collateralMint?.toBase58());
  console.log("  vaultPubkey:", config.vaultPubkey?.toBase58());
  console.log("  indexFeedId:", config.indexFeedId?.toBase58());
  console.log("  vaultAuthorityBump:", config.vaultAuthorityBump);

  // Check if it's a valid pubkey
  console.log("\nCurrent devnet-market.json vault:", "AJoTRUUwAb8nB2pwqKhNSKxvbE3GdHHiM9VxpoaBLhVj");
}

main();
