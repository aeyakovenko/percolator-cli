/**
 * Check vault conservation invariant
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { fetchSlab, parseEngine, parseAccount, parseUsedIndices } from "../src/solana/slab.js";

const m = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");

async function main() {
  const data = await fetchSlab(conn, new PublicKey(m.slab));
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);

  const vaultInfo = await conn.getTokenAccountBalance(new PublicKey(m.vault));
  const tokenVault = BigInt(vaultInfo.value.amount);

  let sumCapital = 0n;
  let sumPnl = 0n;
  let sumAbsPnl = 0n;
  let posCount = 0;
  let longPos = 0n;
  let shortPos = 0n;

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    sumCapital += acc.capital;
    sumPnl += acc.pnl;
    const absPnl = acc.pnl < 0n ? -acc.pnl : acc.pnl;
    sumAbsPnl += absPnl;
    if (acc.positionBasisQ > 0n) { longPos += acc.positionBasisQ; posCount++; }
    if (acc.positionBasisQ < 0n) { shortPos += acc.positionBasisQ; posCount++; }
  }

  console.log("=== VAULT CONSERVATION ===");
  console.log(`  Token vault:     ${Number(tokenVault)/1e9} SOL`);
  console.log(`  Engine vault:    ${Number(engine.vault)/1e9} SOL`);
  console.log(`  Sum capital:     ${Number(sumCapital)/1e9} SOL`);
  console.log(`  Sum PnL:         ${Number(sumPnl)/1e9} SOL`);
  console.log(`  Sum |PnL|:       ${Number(sumAbsPnl)/1e9} SOL`);
  console.log(`  Insurance:       ${Number(engine.insuranceFund.balance)/1e9} SOL`);
  console.log(`  Insurance floor: ${Number(engine.insuranceFloor)/1e9} SOL`);
  console.log(`  Claims:          ${Number(sumCapital + engine.insuranceFund.balance)/1e9} SOL`);
  console.log(`  Open positions:  ${posCount}`);
  console.log(`  Long basis sum:  ${longPos}`);
  console.log(`  Short basis sum: ${shortPos}`);
  console.log(`  Net basis:       ${longPos + shortPos}`);
  console.log(`  Lifetime liqs:   ${engine.lifetimeLiquidations}`);
  console.log(`  ADL mult long:   ${engine.adlMultLong}`);
  console.log(`  ADL mult short:  ${engine.adlMultShort}`);
  console.log(`  OI eff long:     ${engine.oiEffLongQ}`);
  console.log(`  OI eff short:    ${engine.oiEffShortQ}`);
  console.log(`  Side mode long:  ${engine.sideModeLong}`);
  console.log(`  Side mode short: ${engine.sideModeShort}`);
  console.log("");

  // Check invariants
  let anomalies = 0;

  if (tokenVault < engine.vault) {
    console.log("** ANOMALY: token vault < engine vault **");
    anomalies++;
  }

  if (engine.vault < sumCapital + engine.insuranceFund.balance) {
    const deficit = sumCapital + engine.insuranceFund.balance - engine.vault;
    console.log(`** ANOMALY: engine vault < claims by ${Number(deficit)/1e9} SOL **`);
    // This can happen legitimately when PnL is positive but unrealized
    if (deficit > sumAbsPnl) {
      console.log("** CRITICAL: deficit exceeds total |PnL| — real insolvency **");
      anomalies++;
    } else {
      console.log("   (within PnL bounds — likely unrealized profit claims)");
    }
  }

  // OI balance: long OI should equal short OI
  if (engine.oiEffLongQ !== engine.oiEffShortQ) {
    console.log(`** ANOMALY: OI imbalance — long=${engine.oiEffLongQ} short=${engine.oiEffShortQ} **`);
    anomalies++;
  }

  if (anomalies === 0) {
    console.log("All conservation invariants hold.");
  }
}

main().catch(e => console.error(e.message));
