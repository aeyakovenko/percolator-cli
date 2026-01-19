/**
 * Check market config including oracle settings
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseConfig, parseEngine, parseParams } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function getChainlinkPrice(oracle: PublicKey): Promise<{ price: bigint; decimals: number }> {
  const info = await conn.getAccountInfo(oracle);
  if (!info) throw new Error("Oracle not found");
  const decimals = info.data.readUInt8(138);
  const answer = info.data.readBigInt64LE(216);
  return { price: answer, decimals };
}

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const config = parseConfig(data);
  const engine = parseEngine(data);
  const params = parseParams(data);

  console.log("=== MARKET CONFIG ===");
  console.log(`Collateral mint: ${config.collateralMint?.toBase58() || "undefined"}`);
  console.log(`Vault: ${config.vault?.toBase58() || "undefined"}`);
  console.log(`Index feed (oracle): ${config.indexFeedId?.toBase58() || "undefined"}`);
  console.log("");
  console.log(`Invert: ${config.invert} (${config.invert ? "YES - invert oracle price" : "NO - use as-is"})`);
  console.log(`Unit scale: ${config.unitScale}`);
  console.log(`Conf filter BPS: ${config.confFilterBps}`);
  console.log(`Max staleness secs: ${config.maxStalenessSecs}`);
  console.log("");
  console.log("Raw config object:");
  console.log(JSON.stringify(config, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  console.log("");

  // Get oracle price
  const oracle = new PublicKey(marketInfo.oracle);
  const { price, decimals } = await getChainlinkPrice(oracle);
  const priceUsd = Number(price) / Math.pow(10, decimals);

  console.log("=== ORACLE DATA ===");
  console.log(`Oracle address: ${oracle.toBase58()}`);
  console.log(`Raw price: ${price}`);
  console.log(`Decimals: ${decimals}`);
  console.log(`Price USD: $${priceUsd.toFixed(4)}`);
  console.log("");

  // Calculate what the system sees
  console.log("=== PRICE CALCULATION ===");
  if (config.invert) {
    // If inverted, the program does: final_price = unit_scale * 10^decimals / answer
    // This gives cents if unit_scale is set appropriately
    const invertedPrice = config.unitScale * Math.pow(10, decimals) / Number(price);
    console.log(`Inverted price formula: unit_scale * 10^decimals / answer`);
    console.log(`= ${config.unitScale} * 10^${decimals} / ${price}`);
    console.log(`= ${invertedPrice.toFixed(4)}`);
  } else {
    console.log(`Direct price: ${priceUsd.toFixed(4)}`);
  }

  console.log("");
  console.log("=== OBSERVED ENTRY PRICES ===");
  console.log(`LONGs entered at: ~6980 (suggesting ~$69.80)`);
  console.log(`SHORTs entered at: ~6910 (suggesting ~$69.10)`);
  console.log(`Spread: ~70 ticks (~$0.70)`);
}

main().catch(console.error);
