/**
 * Check current market and trader state
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseParams, parseAccount, parseUsedIndices } from "../src/solana/slab.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const LP_IDX = marketInfo.lp.index;
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

async function main() {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);

  console.log("=== CURRENT MARKET STATE ===");
  console.log(`Insurance: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(4)} SOL`);
  console.log(`Threshold: ${(Number(params.riskReductionThreshold) / 1e9).toFixed(4)} SOL`);
  console.log(`Surplus: ${((Number(engine.insuranceFund.balance) - Number(params.riskReductionThreshold)) / 1e9).toFixed(4)} SOL`);
  console.log(`Risk reduction: ${engine.riskReductionOnly}`);

  // LP state
  const lpAcc = parseAccount(data, LP_IDX);
  console.log("");
  console.log("=== LP STATE ===");
  console.log(`Position: ${lpAcc.positionSize}`);
  console.log(`Capital: ${(Number(lpAcc.capital) / 1e9).toFixed(4)} SOL`);
  console.log(`PnL: ${(Number(lpAcc.pnl) / 1e9).toFixed(4)} SOL`);
  console.log(`Entry: ${lpAcc.entryPrice}`);

  // Trader states
  const indices = parseUsedIndices(data);

  console.log("");
  console.log("=== TRADER STATES ===");
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    const matcher = acc.matcherProgram?.toBase58() || "null";
    const isLP = matcher !== "null" && matcher !== "11111111111111111111111111111111";
    if (!isLP && acc.owner.equals(payer.publicKey)) {
      const side = acc.positionSize > 0n ? "LONG" : acc.positionSize < 0n ? "SHORT" : "FLAT";
      console.log(`Trader ${idx} (${side}):`);
      console.log(`  Position: ${acc.positionSize}`);
      console.log(`  Capital: ${(Number(acc.capital) / 1e9).toFixed(6)} SOL`);
      console.log(`  Entry: ${acc.entryPrice}`);
      console.log(`  PnL: ${(Number(acc.pnl) / 1e9).toFixed(6)} SOL`);
    }
  }
}

main().catch(console.error);
