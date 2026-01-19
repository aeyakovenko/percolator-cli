/**
 * Security Audit: Detailed Attack Tests
 *
 * More comprehensive tests with larger positions and detailed logging
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseHeader, parseConfig, parseEngine, parseParams, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
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

async function getState() {
  const data = await fetchSlab(conn, SLAB);
  const vaultInfo = await conn.getAccountInfo(VAULT);
  return {
    header: parseHeader(data),
    config: parseConfig(data),
    engine: parseEngine(data),
    params: parseParams(data),
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
  } catch (e: any) {
    console.log(`  PushPrice failed: ${e.message?.slice(0, 60)}`);
    return false;
  }
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
  } catch (e: any) {
    console.log(`  Crank failed: ${e.message?.slice(0, 60)}`);
    return false;
  }
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
  } catch (e: any) {
    console.log(`  Trade failed: ${e.message?.slice(0, 100)}`);
    return false;
  }
}

async function withdraw(userIdx: number, amount: bigint): Promise<{ success: boolean; error?: string }> {
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
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message?.slice(0, 150) };
  }
}

async function findMyAccounts(): Promise<{users: number[], lps: number[]}> {
  const { data } = await getState();
  const indices = parseUsedIndices(data);
  const users: number[] = [];
  const lps: number[] = [];

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;
    if (acc.owner.equals(payer.publicKey)) {
      if (acc.kind === AccountKind.LP) {
        lps.push(idx);
      } else {
        users.push(idx);
      }
    }
  }
  return { users, lps };
}

async function showAccountState(idx: number, label: string) {
  const { data, config, engine } = await getState();
  const acc = parseAccount(data, idx);
  if (!acc) {
    console.log(`  ${label}: Account ${idx} not found`);
    return;
  }

  const capital = Number(acc.capital) / 1e9;
  const pnl = Number(acc.pnl) / 1e9;
  const posSize = acc.positionSize;
  const entryPrice = Number(acc.entryPriceE6) / 1e6;
  const oraclePrice = Number(config.authorityPriceE6) / 1e6;

  // Calculate unrealized PnL
  // For inverted market: price = 1/SOL, LONG profits when underlying drops
  let unrealizedPnl = 0;
  if (posSize !== 0n) {
    const currentPrice = oraclePrice;
    const priceDiff = currentPrice - entryPrice;
    // In inverted: LONG benefits from price increase (1/SOL going up = SOL going down)
    unrealizedPnl = Number(posSize) * priceDiff / 1e6;
  }

  console.log(`  ${label}:`);
  console.log(`    Capital: ${capital.toFixed(9)} SOL`);
  console.log(`    PnL: ${pnl.toFixed(9)} SOL`);
  console.log(`    Position: ${posSize.toString()} @ entry $${entryPrice.toFixed(6)}`);
  console.log(`    Oracle: $${oraclePrice.toFixed(6)}`);
  console.log(`    Unrealized PnL (calc): ${unrealizedPnl.toFixed(9)} SOL`);
}

async function main() {
  console.log("=== PERCOLATOR SECURITY AUDIT - DETAILED TESTS ===\n");

  // Check initial state
  const { vaultBalance: initialVault, engine: initialEngine, config } = await getState();
  const initialInsurance = Number(initialEngine.insuranceFund.balance) / 1e9;

  console.log("=== INITIAL STATE ===");
  console.log(`Vault: ${initialVault.toFixed(9)} SOL`);
  console.log(`Insurance: ${initialInsurance.toFixed(9)} SOL`);
  console.log(`Oracle Authority Price: $${(Number(config.authorityPriceE6) / 1e6).toFixed(2)}`);
  console.log(`Inverted: ${config.invert === 1}`);

  const { users } = await findMyAccounts();
  if (users.length === 0) {
    console.log("ERROR: No user accounts found for payer");
    return;
  }

  const userIdx = users[0];
  console.log(`\nUsing user account: ${userIdx}`);

  await showAccountState(userIdx, "Initial user state");

  // ==== TEST 1: Large Position Profit Extraction ====
  console.log("\n=== TEST 1: LARGE POSITION PROFIT EXTRACTION ===");

  // Reset price to $150
  console.log("\nStep 1: Set baseline price to $150");
  await pushPrice(150);
  await crank();
  await showAccountState(userIdx, "After price set");

  // Open a larger position - 1,000,000 units LONG
  // In inverted market: LONG profits when price (1/SOL) goes UP (SOL goes down)
  console.log("\nStep 2: Open LARGE LONG position (1000000 units)");
  const tradeSuccess = await trade(userIdx, 0, 1000000n);
  if (!tradeSuccess) {
    console.log("Trade failed - checking account state");
    await showAccountState(userIdx, "After failed trade");
  } else {
    await showAccountState(userIdx, "After opening LONG");
  }

  // Manipulate price UP (in inverted, this means SOL dropped, LONG profits)
  console.log("\nStep 3: Push price UP to $300 (simulating 50% SOL crash)");
  await pushPrice(300);
  await crank();
  await showAccountState(userIdx, "After price manipulation");

  // Check if we have profit
  const { data: dataAfterManip } = await getState();
  const accAfterManip = parseAccount(dataAfterManip, userIdx);
  const capitalAfterManip = accAfterManip ? Number(accAfterManip.capital) / 1e9 : 0;

  // Close position
  console.log("\nStep 4: Close position");
  await trade(userIdx, 0, -1000000n);
  await showAccountState(userIdx, "After closing position");

  // Check final capital
  const { data: dataAfterClose, vaultBalance: vaultAfterClose, engine: engineAfterClose } = await getState();
  const accAfterClose = parseAccount(dataAfterClose, userIdx);
  const finalCapital = accAfterClose ? Number(accAfterClose.capital) / 1e9 : 0;
  const insuranceAfterClose = Number(engineAfterClose.insuranceFund.balance) / 1e9;

  console.log("\n=== PROFIT EXTRACTION ATTEMPT ===");
  console.log(`Initial capital: ~2.0 SOL (deposited)`);
  console.log(`Final capital: ${finalCapital.toFixed(9)} SOL`);
  console.log(`Vault before: ${initialVault.toFixed(9)} SOL`);
  console.log(`Vault after close: ${vaultAfterClose.toFixed(9)} SOL`);
  console.log(`Insurance before: ${initialInsurance.toFixed(9)} SOL`);
  console.log(`Insurance after: ${insuranceAfterClose.toFixed(9)} SOL`);

  // Try to withdraw everything
  console.log("\nStep 5: Attempt to withdraw all capital");
  const withdrawAmount = BigInt(Math.floor(finalCapital * 1e9));
  console.log(`Attempting withdrawal of ${withdrawAmount} lamports (${finalCapital.toFixed(6)} SOL)`);

  const withdrawResult = await withdraw(userIdx, withdrawAmount);
  if (withdrawResult.success) {
    console.log("WITHDRAWAL SUCCEEDED!");
  } else {
    console.log(`Withdrawal failed: ${withdrawResult.error}`);
  }

  // Final state check
  const { vaultBalance: finalVault, engine: finalEngine } = await getState();
  const finalInsurance = Number(finalEngine.insuranceFund.balance) / 1e9;

  console.log("\n=== FINAL RESULTS ===");
  console.log(`Vault: ${initialVault.toFixed(9)} -> ${finalVault.toFixed(9)} SOL`);
  console.log(`Vault change: ${(finalVault - initialVault).toFixed(9)} SOL`);
  console.log(`Insurance: ${initialInsurance.toFixed(9)} -> ${finalInsurance.toFixed(9)} SOL`);
  console.log(`Insurance change: ${(finalInsurance - initialInsurance).toFixed(9)} SOL`);

  // Security check
  const vaultDrained = initialVault - finalVault;
  const maxLegitimate = finalCapital + (initialInsurance - finalInsurance);
  console.log(`\n=== SECURITY CHECK ===`);
  console.log(`Amount drained from vault: ${vaultDrained.toFixed(9)} SOL`);
  console.log(`User realized capital: ${finalCapital.toFixed(9)} SOL`);
  console.log(`Insurance used: ${(initialInsurance - finalInsurance).toFixed(9)} SOL`);
  console.log(`Max legitimate withdrawal: ${maxLegitimate.toFixed(9)} SOL`);

  if (vaultDrained > maxLegitimate + 0.001) {
    console.log("\n*** VULNERABILITY FOUND: More withdrawn than legitimate ***");
  } else {
    console.log("\n*** SECURITY VERIFIED: Cannot withdraw more than legitimate amount ***");
  }

  // Restore price
  console.log("\nRestoring price to $150...");
  await pushPrice(150);
  await crank();
}

main().catch(console.error);
