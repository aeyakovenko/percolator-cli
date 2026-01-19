/**
 * Security Audit: Force Liquidation Attack
 *
 * Try to force liquidations using:
 * 1. Direct liquidateAtOracle instruction
 * 2. Extreme price crashes
 * 3. Exploit any bad debt scenarios
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeLiquidateAtOracle } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_LIQUIDATE_AT_ORACLE } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const DELAY_MS = 2000;

async function delay(ms: number = DELAY_MS) {
  await new Promise(r => setTimeout(r, ms));
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function getState() {
  await delay(500);
  const data = await fetchSlab(conn, SLAB);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return {
    engine: parseEngine(data),
    data,
    vaultBalance: vaultInfo ? vaultInfo.lamports / 1e9 : 0,
  };
}

async function pushPrice(priceUsd: number): Promise<boolean> {
  await delay();
  const priceE6 = BigInt(Math.round(priceUsd * 1_000_000));
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const data = encodePushOraclePrice({ priceE6, timestamp });
  const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [payer.publicKey, SLAB]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    buildIx({ programId: PROGRAM_ID, keys, data })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e: any) {
    log(`PushPrice ${priceUsd} failed: ${e.message?.slice(0, 50)}`);
    return false;
  }
}

async function crank(): Promise<boolean> {
  await delay();
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
}

async function liquidateAtOracle(userIdx: number, lpIdx: number): Promise<boolean> {
  await delay();
  const liqData = encodeLiquidateAtOracle({ userIdx, lpIdx });

  // Check ACCOUNTS_LIQUIDATE_AT_ORACLE for required accounts
  let liqKeys;
  try {
    liqKeys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
      payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
    ]);
  } catch (e: any) {
    log(`Building liquidation keys failed: ${e.message?.slice(0, 80)}`);
    return false;
  }

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    buildIx({ programId: PROGRAM_ID, keys: liqKeys, data: liqData })
  );

  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    log(`Liquidation TX: ${sig}`);
    return true;
  } catch (e: any) {
    log(`Liquidation failed: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

async function main() {
  log("=== FORCE LIQUIDATION ATTACK TEST ===\n");

  // Initial state
  const { vaultBalance: v1, engine: e1, data: data1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;
  const liq1 = Number(e1.lifetimeLiquidations);

  log(`Initial State:`);
  log(`  Vault: ${v1.toFixed(6)} SOL`);
  log(`  Insurance: ${ins1.toFixed(6)} SOL`);
  log(`  Lifetime liquidations: ${liq1}`);

  // Find all accounts
  const indices = parseUsedIndices(data1);
  const users: number[] = [];
  const lps: number[] = [];

  log(`\nAccounts:`);
  for (const idx of indices) {
    const acc = parseAccount(data1, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      const capital = (Number(acc.capital) / 1e9).toFixed(6);
      log(`  [${idx}] ${kind}: capital=${capital} pos=${acc.positionSize}`);

      if (acc.kind === AccountKind.LP) lps.push(idx);
      else users.push(idx);
    }
  }

  // ATTACK 1: Try to liquidate each user at different prices
  log("\n=== ATTACK 1: Direct Liquidation Calls ===");

  const prices = [1000, 500, 100, 50, 10, 1, 0.1, 0.01];

  for (const price of prices) {
    log(`\nTrying liquidation at $${price}...`);
    await pushPrice(price);
    await crank();

    for (const userIdx of users) {
      for (const lpIdx of lps) {
        log(`  Attempting to liquidate user ${userIdx} against LP ${lpIdx}...`);
        const result = await liquidateAtOracle(userIdx, lpIdx);
        if (result) {
          log(`  *** LIQUIDATION SUCCEEDED! ***`);
          const { engine } = await getState();
          log(`  New liquidation count: ${engine.lifetimeLiquidations}`);
        }
      }
    }

    await crank();
  }

  // ATTACK 2: Extreme price crash and many cranks
  log("\n=== ATTACK 2: Extreme Crash + Heavy Cranking ===");

  await pushPrice(0.001);
  log("Price crashed to $0.001");

  for (let i = 0; i < 30; i++) {
    const crankResult = await crank();
    if (i % 10 === 0) {
      const { engine } = await getState();
      log(`  Crank ${i}: liquidations=${engine.lifetimeLiquidations}`);
    }
  }

  // ATTACK 3: Price spike
  log("\n=== ATTACK 3: Extreme Price Spike ===");

  await pushPrice(10000000);
  log("Price spiked to $10M");

  for (let i = 0; i < 20; i++) {
    await crank();
  }

  const { engine: e2 } = await getState();
  log(`Liquidations after spike: ${e2.lifetimeLiquidations}`);

  // Final state
  log("\n=== FINAL STATE ===");
  await pushPrice(150);
  for (let i = 0; i < 10; i++) await crank();

  const { vaultBalance: v2, engine: e3, data: data2 } = await getState();
  const ins2 = Number(e3.insuranceFund.balance) / 1e9;
  const liq2 = Number(e3.lifetimeLiquidations);

  log(`Vault: ${v1.toFixed(6)} -> ${v2.toFixed(6)} (Δ = ${(v2 - v1).toFixed(6)})`);
  log(`Insurance: ${ins1.toFixed(6)} -> ${ins2.toFixed(6)} (Δ = ${(ins2 - ins1).toFixed(6)})`);
  log(`Liquidations: ${liq1} -> ${liq2}`);

  log("\nFinal account states:");
  for (const idx of indices) {
    const acc = parseAccount(data2, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      const capital = (Number(acc.capital) / 1e9).toFixed(6);
      log(`  [${idx}] ${kind}: capital=${capital} pos=${acc.positionSize}`);
    }
  }

  // Summary
  log("\n=== SUMMARY ===");
  if (liq2 > liq1) {
    log(`*** LIQUIDATIONS TRIGGERED: ${liq2 - liq1} ***`);
  } else {
    log("No liquidations triggered - accounts protected");
  }

  if (v2 < v1 - 0.01) {
    log("*** WARNING: Vault drained! ***");
  } else {
    log("Vault protected");
  }

  if (ins2 < ins1 - 0.01) {
    log("*** WARNING: Insurance drained! ***");
  } else {
    log("Insurance protected");
  }
}

main().catch(console.error);
