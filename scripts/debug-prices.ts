/**
 * Debug entry prices vs oracle prices
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseAccount, parseConfig } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function main() {
  // Get slab data
  const slabData = await fetchSlab(conn, SLAB);
  const config = parseConfig(slabData);

  // Get oracle data
  const oracleInfo = await conn.getAccountInfo(ORACLE);
  if (!oracleInfo) throw new Error("Oracle not found");

  const oracleDecimals = oracleInfo.data.readUInt8(138);
  const oracleAnswer = oracleInfo.data.readBigInt64LE(216);
  const oraclePriceUsd = Number(oracleAnswer) / Math.pow(10, oracleDecimals);

  console.log("=== ORACLE ===");
  console.log(`Address: ${ORACLE.toBase58()}`);
  console.log(`Decimals: ${oracleDecimals}`);
  console.log(`Raw answer: ${oracleAnswer}`);
  console.log(`Price USD: $${oraclePriceUsd.toFixed(4)}`);

  console.log("");
  console.log("=== CONFIG ===");
  console.log(`Invert: ${config.invert}`);
  console.log(`Unit scale: ${config.unitScale}`);

  console.log("");
  console.log("=== ACCOUNT ENTRY PRICES ===");

  for (const idx of [0, 6, 7, 8, 9, 11]) {
    const acc = parseAccount(slabData, idx);
    if (acc) {
      console.log(`Account ${idx}: entry=${acc.entryPrice}, pos=${acc.positionSize}`);
    }
  }

  console.log("");
  console.log("=== ANALYSIS ===");

  const entryPrice = 6975n;
  console.log(`Entry price from slab: ${entryPrice}`);
  console.log(`Oracle raw: ${oracleAnswer}`);
  console.log(`Oracle USD: $${oraclePriceUsd.toFixed(2)}`);
  console.log("");

  // If entry_price is in "cents" (hundredths of a dollar)
  console.log("Interpretation 1: entry_price in cents");
  console.log(`  ${entryPrice} cents = $${Number(entryPrice) / 100}`);
  console.log(`  Expected from oracle: ${oraclePriceUsd * 100} cents`);
  console.log(`  Ratio: ${(oraclePriceUsd * 100) / Number(entryPrice)}`);

  // If entry_price matches oracle format
  console.log("");
  console.log("Interpretation 2: entry_price same scale as oracle");
  console.log(`  Oracle scale: ${oracleAnswer} / $${oraclePriceUsd} = ${Number(oracleAnswer) / oraclePriceUsd}`);
  console.log(`  Entry at that scale: ${Number(entryPrice) * (Number(oracleAnswer) / oraclePriceUsd) / Number(oracleAnswer)}`);

  // Try to work backwards
  console.log("");
  console.log("Reverse calculation:");
  console.log(`  If entry ${entryPrice} represents price, what oracle value?`);
  console.log(`  entry * 10^${oracleDecimals} / 100 = ${Number(entryPrice) * Math.pow(10, oracleDecimals) / 100}`);

  // Maybe the program stores price differently
  console.log("");
  console.log("Key insight:");
  console.log(`  Entry ~6975 ≈ $69.75 if in cents`);
  console.log(`  Oracle ~$143.60`);
  console.log(`  These don't match - oracle may have changed, or format is different`);
}

main().catch(console.error);
