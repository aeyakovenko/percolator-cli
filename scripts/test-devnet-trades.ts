/**
 * Run test trades against the deployed devnet market
 *
 * DISCLAIMER: FOR EDUCATIONAL PURPOSES ONLY.
 * This code has NOT been audited. Do NOT use with real funds.
 *
 * Usage:
 *   npx tsx scripts/test-devnet-trades.ts
 *
 * Requires: devnet-market.json (created by setup-devnet-market.ts)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SYSVAR_CLOCK_PUBKEY,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitUser,
  encodeDepositCollateral,
  encodeTradeNoCpi,
  encodeKeeperCrank,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TRADE_NOCPI,
  ACCOUNTS_KEEPER_CRANK,
  buildAccountMetas,
} from "../src/abi/accounts.js";
import { parseEngine, parseAccount, parseUsedIndices } from "../src/solana/slab.js";
import { buildIx } from "../src/runtime/tx.js";

// ============================================================================
// HELPERS
// ============================================================================

async function getChainlinkPrice(connection: Connection, oracle: PublicKey): Promise<number> {
  const info = await connection.getAccountInfo(oracle);
  if (!info) throw new Error("Oracle not found");
  const decimals = info.data.readUInt8(138);
  const answer = info.data.readBigInt64LE(216);
  return Number(answer) / Math.pow(10, decimals);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("PERCOLATOR TEST TRADES");
  console.log("=".repeat(70));
  console.log("\n*** DISCLAIMER: FOR EDUCATIONAL PURPOSES ONLY ***\n");

  // Load market info
  if (!fs.existsSync("devnet-market.json")) {
    console.log("ERROR: devnet-market.json not found");
    console.log("Run: npx tsx scripts/setup-devnet-market.ts");
    process.exit(1);
  }

  const market = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
  console.log(`Market: ${market.slab}`);
  console.log(`Oracle: ${market.oracle} (${market.oracleType})`);

  // Setup connection and wallet
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  console.log(`\nWallet: ${payer.publicKey.toBase58()}`);
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // Get current oracle price
  const oracle = new PublicKey(market.oracle);
  const price = await getChainlinkPrice(connection, oracle);
  console.log(`\nCurrent SOL/USD price: $${price.toFixed(2)}`);

  // Keys
  const slab = new PublicKey(market.slab);
  const mint = new PublicKey(market.mint);
  const vault = new PublicKey(market.vault);
  const lpIdx = market.lp.index;
  const programId = new PublicKey(market.programId);

  // Create trader keypair (separate from admin for testing)
  const trader = Keypair.generate();
  console.log(`\nTest trader: ${trader.publicKey.toBase58()}`);

  // Fund trader with SOL
  console.log("\nStep 1: Funding trader with SOL...");
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: trader.publicKey,
      lamports: LAMPORTS_PER_SOL / 10,
    })
  );
  await sendAndConfirmTransaction(connection, fundTx, [payer]);
  console.log("  Funded with 0.1 SOL");

  // Create trader token account and mint tokens
  console.log("\nStep 2: Creating trader token account...");
  const traderAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint, trader.publicKey
  );
  await mintTo(connection, payer, mint, traderAta.address, payer, 50_000_000n); // 50 tokens
  console.log(`  ATA: ${traderAta.address.toBase58()}`);
  console.log("  Minted 50 tokens");

  // Initialize trader account
  console.log("\nStep 3: Initializing trader account...");
  const initUserData = encodeInitUser({ feePayment: "2000000" }); // 2 tokens
  const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
    trader.publicKey,
    slab,
    traderAta.address,
    vault,
    TOKEN_PROGRAM_ID,
  ]);

  const initUserTx = new Transaction();
  initUserTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  initUserTx.add(buildIx({ programId, keys: initUserKeys, data: initUserData }));
  await sendAndConfirmTransaction(connection, initUserTx, [payer, trader], { commitment: "confirmed" });

  // Get trader's account index
  const slabInfo = await connection.getAccountInfo(slab);
  const usedIndices = slabInfo ? parseUsedIndices(slabInfo.data) : [];
  const traderIdx = usedIndices[usedIndices.length - 1]; // Last added
  console.log(`  Trader account index: ${traderIdx}`);

  // Deposit collateral
  console.log("\nStep 4: Depositing collateral...");
  const depositData = encodeDepositCollateral({ userIdx: traderIdx, amount: "20000000" }); // 20 tokens
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    trader.publicKey,
    slab,
    traderAta.address,
    vault,
    TOKEN_PROGRAM_ID,
  ]);

  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }));
  depositTx.add(buildIx({ programId, keys: depositKeys, data: depositData }));
  await sendAndConfirmTransaction(connection, depositTx, [payer, trader], { commitment: "confirmed" });
  console.log("  Deposited 20 tokens");

  // Run keeper crank before trading
  console.log("\nStep 5: Running keeper crank...");
  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey,
    slab,
    SYSVAR_CLOCK_PUBKEY,
    oracle,
  ]);

  const crankTx = new Transaction();
  crankTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }));
  crankTx.add(buildIx({ programId, keys: crankKeys, data: crankData }));
  await sendAndConfirmTransaction(connection, crankTx, [payer], { commitment: "confirmed", skipPreflight: true });
  console.log("  Crank executed");

  // Trade 1: Open long position (using trade_nocpi - LP owner signs directly)
  console.log("\nStep 6: Opening LONG position (0.1 contracts)...");
  const trade1Data = encodeTradeNoCpi({
    lpIdx,
    userIdx: traderIdx,
    size: "100000", // 0.1 contracts (positive = long)
  });
  const trade1Keys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
    trader.publicKey,      // user (signer)
    payer.publicKey,       // LP owner (signer)
    slab,
    SYSVAR_CLOCK_PUBKEY,
    oracle,
  ]);

  const trade1Tx = new Transaction();
  trade1Tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  trade1Tx.add(buildIx({ programId, keys: trade1Keys, data: trade1Data }));

  try {
    const sig = await sendAndConfirmTransaction(connection, trade1Tx, [payer, trader], {
      commitment: "confirmed",
      skipPreflight: true,
    });
    console.log(`  Trade 1: SUCCESS (${sig.slice(0, 20)}...)`);

    // Check trader's position
    const slabAfter1 = await connection.getAccountInfo(slab);
    if (slabAfter1) {
      const account = parseAccount(slabAfter1.data, traderIdx);
      console.log(`  Position: ${account.positionSize}`);
      console.log(`  Capital: ${Number(account.capital) / 1e6} tokens`);
      console.log(`  Entry price: ${Number(account.entryPrice) / 1e6}`);
    }
  } catch (err: any) {
    console.log(`  Trade 1: FAILED`);
    // Try to get transaction logs
    if (err.signature) {
      try {
        const txInfo = await connection.getTransaction(err.signature, { commitment: "confirmed" });
        if (txInfo?.meta?.logMessages) {
          console.log("  Logs:");
          for (const log of txInfo.meta.logMessages.slice(-10)) {
            console.log(`    ${log}`);
          }
        }
      } catch {}
    }
    if (err.logs) {
      console.log("  Logs:");
      for (const log of err.logs.slice(-10)) {
        console.log(`    ${log}`);
      }
    }
    if (err.message) {
      console.log(`  Error: ${err.message.slice(0, 200)}`);
    }
  }

  // Wait a bit for price to potentially move
  console.log("\nWaiting 5 seconds...");
  await new Promise(r => setTimeout(r, 5000));

  // Get updated price
  const priceAfter = await getChainlinkPrice(connection, oracle);
  console.log(`Current SOL/USD price: $${priceAfter.toFixed(2)}`);

  // Trade 2: Close position
  console.log("\nStep 7: Closing position (SHORT 0.1 contracts)...");
  const trade2Data = encodeTradeNoCpi({
    lpIdx,
    userIdx: traderIdx,
    size: "-100000", // -0.1 contracts (negative = short, closes long)
  });
  const trade2Keys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
    trader.publicKey,      // user (signer)
    payer.publicKey,       // LP owner (signer)
    slab,
    SYSVAR_CLOCK_PUBKEY,
    oracle,
  ]);

  const trade2Tx = new Transaction();
  trade2Tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }));
  trade2Tx.add(buildIx({ programId, keys: trade2Keys, data: trade2Data }));

  try {
    await sendAndConfirmTransaction(connection, trade2Tx, [payer, trader], {
      commitment: "confirmed",
      skipPreflight: true,
    });
    console.log("  Trade 2: SUCCESS");

    // Check trader's position after closing
    const slabAfter2 = await connection.getAccountInfo(slab);
    if (slabAfter2) {
      const account = parseAccount(slabAfter2.data, traderIdx);
      console.log(`  Position: ${account.positionSize}`);
      console.log(`  Capital: ${Number(account.capital) / 1e6} tokens`);
      console.log(`  PnL: ${Number(account.pnl) / 1e6} tokens`);
    }
  } catch (err: any) {
    console.log(`  Trade 2: FAILED - ${err.message?.slice(0, 100)}`);
    if (err.logs) {
      for (const log of err.logs.slice(-5)) {
        console.log(`    ${log}`);
      }
    }
  }

  // Final state
  console.log("\n" + "=".repeat(70));
  console.log("FINAL STATE");
  console.log("=".repeat(70));

  const finalSlab = await connection.getAccountInfo(slab);
  if (finalSlab) {
    const engine = parseEngine(finalSlab.data);
    console.log(`\nEngine:`);
    console.log(`  Insurance fund: ${Number(engine.insuranceFund.balance) / 1e6} tokens`);
    console.log(`  Risk reduction mode: ${engine.riskReductionOnly}`);

    // Trader account
    const traderAccount = parseAccount(finalSlab.data, traderIdx);
    console.log(`\nTrader (idx ${traderIdx}):`);
    console.log(`  Position: ${traderAccount.positionSize}`);
    console.log(`  Capital: ${Number(traderAccount.capital) / 1e6} tokens`);

    // LP account
    const lpAccount = parseAccount(finalSlab.data, lpIdx);
    console.log(`\nLP (idx ${lpIdx}):`);
    console.log(`  Position: ${lpAccount.positionSize}`);
    console.log(`  Capital: ${Number(lpAccount.capital) / 1e6} tokens`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("TEST TRADES COMPLETE");
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
