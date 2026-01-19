import { Connection, PublicKey } from "@solana/web3.js";
import { parseConfig, fetchSlab } from "../src/solana/slab.js";

const SLAB = new PublicKey("Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89");
const conn = new Connection("https://api.devnet.solana.com");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const config = parseConfig(data);
  console.log("Vault pubkey:", config.vaultPubkey.toBase58());
  console.log("Collateral mint:", config.collateralMint.toBase58());
  console.log("Index feed:", config.indexFeedId.toBase58());
}

main();
