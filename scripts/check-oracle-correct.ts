/**
 * Check Chainlink oracle using correct offsets
 */
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

async function getChainlinkPrice(oracle: PublicKey): Promise<{ price: bigint; decimals: number; raw: Buffer }> {
  const info = await conn.getAccountInfo(oracle);
  if (!info) throw new Error("Oracle not found");
  // From best-price.ts: decimals at offset 138, answer at offset 216
  const decimals = info.data.readUInt8(138);
  const answer = info.data.readBigInt64LE(216);
  return { price: answer, decimals, raw: info.data };
}

async function main() {
  const oracle = new PublicKey(marketInfo.oracle);

  console.log("=== CHAINLINK ORACLE (correct offsets) ===");
  console.log(`Oracle: ${oracle.toBase58()}`);
  console.log("");

  const { price, decimals, raw } = await getChainlinkPrice(oracle);

  console.log(`Decimals (offset 138): ${decimals}`);
  console.log(`Raw price (offset 216): ${price}`);
  console.log(`Price USD: $${(Number(price) / Math.pow(10, decimals)).toFixed(4)}`);
  console.log("");

  // Check other known oracles
  const otherOracles = [
    { name: "v2 oracle", addr: "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix" },
  ];

  for (const o of otherOracles) {
    try {
      const { price: p, decimals: d } = await getChainlinkPrice(new PublicKey(o.addr));
      console.log(`${o.name}: ${o.addr.slice(0, 20)}...`);
      console.log(`  Decimals: ${d}, Price: ${p}, USD: $${(Number(p) / Math.pow(10, d)).toFixed(4)}`);
    } catch (e) {
      console.log(`${o.name}: Error - different format?`);
    }
  }

  // Entry price from our tests was ~6970-6985
  // With inverted: true, if oracle gives X, the system uses 1/X scaled
  console.log("");
  console.log("=== ANALYSIS ===");
  const priceUsd = Number(price) / Math.pow(10, decimals);
  console.log(`Oracle price: $${priceUsd.toFixed(2)}`);
  console.log(`Entry prices in test: ~6970-6985 (cents, i.e., $69.70-$69.85)`);
  console.log("");
  console.log(`If inverted=true and oracle gives SOL/USD:`);
  console.log(`  Oracle shows: $${priceUsd.toFixed(2)}`);
  console.log(`  This should be used as-is (not inverted)`);
  console.log("");
  console.log(`The entry price ~6975 suggests oracle is showing ~$69.75`);
}

main().catch(console.error);
