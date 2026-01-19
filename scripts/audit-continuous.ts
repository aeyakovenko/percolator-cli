/**
 * Security Audit: Continuous Attack Loop
 *
 * Runs indefinitely, keeping cranks fresh and trying various attack vectors.
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

interface AttackLog {
  timestamp: string;
  attack: string;
  result: string;
  vaultBefore: number;
  vaultAfter: number;
  insuranceBefore: number;
  insuranceAfter: number;
  notes: string;
}

const attackLogs: AttackLog[] = [];
let iteration = 0;

async function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function getState() {
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

async function findMaxWithdraw(idx: number, maxAmount: bigint): Promise<bigint> {
  let lo = 1n;
  let hi = maxAmount;
  let maxSuccess = 0n;

  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);
    const vaultPda = new PublicKey(marketInfo.vaultPda);
    const withdrawData = encodeWithdrawCollateral({ idx, amount: mid });
    const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
      payer.publicKey, SLAB, VAULT, userAta, vaultPda, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
    ]);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData })
    );

    try {
      const sim = await conn.simulateTransaction(tx, [payer]);
      if (!sim.value.err) {
        maxSuccess = mid;
        lo = mid + 1n;
      } else {
        hi = mid - 1n;
      }
    } catch {
      hi = mid - 1n;
    }
  }
  return maxSuccess;
}

// Attack 1: Price oscillation and profit extraction
async function attack_PriceOscillation(userIdx: number): Promise<AttackLog> {
  const { vaultBalance: vaultBefore, engine: engineBefore } = await getState();
  const insuranceBefore = Number(engineBefore.insuranceFund.balance) / 1e9;

  const prices = [150, 50, 250, 30, 300, 20, 200, 150];
  let profitExtracted = 0;

  for (const price of prices) {
    await pushPrice(price);
    await crank();

    // Try to open/close positions at each price
    await trade(userIdx, 0, 1000000n);
    await crank();
    await trade(userIdx, 0, -1000000n);
    await crank();

    // Try withdrawal
    const maxW = await findMaxWithdraw(userIdx, 1000000000n);
    if (maxW > 0n) {
      const success = await withdraw(userIdx, maxW);
      if (success) profitExtracted += Number(maxW) / 1e9;
    }
  }

  await pushPrice(150);
  await crank();

  const { vaultBalance: vaultAfter, engine: engineAfter } = await getState();
  const insuranceAfter = Number(engineAfter.insuranceFund.balance) / 1e9;

  return {
    timestamp: new Date().toISOString(),
    attack: "Price Oscillation",
    result: profitExtracted > 0.01 ? "EXTRACTED" : "BLOCKED",
    vaultBefore, vaultAfter,
    insuranceBefore, insuranceAfter,
    notes: `Extracted: ${profitExtracted.toFixed(6)} SOL`
  };
}

// Attack 2: Flash crash liquidation
async function attack_FlashCrash(userIdx: number): Promise<AttackLog> {
  const { vaultBalance: vaultBefore, engine: engineBefore } = await getState();
  const insuranceBefore = Number(engineBefore.insuranceFund.balance) / 1e9;
  const liqBefore = Number(engineBefore.lifetimeLiquidations);

  // Open large position
  await pushPrice(150);
  await crank();
  await trade(userIdx, 0, 5000000n);
  await crank();

  // Flash crash
  await pushPrice(5);
  for (let i = 0; i < 16; i++) await crank();

  // Check for liquidations
  const { engine: engineMid } = await getState();
  const liqMid = Number(engineMid.lifetimeLiquidations);

  // Recover
  await pushPrice(150);
  for (let i = 0; i < 16; i++) await crank();

  // Close position if still open
  const { data } = await getState();
  const acc = parseAccount(data, userIdx);
  if (acc && acc.positionSize !== 0n) {
    await trade(userIdx, 0, -acc.positionSize);
  }

  const { vaultBalance: vaultAfter, engine: engineAfter } = await getState();
  const insuranceAfter = Number(engineAfter.insuranceFund.balance) / 1e9;
  const liqAfter = Number(engineAfter.lifetimeLiquidations);

  return {
    timestamp: new Date().toISOString(),
    attack: "Flash Crash",
    result: liqAfter > liqBefore ? "LIQUIDATION" : "SURVIVED",
    vaultBefore, vaultAfter,
    insuranceBefore, insuranceAfter,
    notes: `Liquidations: ${liqBefore} -> ${liqAfter}, Insurance Δ: ${(insuranceAfter - insuranceBefore).toFixed(6)}`
  };
}

// Attack 3: Extreme leverage
async function attack_ExtremeLeverage(userIdx: number): Promise<AttackLog> {
  const { vaultBalance: vaultBefore, engine: engineBefore, data } = await getState();
  const insuranceBefore = Number(engineBefore.insuranceFund.balance) / 1e9;

  const acc = parseAccount(data, userIdx);
  const capital = acc ? Number(acc.capital) : 0;

  // Try increasingly large positions
  await pushPrice(150);
  await crank();

  let maxPosition = 0n;
  for (const size of [1000000n, 5000000n, 10000000n, 50000000n, 100000000n]) {
    const success = await trade(userIdx, 0, size);
    if (success) {
      maxPosition = size;
      await trade(userIdx, 0, -size); // Close
    } else {
      break;
    }
  }

  const { vaultBalance: vaultAfter, engine: engineAfter } = await getState();
  const insuranceAfter = Number(engineAfter.insuranceFund.balance) / 1e9;

  return {
    timestamp: new Date().toISOString(),
    attack: "Extreme Leverage",
    result: maxPosition > 10000000n ? "HIGH_LEVERAGE" : "LIMITED",
    vaultBefore, vaultAfter,
    insuranceBefore, insuranceAfter,
    notes: `Max position: ${maxPosition.toString()}, Capital: ${(capital / 1e9).toFixed(6)}`
  };
}

// Attack 4: Sandwich attack simulation
async function attack_Sandwich(userIdx: number): Promise<AttackLog> {
  const { vaultBalance: vaultBefore, engine: engineBefore } = await getState();
  const insuranceBefore = Number(engineBefore.insuranceFund.balance) / 1e9;

  // Front-run: manipulate price
  await pushPrice(100);
  await crank();

  // Victim trade (simulated as our own trade)
  await trade(userIdx, 0, 2000000n);
  await crank();

  // Back-run: reverse price
  await pushPrice(200);
  await crank();

  // Close position
  await trade(userIdx, 0, -2000000n);
  await crank();

  // Try to extract
  const maxW = await findMaxWithdraw(userIdx, 500000000n);
  let extracted = 0;
  if (maxW > 0n) {
    const success = await withdraw(userIdx, maxW);
    if (success) extracted = Number(maxW) / 1e9;
  }

  await pushPrice(150);
  await crank();

  const { vaultBalance: vaultAfter, engine: engineAfter } = await getState();
  const insuranceAfter = Number(engineAfter.insuranceFund.balance) / 1e9;

  return {
    timestamp: new Date().toISOString(),
    attack: "Sandwich",
    result: extracted > 0.01 ? "EXTRACTED" : "BLOCKED",
    vaultBefore, vaultAfter,
    insuranceBefore, insuranceAfter,
    notes: `Extracted: ${extracted.toFixed(6)} SOL`
  };
}

async function runIteration() {
  iteration++;
  await log(`\n========== ITERATION ${iteration} ==========`);

  // Run cranks to keep state fresh
  await log("Running cranks...");
  for (let i = 0; i < 16; i++) {
    await crank();
  }

  // Find user account
  const { data } = await getState();
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
    await log("No user account found!");
    return;
  }

  // Pick a random attack
  const attacks = [
    attack_PriceOscillation,
    attack_FlashCrash,
    attack_ExtremeLeverage,
    attack_Sandwich,
  ];

  const attackFn = attacks[iteration % attacks.length];
  await log(`Running attack: ${attackFn.name}`);

  try {
    const result = await attackFn(userIdx);
    attackLogs.push(result);

    await log(`Result: ${result.result}`);
    await log(`Vault: ${result.vaultBefore.toFixed(6)} -> ${result.vaultAfter.toFixed(6)}`);
    await log(`Insurance: ${result.insuranceBefore.toFixed(6)} -> ${result.insuranceAfter.toFixed(6)}`);
    await log(`Notes: ${result.notes}`);

    // Check for vulnerabilities
    const vaultDrain = result.vaultBefore - result.vaultAfter;
    if (vaultDrain > 0.1) {
      await log(`*** WARNING: Significant vault drain: ${vaultDrain.toFixed(6)} SOL ***`);
    }

    const insuranceDrain = result.insuranceBefore - result.insuranceAfter;
    if (insuranceDrain > 0.1) {
      await log(`*** WARNING: Significant insurance drain: ${insuranceDrain.toFixed(6)} SOL ***`);
    }

  } catch (e: any) {
    await log(`Attack failed with error: ${e.message?.slice(0, 100)}`);
  }

  // Save logs periodically
  if (iteration % 5 === 0) {
    fs.writeFileSync("audit-attack-logs.json", JSON.stringify(attackLogs, null, 2));
    await log("Logs saved to audit-attack-logs.json");
  }
}

async function main() {
  await log("=== CONTINUOUS SECURITY AUDIT STARTED ===");
  await log(`Slab: ${SLAB.toBase58()}`);
  await log(`Oracle: ${ORACLE.toBase58()}`);

  // Initial state
  const { vaultBalance, engine } = await getState();
  await log(`Initial vault: ${vaultBalance.toFixed(9)} SOL`);
  await log(`Initial insurance: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(9)} SOL`);

  // Run continuously
  while (true) {
    try {
      await runIteration();
    } catch (e: any) {
      await log(`Iteration error: ${e.message?.slice(0, 100)}`);
    }

    // Wait between iterations
    await log("Waiting 30 seconds...");
    await new Promise(r => setTimeout(r, 30000));
  }
}

main().catch(console.error);
