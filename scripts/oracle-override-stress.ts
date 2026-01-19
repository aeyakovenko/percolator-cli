/**
 * Oracle Override Stress Test
 *
 * This script demonstrates stress testing with admin-controlled oracle prices.
 *
 * REQUIRES: Percolator program modification to add SetOracleOverride instruction
 *
 * Program changes needed:
 * 1. Add oracle_override_price: Option<i64> to MarketConfig
 * 2. Add oracle_override_decimals: u8 to MarketConfig
 * 3. Add SetOracleOverride instruction (tag = 15)
 * 4. Modify get_oracle_price() to check override first
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseParams, parseAccount, parseUsedIndices, parseConfig, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

// Instruction tag for SetOracleOverride (proposed)
const IX_TAG_SET_ORACLE_OVERRIDE = 15;

/**
 * Encode SetOracleOverride instruction
 * Layout: tag(1) + has_price(1) + price(8) + decimals(1) = 11 bytes
 */
function encodeSetOracleOverride(price: bigint | null, decimals: number): Buffer {
  const buf = Buffer.alloc(11);
  buf.writeUInt8(IX_TAG_SET_ORACLE_OVERRIDE, 0);

  if (price !== null) {
    buf.writeUInt8(1, 1);  // has_price = true
    buf.writeBigInt64LE(price, 2);
    buf.writeUInt8(decimals, 10);
  } else {
    buf.writeUInt8(0, 1);  // has_price = false (disable override)
  }

  return buf;
}

/**
 * Set oracle override price (admin only)
 * NOTE: This will fail until program is modified to support this instruction
 */
async function setOracleOverride(priceUsd: number | null, decimals: number = 8): Promise<boolean> {
  const price = priceUsd !== null
    ? BigInt(Math.round(priceUsd * Math.pow(10, decimals)))
    : null;

  const data = encodeSetOracleOverride(price, decimals);

  // Account layout: [admin (signer), slab (writable)]
  const keys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: SLAB, isSigner: false, isWritable: true },
  ];

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    { programId: PROGRAM_ID, keys, data }
  );

  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    console.log(`  Oracle override set: $${priceUsd ?? "DISABLED"}`);
    return true;
  } catch (e: any) {
    console.log(`  SetOracleOverride failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function crank(): Promise<void> {
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData })
  );
  await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  return {
    engine: parseEngine(data),
    params: parseParams(data),
    config: parseConfig(data),
    data,
  };
}

interface StressScenario {
  name: string;
  prices: number[];  // Sequence of prices to test
  description: string;
}

const STRESS_SCENARIOS: StressScenario[] = [
  {
    name: "Flash Crash 50%",
    prices: [143, 100, 71.5],  // Current -> -30% -> -50%
    description: "Sudden 50% price drop to trigger liquidations",
  },
  {
    name: "Gradual Decline",
    prices: [143, 136, 129, 121, 114, 107, 100],
    description: "~5% decline per step, watching margin erosion",
  },
  {
    name: "V-Shape Recovery",
    prices: [143, 100, 71.5, 100, 143],
    description: "Crash then recovery - tests PnL reversals",
  },
  {
    name: "Pump and Dump",
    prices: [143, 200, 286, 200, 143, 100],
    description: "100% pump then crash below original",
  },
  {
    name: "Extreme Volatility",
    prices: [143, 171, 128, 180, 108, 160, 96],
    description: "±20-30% swings each step",
  },
  {
    name: "Near Zero",
    prices: [143, 50, 10, 1, 0.1],
    description: "Price approaching zero edge case",
  },
];

async function runStressScenario(scenario: StressScenario): Promise<{
  liquidations: number;
  insuranceChange: number;
  riskModeTriggered: boolean;
}> {
  console.log(`\n--- ${scenario.name} ---`);
  console.log(`Description: ${scenario.description}`);
  console.log(`Price sequence: ${scenario.prices.map(p => "$" + p).join(" -> ")}`);

  const { engine: initialEngine } = await getState();
  const initialInsurance = Number(initialEngine.insuranceFund.balance) / 1e9;
  const initialLiquidations = Number(initialEngine.lifetimeLiquidations);

  let riskModeTriggered = false;

  for (const price of scenario.prices) {
    console.log(`\n  Setting price: $${price}`);

    const success = await setOracleOverride(price);
    if (!success) {
      console.log("  ⚠️  Override not supported - program modification required");
      return { liquidations: 0, insuranceChange: 0, riskModeTriggered: false };
    }

    // Run crank to process at new price
    try {
      await crank();
    } catch (e: any) {
      console.log(`  Crank failed: ${e.message?.slice(0, 50)}`);
    }

    // Check state
    const { engine, data } = await getState();
    const insurance = Number(engine.insuranceFund.balance) / 1e9;
    const liquidations = Number(engine.lifetimeLiquidations);

    if (engine.riskReductionOnly && !riskModeTriggered) {
      console.log(`  ⚠️  RISK REDUCTION MODE TRIGGERED at $${price}`);
      riskModeTriggered = true;
    }

    // Count liquidatable accounts
    const indices = parseUsedIndices(data);
    let liquidatableCount = 0;
    for (const idx of indices) {
      const acc = parseAccount(data, idx);
      if (acc && acc.kind === AccountKind.User && acc.positionSize !== 0n) {
        // Simplified check - real liquidation check needs oracle price
        const capitalSol = Number(acc.capital) / 1e9;
        if (capitalSol < 0.1) liquidatableCount++;
      }
    }

    console.log(`  Insurance: ${insurance.toFixed(4)} SOL, Liquidations: ${liquidations}, At-risk: ${liquidatableCount}`);
  }

  // Restore original price
  await setOracleOverride(null, 8);

  const { engine: finalEngine } = await getState();
  const finalInsurance = Number(finalEngine.insuranceFund.balance) / 1e9;
  const finalLiquidations = Number(finalEngine.lifetimeLiquidations);

  return {
    liquidations: finalLiquidations - initialLiquidations,
    insuranceChange: finalInsurance - initialInsurance,
    riskModeTriggered,
  };
}

async function main() {
  console.log("=== ORACLE OVERRIDE STRESS TEST ===\n");
  console.log("⚠️  NOTE: Requires percolator program modification");
  console.log("   Add SetOracleOverride instruction (tag=15)\n");

  const { engine, config } = await getState();
  console.log(`Current state:`);
  console.log(`  Insurance: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(4)} SOL`);
  console.log(`  Lifetime liquidations: ${engine.lifetimeLiquidations}`);
  console.log(`  Risk reduction mode: ${engine.riskReductionOnly}`);
  console.log(`  Invert oracle: ${config.invert === 1}`);

  // Try to set override - this will fail until program is modified
  console.log("\n=== TESTING OVERRIDE INSTRUCTION ===");
  const testSuccess = await setOracleOverride(100.00);

  if (!testSuccess) {
    console.log("\n" + "=".repeat(60));
    console.log("PROGRAM MODIFICATION REQUIRED");
    console.log("=".repeat(60));
    console.log(`
To enable oracle override stress testing, add to percolator program:

1. In MarketConfig struct:
   pub oracle_override_price: Option<i64>,
   pub oracle_override_decimals: u8,

2. New instruction SetOracleOverride (tag=15):
   pub fn set_oracle_override(
       ctx: Context<AdminOnly>,
       price: Option<i64>,
       decimals: u8,
   ) -> Result<()>

3. In get_oracle_price():
   if let Some(p) = config.oracle_override_price {
       return Ok((p, config.oracle_override_decimals));
   }
   // else read from Chainlink...

Once deployed, this script will run these scenarios:
`);

    for (const scenario of STRESS_SCENARIOS) {
      console.log(`• ${scenario.name}: ${scenario.description}`);
    }

    return;
  }

  // If override works, run all scenarios
  console.log("\n=== RUNNING STRESS SCENARIOS ===");

  const results: { scenario: string; result: any }[] = [];

  for (const scenario of STRESS_SCENARIOS) {
    const result = await runStressScenario(scenario);
    results.push({ scenario: scenario.name, result });
  }

  // Disable override
  await setOracleOverride(null);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("STRESS TEST RESULTS");
  console.log("=".repeat(60) + "\n");

  console.log("| Scenario              | Liquidations | Insurance Δ | Risk Mode |");
  console.log("|-----------------------|--------------|-------------|-----------|");
  for (const { scenario, result } of results) {
    const riskStr = result.riskModeTriggered ? "YES ⚠️" : "NO";
    const insStr = (result.insuranceChange >= 0 ? "+" : "") + result.insuranceChange.toFixed(4);
    console.log(`| ${scenario.padEnd(21)} | ${result.liquidations.toString().padStart(12)} | ${insStr.padStart(11)} | ${riskStr.padStart(9)} |`);
  }
}

main().catch(console.error);
