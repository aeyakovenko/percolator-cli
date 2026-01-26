import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseConfig, parseAccount, parseUsedIndices, AccountKind } from "../src/solana/slab.js";

const SLAB = new PublicKey("8GbiJKxuoN2Nr9hshYuBSeuHouU1VyJXXqYCe9J8M4hS");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const config = parseConfig(data);

  console.log("Oracle config:");
  console.log("  Authority:", config.oracleAuthority?.toBase58());
  console.log("  Authority price:", config.authorityPriceE6?.toString());
  console.log("  Authority timestamp:", config.authorityTimestamp?.toString());
  console.log("  Max staleness slots:", config.maxStalenessSlots?.toString());
  console.log();

  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
      console.log(`${kind} ${idx}:`);
      console.log("  Position:", acc.positionSize);
      console.log("  Entry price:", acc.entryPriceE6);
      console.log("  Capital:", (Number(acc.capital || 0) / 1e9).toFixed(6));
      console.log("  PnL:", (Number(acc.pnl || 0) / 1e9).toFixed(6));
    }
  }
}
main().catch(console.error);
