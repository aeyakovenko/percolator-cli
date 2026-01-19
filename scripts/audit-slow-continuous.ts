/**
 * Security Audit: Slow Continuous Attack Loop
 *
 * Rate-limit friendly version with proper delays.
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseConfig, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeTradeCpi, encodeWithdrawCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_TRADE_CPI, ACCOUNTS_WITHDRAW_COLLATERAL } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);
const MINT = new PublicKey(marketInfo.mint);
const MATCHER_PROGRAM = new PublicKey(marketInfo.matcherProgramId);
const MATCHER_CTX = new PublicKey(marketInfo.lp.matcherContext);
const LP_PDA = new PublicKey(marketInfo.lp.pda);

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")))
);

const DELAY_MS = 2000; // 2 second delay between operations

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
    config: parseConfig(data),
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
  } catch { return false; }
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

async function trade(userIdx: number, lpIdx: number, size: bigint): Promise<boolean> {
  await delay();
  const tradeData = encodeTradeCpi({ userIdx, lpIdx, size });
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
    MATCHER_PROGRAM, MATCHER_CTX, LP_PDA,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
}

async function withdraw(userIdx: number, amount: bigint): Promise<boolean> {
  await delay();
  const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);
  const vaultPda = new PublicKey(marketInfo.vaultPda);
  const withdrawData = encodeWithdrawCollateral({ idx: userIdx, amount });
  const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
    payer.publicKey, SLAB, VAULT, userAta, vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch { return false; }
}

interface AttackResult {
  name: string;
  vaultDelta: number;
  insuranceDelta: number;
  notes: string;
}

const results: AttackResult[] = [];
let iteration = 0;

async function attack_ManipulateAndExtract(userIdx: number): Promise<AttackResult> {
  const { vaultBalance: v1, engine: e1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;

  // Set price, crank
  await pushPrice(150);
  await crank();
  await crank();

  // Open position
  await trade(userIdx, 0, 2000000n);
  await crank();

  // Manipulate price up
  await pushPrice(300);
  await crank();
  await crank();

  // Close position
  await trade(userIdx, 0, -2000000n);
  await crank();

  // Try max withdrawal
  const maxWithdraw = 100000000n; // 0.1 SOL
  await withdraw(userIdx, maxWithdraw);

  await pushPrice(150);
  await crank();

  const { vaultBalance: v2, engine: e2 } = await getState();
  const ins2 = Number(e2.insuranceFund.balance) / 1e9;

  return {
    name: "Manipulate & Extract",
    vaultDelta: v2 - v1,
    insuranceDelta: ins2 - ins1,
    notes: `Price 150->300->150, attempted 0.1 SOL withdraw`
  };
}

async function attack_FlashCrashLiquidation(userIdx: number): Promise<AttackResult> {
  const { vaultBalance: v1, engine: e1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;
  const liq1 = Number(e1.lifetimeLiquidations);

  await pushPrice(150);
  await crank();

  // Open large position
  await trade(userIdx, 0, 5000000n);
  await crank();

  // Flash crash
  await pushPrice(10);
  await crank();
  await crank();
  await crank();

  // Recovery
  await pushPrice(150);
  await crank();

  // Close if open
  const { data, engine: e2 } = await getState();
  const acc = parseAccount(data, userIdx);
  if (acc && acc.positionSize !== 0n) {
    await trade(userIdx, 0, -acc.positionSize);
    await crank();
  }

  const { vaultBalance: v2, engine: e3 } = await getState();
  const ins2 = Number(e3.insuranceFund.balance) / 1e9;
  const liq2 = Number(e3.lifetimeLiquidations);

  return {
    name: "Flash Crash",
    vaultDelta: v2 - v1,
    insuranceDelta: ins2 - ins1,
    notes: `Liquidations: ${liq1} -> ${liq2}`
  };
}

async function attack_ExtremePrices(userIdx: number): Promise<AttackResult> {
  const { vaultBalance: v1, engine: e1 } = await getState();
  const ins1 = Number(e1.insuranceFund.balance) / 1e9;

  const prices = [0.01, 1000000, 0.001, 100000];
  let accepted = 0;

  for (const p of prices) {
    const ok = await pushPrice(p);
    if (ok) {
      accepted++;
      await crank();
    }
  }

  await pushPrice(150);
  await crank();

  const { vaultBalance: v2, engine: e2 } = await getState();
  const ins2 = Number(e2.insuranceFund.balance) / 1e9;

  return {
    name: "Extreme Prices",
    vaultDelta: v2 - v1,
    insuranceDelta: ins2 - ins1,
    notes: `Extreme prices accepted: ${accepted}/${prices.length}`
  };
}

async function runIteration() {
  iteration++;
  log(`\n========== ITERATION ${iteration} ==========`);

  const { data, vaultBalance, engine } = await getState();
  log(`Vault: ${vaultBalance.toFixed(6)} SOL, Insurance: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(6)} SOL`);

  // Find user
  const indices = parseUsedIndices(data);
  let userIdx = -1;
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc && acc.kind === AccountKind.User && acc.owner.equals(payer.publicKey)) {
      userIdx = idx;
      break;
    }
  }

  if (userIdx < 0) {
    log("No user account!");
    return;
  }

  // Run cranks
  log("Running cranks...");
  await crank();
  await crank();

  // Pick attack
  const attacks = [
    attack_ManipulateAndExtract,
    attack_FlashCrashLiquidation,
    attack_ExtremePrices,
  ];

  const attackFn = attacks[iteration % attacks.length];
  log(`Attack: ${attackFn.name}`);

  try {
    const result = await attackFn(userIdx);
    results.push(result);

    log(`Result: vault Δ=${result.vaultDelta.toFixed(6)}, insurance Δ=${result.insuranceDelta.toFixed(6)}`);
    log(`Notes: ${result.notes}`);

    // Check for vulnerabilities
    if (result.vaultDelta < -0.1) {
      log(`*** WARNING: Vault drained by ${(-result.vaultDelta).toFixed(6)} SOL ***`);
    }
    if (result.insuranceDelta < -0.1) {
      log(`*** WARNING: Insurance drained by ${(-result.insuranceDelta).toFixed(6)} SOL ***`);
    }
  } catch (e: any) {
    log(`Attack error: ${e.message?.slice(0, 80)}`);
  }

  // Save logs
  if (iteration % 3 === 0) {
    fs.writeFileSync("audit-slow-logs.json", JSON.stringify(results, null, 2));
    log("Logs saved");
  }
}

async function main() {
  log("=== SLOW CONTINUOUS AUDIT ===");

  const { vaultBalance, engine } = await getState();
  log(`Initial vault: ${vaultBalance.toFixed(9)} SOL`);
  log(`Initial insurance: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(9)} SOL`);

  while (true) {
    try {
      await runIteration();
    } catch (e: any) {
      log(`Iteration error: ${e.message?.slice(0, 80)}`);
      await delay(10000); // Extra delay on error
    }

    // Wait between iterations
    log("Waiting 60 seconds...");
    await delay(60000);
  }
}

main().catch(console.error);
