/**
 * Account Manipulation Attack Tests
 *
 * Test vectors:
 * 1. Account index confusion attacks
 * 2. Unauthorized withdrawal from other accounts
 * 3. Close account exploitation
 * 4. TradeNoCpi bypass attempts
 * 5. Double spend / double close attacks
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { fetchSlab, parseEngine, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeWithdrawCollateral, encodeCloseAccount, encodeTradeNoCpi, encodeLiquidateAtOracle, encodeKeeperCrank, encodePushOraclePrice } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_CLOSE_ACCOUNT, ACCOUNTS_TRADE_NOCPI, ACCOUNTS_LIQUIDATE_AT_ORACLE, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const PROGRAM_ID = new PublicKey(marketInfo.programId);
const SLAB = new PublicKey(marketInfo.slab);
const ORACLE = new PublicKey(marketInfo.oracle);
const VAULT = new PublicKey(marketInfo.vault);
const VAULT_PDA = new PublicKey(marketInfo.vaultPda);
const MINT = new PublicKey(marketInfo.mint);

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

interface AttackResult {
  name: string;
  success: boolean;
  vaultChange: number;
  notes: string;
}

const results: AttackResult[] = [];

// Attack 1: Try to withdraw from another user's account index
async function attack_IndexConfusionWithdraw(): Promise<AttackResult> {
  const name = "Index Confusion Withdraw";
  log(`\n=== ${name} ===`);

  const { vaultBalance: v1 } = await getState();
  const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);

  // Try to withdraw from index 2 (another user's account)
  const withdrawData = encodeWithdrawCollateral({ userIdx: 2, amount: 100_000_000n });
  const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
    payer.publicKey, SLAB, VAULT, userAta, VAULT_PDA, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData })
  );

  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    const { vaultBalance: v2 } = await getState();
    return { name, success: true, vaultChange: v2 - v1, notes: "VULNERABILITY: Withdrew from other account!" };
  } catch (e: any) {
    return { name, success: false, vaultChange: 0, notes: `REJECTED: ${e.message?.slice(0, 50)}` };
  }
}

// Attack 2: Try to close account with position
async function attack_CloseWithPosition(): Promise<AttackResult> {
  const name = "Close Account With Position";
  log(`\n=== ${name} ===`);

  const { vaultBalance: v1, data } = await getState();
  const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);

  // Find account with position
  let targetIdx = -1;
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc && acc.positionSize !== 0n) {
      targetIdx = idx;
      break;
    }
  }

  if (targetIdx < 0) {
    return { name, success: false, vaultChange: 0, notes: "No account with position to test" };
  }

  const closeData = encodeCloseAccount({ userIdx: targetIdx });
  const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
    payer.publicKey, SLAB, VAULT, userAta, VAULT_PDA, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: closeKeys, data: closeData })
  );

  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    const { vaultBalance: v2 } = await getState();
    return { name, success: true, vaultChange: v2 - v1, notes: "VULNERABILITY: Closed account with position!" };
  } catch (e: any) {
    return { name, success: false, vaultChange: 0, notes: `REJECTED: ${e.message?.slice(0, 50)}` };
  }
}

// Attack 3: Try TradeNoCpi without LP signature
async function attack_TradeNoCpiBypass(): Promise<AttackResult> {
  const name = "TradeNoCpi Signature Bypass";
  log(`\n=== ${name} ===`);

  const { vaultBalance: v1 } = await getState();

  // TradeNoCpi requires both user and LP to sign
  // Try with just payer signing for both
  const tradeData = encodeTradeNoCpi({ lpIdx: 0, userIdx: 1, size: 1_000_000n });
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
    payer.publicKey, payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData })
  );

  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    const { vaultBalance: v2 } = await getState();
    return { name, success: true, vaultChange: v2 - v1, notes: "Trade executed (may be expected if payer owns both)" };
  } catch (e: any) {
    return { name, success: false, vaultChange: 0, notes: `REJECTED: ${e.message?.slice(0, 50)}` };
  }
}

// Attack 4: Try to liquidate LP account
async function attack_LiquidateLP(): Promise<AttackResult> {
  const name = "Liquidate LP Account";
  log(`\n=== ${name} ===`);

  const { vaultBalance: v1 } = await getState();

  // Push extreme low price to make LP "underwater"
  await pushPrice(0.01);
  await crank();

  // Try to liquidate LP (index 0)
  const liqData = encodeLiquidateAtOracle({ targetIdx: 0 });
  const liqKeys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
    payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    buildIx({ programId: PROGRAM_ID, keys: liqKeys, data: liqData })
  );

  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    const { vaultBalance: v2 } = await getState();
    await pushPrice(150); // Reset price
    await crank();
    return { name, success: true, vaultChange: v2 - v1, notes: "VULNERABILITY: Liquidated LP!" };
  } catch (e: any) {
    await pushPrice(150); // Reset price
    await crank();
    return { name, success: false, vaultChange: 0, notes: `REJECTED: ${e.message?.slice(0, 50)}` };
  }
}

// Attack 5: Try to liquidate non-existent account
async function attack_LiquidateInvalidIndex(): Promise<AttackResult> {
  const name = "Liquidate Invalid Index";
  log(`\n=== ${name} ===`);

  const { vaultBalance: v1 } = await getState();

  // Try various invalid indices
  const invalidIndices = [65535, 10000, 999];

  for (const idx of invalidIndices) {
    const liqData = encodeLiquidateAtOracle({ targetIdx: idx });
    const liqKeys = buildAccountMetas(ACCOUNTS_LIQUIDATE_AT_ORACLE, [
      payer.publicKey, SLAB, SYSVAR_CLOCK_PUBKEY, ORACLE,
    ]);

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      buildIx({ programId: PROGRAM_ID, keys: liqKeys, data: liqData })
    );

    try {
      await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
      const { vaultBalance: v2 } = await getState();
      return { name, success: true, vaultChange: v2 - v1, notes: `VULNERABILITY: Liquidated invalid index ${idx}!` };
    } catch {
      // Expected to fail
    }
  }

  return { name, success: false, vaultChange: 0, notes: "All invalid indices rejected" };
}

// Attack 6: Try withdrawal with max u64 amount (overflow)
async function attack_WithdrawOverflow(): Promise<AttackResult> {
  const name = "Withdraw u64 MAX";
  log(`\n=== ${name} ===`);

  const { vaultBalance: v1 } = await getState();
  const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);

  const withdrawData = encodeWithdrawCollateral({ userIdx: 1, amount: 18446744073709551615n });
  const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
    payer.publicKey, SLAB, VAULT, userAta, VAULT_PDA, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData })
  );

  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    const { vaultBalance: v2 } = await getState();
    return { name, success: true, vaultChange: v2 - v1, notes: "VULNERABILITY: Max withdrawal succeeded!" };
  } catch (e: any) {
    return { name, success: false, vaultChange: 0, notes: `REJECTED: ${e.message?.slice(0, 50)}` };
  }
}

// Attack 7: Double withdrawal in same transaction
async function attack_DoubleWithdraw(): Promise<AttackResult> {
  const name = "Double Withdraw Same TX";
  log(`\n=== ${name} ===`);

  const { vaultBalance: v1 } = await getState();
  const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);

  const withdrawData = encodeWithdrawCollateral({ userIdx: 1, amount: 10_000_000n });
  const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
    payer.publicKey, SLAB, VAULT, userAta, VAULT_PDA, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);

  const ix = buildIx({ programId: PROGRAM_ID, keys: withdrawKeys, data: withdrawData });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ix,
    ix // Same instruction twice
  );

  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    const { vaultBalance: v2 } = await getState();
    return { name, success: true, vaultChange: v2 - v1, notes: "Double withdraw executed!" };
  } catch (e: any) {
    return { name, success: false, vaultChange: 0, notes: `REJECTED: ${e.message?.slice(0, 50)}` };
  }
}

// Attack 8: Try to close LP account
async function attack_CloseLP(): Promise<AttackResult> {
  const name = "Close LP Account";
  log(`\n=== ${name} ===`);

  const { vaultBalance: v1 } = await getState();
  const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);

  const closeData = encodeCloseAccount({ userIdx: 0 }); // LP is index 0
  const closeKeys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
    payer.publicKey, SLAB, VAULT, userAta, VAULT_PDA, TOKEN_PROGRAM_ID, SYSVAR_CLOCK_PUBKEY, ORACLE,
  ]);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    buildIx({ programId: PROGRAM_ID, keys: closeKeys, data: closeData })
  );

  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    const { vaultBalance: v2 } = await getState();
    return { name, success: true, vaultChange: v2 - v1, notes: "VULNERABILITY: LP account closed!" };
  } catch (e: any) {
    return { name, success: false, vaultChange: 0, notes: `REJECTED: ${e.message?.slice(0, 50)}` };
  }
}

async function main() {
  log("=== ACCOUNT MANIPULATION ATTACK TESTS ===\n");

  // Run crank first
  await pushPrice(150);
  await crank();

  const { vaultBalance: initialVault, data } = await getState();
  log(`Initial Vault: ${initialVault.toFixed(6)} SOL`);

  // List accounts
  log("\nAccounts:");
  for (const idx of parseUsedIndices(data)) {
    const acc = parseAccount(data, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      log(`  [${idx}] ${kind}: capital=${(Number(acc.capital) / 1e9).toFixed(6)} pos=${acc.positionSize}`);
    }
  }

  // Run all attacks
  results.push(await attack_IndexConfusionWithdraw());
  await delay(3000);

  results.push(await attack_CloseWithPosition());
  await delay(3000);

  results.push(await attack_TradeNoCpiBypass());
  await delay(3000);

  results.push(await attack_LiquidateLP());
  await delay(3000);

  results.push(await attack_LiquidateInvalidIndex());
  await delay(3000);

  results.push(await attack_WithdrawOverflow());
  await delay(3000);

  results.push(await attack_DoubleWithdraw());
  await delay(3000);

  results.push(await attack_CloseLP());
  await delay(3000);

  // Final state
  const { vaultBalance: finalVault, data: finalData } = await getState();

  // Summary
  log("\n" + "=".repeat(60));
  log("ATTACK TEST RESULTS");
  log("=".repeat(60));

  let vulnerabilities = 0;
  for (const r of results) {
    const status = r.success ? "EXPLOITED" : "BLOCKED";
    const marker = r.success && r.vaultChange < 0 ? "***" : "   ";
    log(`${marker} ${r.name}: ${status} (vault Δ=${r.vaultChange.toFixed(6)})`);
    log(`    ${r.notes}`);
    if (r.success && r.vaultChange < 0) vulnerabilities++;
  }

  log("\n" + "=".repeat(60));
  log(`Vault: ${initialVault.toFixed(6)} -> ${finalVault.toFixed(6)} SOL`);
  log(`Total vault change: ${(finalVault - initialVault).toFixed(6)} SOL`);
  log(`Vulnerabilities found: ${vulnerabilities}`);
  log("=".repeat(60));

  // Final accounts
  log("\nFinal Accounts:");
  for (const idx of parseUsedIndices(finalData)) {
    const acc = parseAccount(finalData, idx);
    if (acc) {
      const kind = acc.kind === AccountKind.LP ? 'LP' : 'USER';
      log(`  [${idx}] ${kind}: capital=${(Number(acc.capital) / 1e9).toFixed(6)} pos=${acc.positionSize}`);
    }
  }
}

main().catch(console.error);
