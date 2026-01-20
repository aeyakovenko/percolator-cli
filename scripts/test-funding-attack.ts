/**
 * Test Funding Rate Manipulation Attack
 *
 * The funding rate could be manipulated via:
 * 1. Oracle price manipulation creating funding imbalance
 * 2. Large position imbalances
 * 3. Rapid price oscillations affecting funding accrual
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { fetchSlab, parseEngine, parseConfig, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE } from "../src/abi/accounts.js";
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

const DELAY_MS = 1500;

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
    config: parseConfig(data),
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

async function main() {
  log("=== FUNDING RATE MANIPULATION ATTACK ===\n");

  // Initial state
  const { vaultBalance: v1, engine: e1, config: c1, data: data1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;

  log(`Initial State:`);
  log(`  Vault: ${v1.toFixed(6)} SOL`);
  log(`  Insurance: ${ins1.toFixed(9)} SOL`);
  log(`  Funding Index (QpbE6): ${e1.fundingIndexQpbE6.toString()}`);
  log(`  Last Funding Slot: ${e1.lastFundingSlot.toString()}`);
  log(`  Current Slot: ${e1.currentSlot.toString()}`);
  log(`  Net LP Position: ${e1.netLpPos.toString()}`);
  log(`  Total OI: ${e1.totalOpenInterest.toString()}`);

  log(`\nFunding Config:`);
  log(`  Horizon Slots: ${c1.fundingHorizonSlots.toString()}`);
  log(`  K BPS: ${c1.fundingKBps.toString()}`);
  log(`  Inv Scale Notional E6: ${c1.fundingInvScaleNotionalE6.toString()}`);
  log(`  Max Premium BPS: ${c1.fundingMaxPremiumBps.toString()}`);
  log(`  Max BPS Per Slot: ${c1.fundingMaxBpsPerSlot.toString()}`);

  // Check account funding indices
  const indices = parseUsedIndices(data1);
  log(`\nAccount Funding Indices:`);
  for (const idx of indices) {
    const acc = parseAccount(data1, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      log(`  [${idx}] ${kind}: fundingIdx=${acc.fundingIndex.toString()} pos=${acc.positionSize.toString()}`);
    }
  }

  // ===== ATTACK 1: Extreme Price to Skew Funding =====
  log("\n=== ATTACK 1: Extreme Price to Skew Funding ===");

  // Push price very high to create large premium
  log("Pushing price to $10000 (extreme premium)...");
  await pushPrice(10000);
  for (let i = 0; i < 5; i++) await crank();

  const { engine: e2 } = await getState();
  log(`After price spike:`);
  log(`  Funding Index: ${e1.fundingIndexQpbE6.toString()} -> ${e2.fundingIndexQpbE6.toString()}`);
  log(`  Change: ${(Number(e2.fundingIndexQpbE6) - Number(e1.fundingIndexQpbE6)).toString()}`);

  // ===== ATTACK 2: Rapid Oscillation =====
  log("\n=== ATTACK 2: Rapid Price Oscillation ===");

  for (let i = 0; i < 10; i++) {
    const highPrice = 500 + Math.random() * 500;
    const lowPrice = 50 + Math.random() * 50;

    await pushPrice(highPrice);
    await crank();
    await pushPrice(lowPrice);
    await crank();
  }

  const { engine: e3 } = await getState();
  log(`After oscillation:`);
  log(`  Funding Index: ${e2.fundingIndexQpbE6.toString()} -> ${e3.fundingIndexQpbE6.toString()}`);

  // ===== ATTACK 3: Extended Period at Extreme Price =====
  log("\n=== ATTACK 3: Extended Extreme Price ===");
  log("Holding price at $0.01 for multiple cranks...");

  await pushPrice(0.01);
  for (let i = 0; i < 20; i++) {
    await crank();
    if (i % 5 === 0) {
      const { engine: eTemp } = await getState();
      log(`  Crank ${i}: Funding Index = ${eTemp.fundingIndexQpbE6.toString()}`);
    }
  }

  // ===== FINAL STATE =====
  log("\n=== FINAL STATE ===");
  await pushPrice(150);
  for (let i = 0; i < 5; i++) await crank();

  const { vaultBalance: v2, engine: e4, data: data4 } = await getState();
  const ins2 = Number(e4.insuranceFund.balance) / 1e9;

  log(`Vault: ${v1.toFixed(6)} -> ${v2.toFixed(6)} (Δ = ${(v2 - v1).toFixed(6)})`);
  log(`Insurance: ${ins1.toFixed(9)} -> ${ins2.toFixed(9)}`);
  log(`Funding Index: ${e1.fundingIndexQpbE6.toString()} -> ${e4.fundingIndexQpbE6.toString()}`);

  // Check if funding changes affected account PnL
  log("\nFinal Account States:");
  for (const idx of indices) {
    const accBefore = parseAccount(data1, idx);
    const accAfter = parseAccount(data4, idx);
    if (accBefore && accAfter) {
      const kind = accAfter.kind === AccountKind.LP ? 'LP' : 'USER';
      const capitalChange = Number(accAfter.capital) - Number(accBefore.capital);
      const pnlBefore = Number(accBefore.pnl) > 9e18 ? Number(accBefore.pnl) - 18446744073709551616 : Number(accBefore.pnl);
      const pnlAfter = Number(accAfter.pnl) > 9e18 ? Number(accAfter.pnl) - 18446744073709551616 : Number(accAfter.pnl);
      const pnlChange = pnlAfter - pnlBefore;

      log(`  [${idx}] ${kind}:`);
      log(`    Capital: ${capitalChange !== 0 ? `Δ=${(capitalChange / 1e9).toFixed(9)}` : 'unchanged'}`);
      log(`    PnL: ${pnlChange !== 0 ? `Δ=${(pnlChange / 1e9).toFixed(9)}` : 'unchanged'}`);
      log(`    Funding Index: ${accBefore.fundingIndex.toString()} -> ${accAfter.fundingIndex.toString()}`);
    }
  }

  // Solvency check
  log("\n=== SOLVENCY CHECK ===");
  let totalLiabilities = e4.insuranceFund.balance;
  for (const idx of indices) {
    const acc = parseAccount(data4, idx);
    if (acc) {
      totalLiabilities += acc.capital;
      let pnl = acc.pnl;
      if (Number(pnl) > 9e18) pnl = pnl - 18446744073709551616n;
      totalLiabilities += pnl;
    }
  }
  const liabilitiesNum = Number(totalLiabilities) / 1e9;
  log(`Total Liabilities: ${liabilitiesNum.toFixed(6)} SOL`);
  log(`Vault Balance: ${v2.toFixed(6)} SOL`);
  log(`Status: ${v2 >= liabilitiesNum ? "SOLVENT" : "*** INSOLVENT ***"}`);

  if (Math.abs(v2 - v1) > 0.001) {
    log("\n*** VAULT CHANGE DETECTED ***");
  } else {
    log("\nFunding manipulation did not affect vault balance");
  }
}

main().catch(console.error);
