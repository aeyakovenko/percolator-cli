/**
 * Security Audit: Attack Test Script
 *
 * Tests the claim: "Attacker with oracle control cannot withdraw more than
 * user realized losses plus insurance surplus"
 *
 * Attack vectors to test:
 * 1. Create position, manipulate price to profit, withdraw
 * 2. Try to drain LP via unfavorable trades
 * 3. Try to drain insurance fund
 * 4. Flash crash attacks
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseHeader, parseConfig, parseEngine, parseParams, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeTradeCpi, encodeWithdrawCollateral, encodeDepositCollateral } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_TRADE_CPI, ACCOUNTS_WITHDRAW_COLLATERAL, ACCOUNTS_DEPOSIT_COLLATERAL } from "../src/abi/accounts.js";
import { deriveLpPda } from "../src/solana/pda.js";
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

interface AttackResult {
  name: string;
  success: boolean;
  vaultBefore: number;
  vaultAfter: number;
  insuranceBefore: number;
  insuranceAfter: number;
  attackerProfit: number;
  notes: string;
}

const results: AttackResult[] = [];

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
  const tradeData = encodeTradeCpi({
    userIdx,
    lpIdx,
    size
  });
  // Accounts: user, lpOwner, slab, clock, oracle, matcherProg, matcherCtx, lpPda
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    payer.publicKey,  // user
    payer.publicKey,  // lpOwner (payer is LP owner)
    SLAB,
    SYSVAR_CLOCK_PUBKEY,
    ORACLE,
    MATCHER_PROGRAM,
    MATCHER_CTX,
    LP_PDA,
  ]);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData })
  );
  try {
    await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return true;
  } catch (e: any) {
    console.log(`  Trade failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

async function withdraw(userIdx: number, amount: bigint): Promise<boolean> {
  const userAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);
  const vaultPda = new PublicKey(marketInfo.vaultPda);

  const withdrawData = encodeWithdrawCollateral({ idx: userIdx, amount });
  // Order: user, slab, vault, userAta, vaultPda, tokenProgram, clock, oracleIdx
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
  } catch (e: any) {
    console.log(`  Withdraw failed: ${e.message?.slice(0, 80)}`);
    return false;
  }
}

// Find user account indices owned by payer
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

/**
 * ATTACK 1: Oracle Profit Extraction
 * 1. Open a long position at current price
 * 2. Push oracle price up significantly
 * 3. Close position at inflated price
 * 4. Try to withdraw the "profit"
 */
async function attack1_OracleProfitExtraction(): Promise<AttackResult> {
  console.log("\n=== ATTACK 1: Oracle Profit Extraction ===");

  const { vaultBalance: vaultBefore, engine } = await getState();
  const insuranceBefore = Number(engine.insuranceFund.balance) / 1e9;
  const { users, lps } = await findMyAccounts();

  if (users.length === 0) {
    return {
      name: "Oracle Profit Extraction",
      success: false,
      vaultBefore,
      vaultAfter: vaultBefore,
      insuranceBefore,
      insuranceAfter: insuranceBefore,
      attackerProfit: 0,
      notes: "No user accounts available"
    };
  }

  const userIdx = users[0];
  const lpIdx = 0; // LP at index 0

  // Get initial user capital
  const { data: dataBefore } = await getState();
  const userBefore = parseAccount(dataBefore, userIdx);
  const initialCapital = userBefore ? Number(userBefore.capital) / 1e9 : 0;
  console.log(`  User ${userIdx} initial capital: ${initialCapital.toFixed(6)} SOL`);

  // Step 1: Set baseline price and crank
  console.log("  Step 1: Set baseline price $140");
  await pushPrice(140);
  await crank();

  // Step 2: Open a LONG position (buy, positive size)
  // In inverted market: LONG = profit when underlying drops
  console.log("  Step 2: Open LONG position (10000 units)");
  const tradeSuccess = await trade(userIdx, lpIdx, 10000n);
  if (!tradeSuccess) {
    return {
      name: "Oracle Profit Extraction",
      success: false,
      vaultBefore,
      vaultAfter: vaultBefore,
      insuranceBefore,
      insuranceAfter: insuranceBefore,
      attackerProfit: 0,
      notes: "Trade failed to open position"
    };
  }

  // Step 3: Manipulate price DOWN (profit for LONG in inverted)
  console.log("  Step 3: Push price DOWN to $70 (50% crash)");
  await pushPrice(70);
  await crank();

  // Step 4: Close position
  console.log("  Step 4: Close position");
  await trade(userIdx, lpIdx, -10000n);

  // Step 5: Try to withdraw all capital + profit
  const { data: dataAfter, vaultBalance: vaultAfter, engine: engineAfter } = await getState();
  const userAfter = parseAccount(dataAfter, userIdx);
  const finalCapital = userAfter ? Number(userAfter.capital) / 1e9 : 0;
  const insuranceAfter = Number(engineAfter.insuranceFund.balance) / 1e9;

  console.log(`  User ${userIdx} final capital: ${finalCapital.toFixed(6)} SOL`);
  console.log(`  Apparent profit: ${(finalCapital - initialCapital).toFixed(6)} SOL`);

  // Try to withdraw
  console.log("  Step 5: Attempt full withdrawal");
  const withdrawAmount = BigInt(Math.floor(finalCapital * 1e9));
  const withdrawSuccess = await withdraw(userIdx, withdrawAmount);

  const { vaultBalance: vaultFinal, engine: engineFinal } = await getState();
  const attackerProfit = vaultBefore - vaultFinal;

  // Restore price
  await pushPrice(140);
  await crank();

  return {
    name: "Oracle Profit Extraction",
    success: withdrawSuccess,
    vaultBefore,
    vaultAfter: vaultFinal,
    insuranceBefore,
    insuranceAfter: Number(engineFinal.insuranceFund.balance) / 1e9,
    attackerProfit,
    notes: withdrawSuccess
      ? `Withdrew ${withdrawAmount.toString()} lamports. Profit: ${attackerProfit.toFixed(6)} SOL`
      : "Withdrawal blocked or failed"
  };
}

/**
 * ATTACK 2: Insurance Drain via Bad Debt
 * 1. Open maximum leverage position
 * 2. Crash price to create liquidation
 * 3. Push price even lower to create bad debt
 */
async function attack2_InsuranceDrain(): Promise<AttackResult> {
  console.log("\n=== ATTACK 2: Insurance Fund Drain ===");

  const { vaultBalance: vaultBefore, engine } = await getState();
  const insuranceBefore = Number(engine.insuranceFund.balance) / 1e9;

  // Set price and crank to establish baseline
  await pushPrice(140);
  await crank();

  // Check for any liquidatable accounts after price crash
  console.log("  Step 1: Push price to extreme ($10)");
  await pushPrice(10);
  await crank();

  // Run multiple cranks to process any liquidations
  console.log("  Step 2: Running cranks to process liquidations");
  for (let i = 0; i < 5; i++) {
    await crank();
    await new Promise(r => setTimeout(r, 500));
  }

  const { vaultBalance: vaultAfter, engine: engineAfter } = await getState();
  const insuranceAfter = Number(engineAfter.insuranceFund.balance) / 1e9;

  // Restore price
  await pushPrice(140);
  await crank();

  return {
    name: "Insurance Fund Drain",
    success: false,
    vaultBefore,
    vaultAfter,
    insuranceBefore,
    insuranceAfter,
    attackerProfit: 0,
    notes: `Insurance change: ${(insuranceAfter - insuranceBefore).toFixed(6)} SOL. Liquidations: ${engineAfter.lifetimeLiquidations.toString()}`
  };
}

/**
 * ATTACK 3: Zero Price Attack
 * Try to set price to zero to cause division errors or other exploits
 */
async function attack3_ZeroPrice(): Promise<AttackResult> {
  console.log("\n=== ATTACK 3: Zero Price Attack ===");

  const { vaultBalance: vaultBefore, engine } = await getState();
  const insuranceBefore = Number(engine.insuranceFund.balance) / 1e9;

  console.log("  Attempting to push zero price...");
  const success = await pushPrice(0);

  const { vaultBalance: vaultAfter, engine: engineAfter } = await getState();
  const insuranceAfter = Number(engineAfter.insuranceFund.balance) / 1e9;

  // Restore price
  await pushPrice(140);
  await crank();

  return {
    name: "Zero Price Attack",
    success: success,
    vaultBefore,
    vaultAfter,
    insuranceBefore,
    insuranceAfter,
    attackerProfit: 0,
    notes: success ? "VULNERABILITY: Zero price accepted!" : "Zero price correctly rejected"
  };
}

/**
 * ATTACK 4: Withdrawal Overflow
 * Try to withdraw more than account balance
 */
async function attack4_WithdrawalOverflow(): Promise<AttackResult> {
  console.log("\n=== ATTACK 4: Withdrawal Overflow ===");

  const { vaultBalance: vaultBefore, engine, data } = await getState();
  const insuranceBefore = Number(engine.insuranceFund.balance) / 1e9;
  const { users } = await findMyAccounts();

  if (users.length === 0) {
    return {
      name: "Withdrawal Overflow",
      success: false,
      vaultBefore,
      vaultAfter: vaultBefore,
      insuranceBefore,
      insuranceAfter: insuranceBefore,
      attackerProfit: 0,
      notes: "No user accounts"
    };
  }

  const userIdx = users[0];
  const user = parseAccount(data, userIdx);
  const userCapital = user ? Number(user.capital) / 1e9 : 0;

  // Try to withdraw 10x the balance
  const overflowAmount = BigInt(Math.floor(userCapital * 10 * 1e9));
  console.log(`  User capital: ${userCapital.toFixed(6)} SOL`);
  console.log(`  Attempting withdrawal of: ${Number(overflowAmount) / 1e9} SOL`);

  const success = await withdraw(userIdx, overflowAmount);

  const { vaultBalance: vaultAfter, engine: engineAfter } = await getState();

  return {
    name: "Withdrawal Overflow",
    success: success,
    vaultBefore,
    vaultAfter,
    insuranceBefore,
    insuranceAfter: Number(engineAfter.insuranceFund.balance) / 1e9,
    attackerProfit: vaultBefore - vaultAfter,
    notes: success ? "VULNERABILITY: Overflow withdrawal succeeded!" : "Overflow correctly rejected"
  };
}

/**
 * ATTACK 5: Price Oscillation (pump and dump repeatedly)
 */
async function attack5_PriceOscillation(): Promise<AttackResult> {
  console.log("\n=== ATTACK 5: Price Oscillation Attack ===");

  const { vaultBalance: vaultBefore, engine } = await getState();
  const insuranceBefore = Number(engine.insuranceFund.balance) / 1e9;

  // Oscillate price rapidly
  const prices = [140, 280, 70, 350, 35, 200, 100, 300, 50, 140];

  console.log("  Oscillating prices rapidly...");
  for (const price of prices) {
    await pushPrice(price);
    await crank();
  }

  const { vaultBalance: vaultAfter, engine: engineAfter } = await getState();
  const insuranceAfter = Number(engineAfter.insuranceFund.balance) / 1e9;

  return {
    name: "Price Oscillation",
    success: false,
    vaultBefore,
    vaultAfter,
    insuranceBefore,
    insuranceAfter,
    attackerProfit: 0,
    notes: `Vault change: ${(vaultAfter - vaultBefore).toFixed(6)} SOL, Insurance change: ${(insuranceAfter - insuranceBefore).toFixed(6)} SOL`
  };
}

async function main() {
  console.log("=== PERCOLATOR SECURITY AUDIT - ATTACK TESTS ===\n");

  // Check initial state
  const { vaultBalance, engine, config } = await getState();
  console.log(`Initial vault: ${vaultBalance.toFixed(6)} SOL`);
  console.log(`Insurance fund: ${(Number(engine.insuranceFund.balance) / 1e9).toFixed(6)} SOL`);
  console.log(`Oracle authority active: ${!config.oracleAuthority.equals(PublicKey.default)}`);

  // Run attacks
  results.push(await attack3_ZeroPrice());          // Safe attack first
  results.push(await attack4_WithdrawalOverflow()); // Safe attack
  results.push(await attack5_PriceOscillation());   // Price manipulation
  results.push(await attack2_InsuranceDrain());     // Insurance attack
  results.push(await attack1_OracleProfitExtraction()); // Main profit attack

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("ATTACK TEST RESULTS");
  console.log("=".repeat(70));

  console.log("\n| Attack | Success | Vault Δ | Insurance Δ | Profit |");
  console.log("|--------|---------|---------|-------------|--------|");

  for (const r of results) {
    const vaultDelta = (r.vaultAfter - r.vaultBefore).toFixed(4);
    const insDelta = (r.insuranceAfter - r.insuranceBefore).toFixed(4);
    const profit = r.attackerProfit.toFixed(4);
    console.log(`| ${r.name.slice(0, 25).padEnd(25)} | ${r.success ? "YES" : "NO ".padStart(3)} | ${vaultDelta.padStart(7)} | ${insDelta.padStart(11)} | ${profit.padStart(6)} |`);
  }

  console.log("\n=== DETAILED NOTES ===");
  for (const r of results) {
    console.log(`\n${r.name}:`);
    console.log(`  ${r.notes}`);
  }

  // Final state
  const { vaultBalance: finalVault, engine: finalEngine } = await getState();
  console.log("\n=== FINAL STATE ===");
  console.log(`Vault: ${finalVault.toFixed(6)} SOL`);
  console.log(`Insurance: ${(Number(finalEngine.insuranceFund.balance) / 1e9).toFixed(6)} SOL`);
  console.log(`Lifetime liquidations: ${finalEngine.lifetimeLiquidations.toString()}`);

  // Save results
  fs.writeFileSync("audit-results.json", JSON.stringify(results, null, 2));
  console.log("\nResults saved to audit-results.json");
}

main().catch(console.error);
