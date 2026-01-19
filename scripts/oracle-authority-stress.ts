/**
 * Oracle Authority Stress Test
 *
 * Uses the program's built-in oracle authority feature to push controlled prices
 * and stress test liquidations, funding, and risk mode.
 *
 * Instructions used:
 * - SetOracleAuthority (tag 16): Admin sets who can push prices
 * - PushOraclePrice (tag 17): Authority pushes a price
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseParams, parseAccount, parseUsedIndices, parseConfig, parseHeader, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodeSetOracleAuthority, encodePushOraclePrice } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_SET_ORACLE_AUTHORITY, ACCOUNTS_PUSH_ORACLE_PRICE } from "../src/abi/accounts.js";
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

/**
 * Set oracle authority (admin only)
 */
async function setOracleAuthority(newAuthority: PublicKey): Promise<boolean> {
  const data = encodeSetOracleAuthority({ newAuthority });
  const keys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [payer.publicKey, SLAB]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys, data })
  );

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    console.log(`  SetOracleAuthority: ${newAuthority.toBase58().slice(0, 8)}... (${sig.slice(0, 8)}...)`);
    return true;
  } catch (e: any) {
    console.log(`  SetOracleAuthority failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

/**
 * Push oracle price (authority only)
 * @param priceUsd - Price in USD (e.g., 143.50)
 */
async function pushOraclePrice(priceUsd: number): Promise<boolean> {
  const priceE6 = BigInt(Math.round(priceUsd * 1_000_000));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  const data = encodePushOraclePrice({ priceE6, timestamp });
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, SLAB]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys, data })
  );

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    console.log(`  PushOraclePrice: $${priceUsd} (${sig.slice(0, 8)}...)`);
    return true;
  } catch (e: any) {
    console.log(`  PushOraclePrice failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

/**
 * Disable oracle authority (set to zero pubkey)
 */
async function disableOracleAuthority(): Promise<boolean> {
  return setOracleAuthority(PublicKey.default);
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
    header: parseHeader(data),
    engine: parseEngine(data),
    params: parseParams(data),
    config: parseConfig(data),
    data,
  };
}

interface StressScenario {
  name: string;
  prices: number[];
  description: string;
}

const STRESS_SCENARIOS: StressScenario[] = [
  {
    name: "Flash Crash 50%",
    prices: [143, 100, 71.5],
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
    description: "+/- 20-30% swings each step",
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

    const success = await pushOraclePrice(price);
    if (!success) {
      console.log("  Price push failed - check oracle authority");
      break;
    }

    // Run crank to process at new price
    try {
      await crank();
      console.log("  Crank OK");
    } catch (e: any) {
      console.log(`  Crank failed: ${e.message?.slice(0, 50)}`);
    }

    // Check state
    const { engine, data } = await getState();
    const insurance = Number(engine.insuranceFund.balance) / 1e9;
    const liquidations = Number(engine.lifetimeLiquidations);

    if (engine.riskReductionOnly && !riskModeTriggered) {
      console.log(`  RISK REDUCTION MODE TRIGGERED at $${price}`);
      riskModeTriggered = true;
    }

    // Count liquidatable accounts
    const indices = parseUsedIndices(data);
    let liquidatableCount = 0;
    for (const idx of indices) {
      const acc = parseAccount(data, idx);
      if (acc && acc.kind === AccountKind.User && acc.positionSize !== 0n) {
        const capitalSol = Number(acc.capital) / 1e9;
        if (capitalSol < 0.1) liquidatableCount++;
      }
    }

    console.log(`  Insurance: ${insurance.toFixed(4)} SOL, Liquidations: ${liquidations}, At-risk: ${liquidatableCount}`);
  }

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
  console.log("=== ORACLE AUTHORITY STRESS TEST ===\n");

  const { header, engine, config } = await getState();
  console.log(`Current state:`);
  console.log(`  Admin: ${header.admin.toBase58()}`);
  console.log(`  Insurance: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(4)} SOL`);
  console.log(`  Lifetime liquidations: ${engine.lifetimeLiquidations}`);
  console.log(`  Risk reduction mode: ${engine.riskReductionOnly}`);
  console.log(`  Oracle invert: ${config.invert === 1}`);

  // Check current oracle authority
  const oracleAuth = config.oracleAuthority;
  console.log(`  Oracle authority: ${oracleAuth.toBase58()}`);
  console.log(`  Authority price: ${Number(config.authorityPriceE6) / 1e6}`);
  console.log(`  Authority timestamp: ${config.authorityTimestamp}`);

  // Step 1: Set ourselves as oracle authority
  console.log("\n=== STEP 1: SET ORACLE AUTHORITY ===");
  const isZero = oracleAuth.equals(PublicKey.default);

  if (isZero) {
    console.log("Oracle authority is not set. Setting payer as authority...");
    const setSuccess = await setOracleAuthority(payer.publicKey);
    if (!setSuccess) {
      console.log("ERROR: Failed to set oracle authority. Are you the admin?");
      return;
    }
  } else if (oracleAuth.equals(payer.publicKey)) {
    console.log("Payer is already the oracle authority.");
  } else {
    console.log(`Different authority is set: ${oracleAuth.toBase58()}`);
    console.log("Setting payer as new authority...");
    const setSuccess = await setOracleAuthority(payer.publicKey);
    if (!setSuccess) {
      console.log("ERROR: Failed to set oracle authority. Are you the admin?");
      return;
    }
  }

  // Step 2: Test pushing a price
  console.log("\n=== STEP 2: TEST PRICE PUSH ===");
  const testPrice = 143.50;
  const pushSuccess = await pushOraclePrice(testPrice);
  if (!pushSuccess) {
    console.log("ERROR: Failed to push price. Check authority setup.");
    return;
  }
  console.log("Price push successful!");

  // Verify the price was stored
  const { config: updatedConfig } = await getState();
  const storedPrice = Number(updatedConfig.authorityPriceE6) / 1e6;
  console.log(`  Stored price: $${storedPrice.toFixed(2)}`);

  // Step 3: Run stress scenarios
  console.log("\n=== STEP 3: RUN STRESS SCENARIOS ===");

  const scenarioArg = process.argv[2];
  let scenariosToRun: StressScenario[];

  if (scenarioArg) {
    const idx = parseInt(scenarioArg);
    if (!isNaN(idx) && idx >= 0 && idx < STRESS_SCENARIOS.length) {
      scenariosToRun = [STRESS_SCENARIOS[idx]];
    } else {
      const found = STRESS_SCENARIOS.find(s => s.name.toLowerCase().includes(scenarioArg.toLowerCase()));
      if (found) {
        scenariosToRun = [found];
      } else {
        console.log(`Unknown scenario: ${scenarioArg}`);
        console.log("Available scenarios:");
        STRESS_SCENARIOS.forEach((s, i) => console.log(`  ${i}: ${s.name}`));
        return;
      }
    }
  } else {
    // Default: just run first scenario as a test
    scenariosToRun = [STRESS_SCENARIOS[0]];
    console.log("Running first scenario as test. Pass scenario index or name to run specific test.");
    console.log("Available scenarios:");
    STRESS_SCENARIOS.forEach((s, i) => console.log(`  ${i}: ${s.name}`));
  }

  const results: { scenario: string; result: any }[] = [];

  for (const scenario of scenariosToRun) {
    const result = await runStressScenario(scenario);
    results.push({ scenario: scenario.name, result });
  }

  // Restore reasonable price
  console.log("\n=== RESTORING PRICE ===");
  await pushOraclePrice(143.50);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("STRESS TEST RESULTS");
  console.log("=".repeat(60) + "\n");

  console.log("| Scenario              | Liquidations | Insurance D | Risk Mode |");
  console.log("|-----------------------|--------------|-------------|-----------|");
  for (const { scenario, result } of results) {
    const riskStr = result.riskModeTriggered ? "YES" : "NO";
    const insStr = (result.insuranceChange >= 0 ? "+" : "") + result.insuranceChange.toFixed(4);
    console.log(`| ${scenario.padEnd(21)} | ${result.liquidations.toString().padStart(12)} | ${insStr.padStart(11)} | ${riskStr.padStart(9)} |`);
  }

  // Final state
  const { engine: finalEngine } = await getState();
  console.log(`\nFinal state:`);
  console.log(`  Insurance: ${(Number(finalEngine.insuranceFund.balance) / 1e9).toFixed(4)} SOL`);
  console.log(`  Risk reduction mode: ${finalEngine.riskReductionOnly}`);
  console.log(`  Lifetime liquidations: ${finalEngine.lifetimeLiquidations}`);

  // Option to disable authority
  console.log("\nTo disable oracle authority and return to Chainlink:");
  console.log("  Run: ts-node scripts/oracle-authority-stress.ts --disable");

  if (process.argv.includes("--disable")) {
    console.log("\nDisabling oracle authority...");
    await disableOracleAuthority();
    console.log("Oracle authority disabled. Will use Chainlink again.");
  }
}

main().catch(console.error);
