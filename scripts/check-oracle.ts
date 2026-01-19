/**
 * Check Chainlink oracle data and slab params
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseParams } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const oracle = new PublicKey(marketInfo.oracle);

async function main() {
  // First check slab params
  const slabData = await fetchSlab(conn, SLAB);
  const params = parseParams(slabData);

  console.log("=== SLAB PARAMS ===");
  console.log(`Invert: ${params.invert}`);
  console.log(`Unit Scale: ${params.unitScale}`);
  console.log(`Conf Filter BPS: ${params.confFilterBps}`);
  console.log("");

  // Now check oracle
  const info = await conn.getAccountInfo(oracle);
  if (!info) {
    console.log("Oracle not found");
    return;
  }

  const data = info.data;

  console.log("=== CURRENT ORACLE (configured) ===");
  console.log(`Address: ${oracle.toBase58()}`);
  console.log(`Owner (program): ${info.owner.toBase58()}`);
  console.log(`Data length: ${data.length} bytes`);

  // Check for description string
  const descStart = data.indexOf(Buffer.from("SOL"));
  if (descStart >= 0) {
    const desc = data.slice(descStart, descStart + 20).toString("utf8").replace(/\0/g, "");
    console.log(`Description: ${desc}`);
  }

  // Try different exponent interpretations
  const rawPrice = data.readBigInt64LE(8);
  console.log("");
  console.log("Price interpretations:");
  console.log(`  Raw: ${rawPrice}`);
  console.log(`  / 1e8: $${(Number(rawPrice) / 1e8).toFixed(4)}`);
  console.log(`  / 1e6: $${(Number(rawPrice) / 1e6).toFixed(4)}`);
  console.log(`  * 1e-2 (cents): ${(Number(rawPrice) / 1e16).toFixed(4)}`);

  // Check what the slab parser expects
  console.log("");
  console.log("=== KNOWN CHAINLINK DEVNET ORACLES ===");

  // Known Chainlink SOL/USD on devnet
  const knownOracles = [
    { name: "Current (old)", addr: "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR" },
    { name: "SOL/USD (v2)", addr: "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix" },
    { name: "SOL/USD (Switchboard)", addr: "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR" },
  ];

  for (const o of knownOracles) {
    try {
      const oInfo = await conn.getAccountInfo(new PublicKey(o.addr));
      if (oInfo) {
        const oPrice = oInfo.data.readBigInt64LE(8);
        console.log(`${o.name}: ${o.addr.slice(0, 20)}...`);
        console.log(`  Raw: ${oPrice}, $${(Number(oPrice) / 1e8).toFixed(2)} at 8 dec`);
      } else {
        console.log(`${o.name}: NOT FOUND`);
      }
    } catch (e) {
      console.log(`${o.name}: Error`);
    }
  }

  console.log("");
  console.log("=== RECOMMENDATION ===");
  console.log("The v2 oracle J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix");
  console.log("shows a more realistic SOL price (~$185) and may be more actively updated.");
}

main().catch(console.error);
