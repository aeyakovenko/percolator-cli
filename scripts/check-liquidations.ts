/**
 * Check insurance fund and liquidation stats
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseEngine } from '../src/solana/slab.js';
import * as fs from 'fs';

const marketInfo = JSON.parse(fs.readFileSync('devnet-market.json', 'utf-8'));
const SLAB = new PublicKey(marketInfo.slab);
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

async function main() {
  const data = await fetchSlab(connection, SLAB);
  const engine = parseEngine(data);

  console.log("=== Insurance Fund ===");
  console.log("Balance:", Number(engine.insuranceFund.balance) / 1e9, "SOL");
  console.log("Fee Revenue:", Number(engine.insuranceFund.feeRevenue) / 1e9, "SOL");
  console.log("");
  console.log("=== Open Interest ===");
  console.log("Total OI:", Number(engine.totalOpenInterest) / 1e9, "B units");
  console.log("");
  console.log("=== Liquidations & Force Closes ===");
  console.log("Lifetime Liquidations:", engine.lifetimeLiquidations.toString());
  console.log("Lifetime Force Closes:", engine.lifetimeForceCloses.toString());
}

main().catch(console.error);
