import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseConfig, parseAccount, parseUsedIndices } from "../src/solana/slab.js";

const SLAB = new PublicKey("GKRvsx2gv7kvNGAKPxCATSufNJei6ep1fg6BvpYoPZAC");
const conn = new Connection("https://api.devnet.solana.com");

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const config = parseConfig(data);
  const indices = parseUsedIndices(data);

  console.log("=== Funding Rate Analysis ===\n");

  // Calculate net position
  let netUserLong = 0n;
  let netUserShort = 0n;
  let lpPosition = 0n;

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";

    if (isLP) {
      lpPosition += acc.positionSize;
    } else {
      if (acc.positionSize > 0n) {
        netUserLong += acc.positionSize;
      } else {
        netUserShort += acc.positionSize;
      }
    }
  }

  console.log("User net long:", netUserLong.toString());
  console.log("User net short:", netUserShort.toString());
  console.log("User net position:", (netUserLong + netUserShort).toString());
  console.log("LP position:", lpPosition.toString());

  console.log("\nFunding state:");
  console.log("  Funding index:", engine.fundingIndexQpbE6.toString());
  console.log("  Last funding slot:", engine.lastFundingSlot.toString());
  console.log("  Net LP position:", engine.netLpPos?.toString() || "N/A");

  console.log("\nFunding config:");
  console.log("  Horizon slots:", config.fundingHorizonSlots?.toString());
  console.log("  K BPS:", config.fundingKBps?.toString());
  console.log("  Max premium BPS:", config.fundingMaxPremiumBps?.toString());
  console.log("  Max BPS per slot:", config.fundingMaxBpsPerSlot?.toString());

  // The formula for PnL from price change:
  // PnL = position_size * (current_price - entry_price) / 1e6
  // For 100B position, if price moves 1 tick (1e-6):
  // PnL = 100e9 * 1 / 1e6 = 100,000 lamports = 0.0001 SOL

  // For LP with 1.6T position and entry 6936, current ~same:
  // If price drops by 100 (from 6936 to 6836):
  // PnL = -1.6e12 * -100 / 1e6 = 160,000,000 lamports = 0.16 SOL

  console.log("\nPnL sensitivity calculation:");
  console.log("  For 100B position, 1 price tick = 0.0001 SOL PnL");
  console.log("  For 100B position, 100 price ticks = 0.01 SOL PnL");
  console.log("  For 100B position, 1000 price ticks = 0.1 SOL PnL");
}

main();
