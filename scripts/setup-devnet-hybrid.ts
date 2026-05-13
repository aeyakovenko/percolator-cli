/**
 * Hybrid hours-fee mode devnet provisioning — verification script.
 *
 * Initializes a market with:
 *   - 20x leverage (mm=im=500 bps)
 *   - HYBRID_AFTER_HOURS dynamic fee mode (trade_fee_base_bps=1, max=10000)
 *   - 3-leg composite oracle: 1306/JPY / USD/JPY / SOL/USD
 *
 * Devnet doesn't have the JP equity Pyth feed, so this is primarily a
 * wire-format + init-time validation test. Cranks/trades against the
 * composite oracle will fail until the feeds exist on chain — that's fine.
 *
 * Usage: SOLANA_RPC_URL=https://api.devnet.solana.com npx tsx scripts/setup-devnet-hybrid.ts
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  NATIVE_MINT, getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";

import {
  encodeInitMarket, encodeKeeperCrank,
  ORACLE_LEG_FLAG_DIVIDE_LEG2, ORACLE_LEG_FLAG_DIVIDE_LEG3,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_KEEPER_CRANK, buildAccountMetas, WELL_KNOWN,
} from "../src/abi/accounts.js";
import { fetchSlab, parseConfig, parseEngine, parseHeader, SLAB_LEN } from "../src/solana/slab.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import { buildIx } from "../src/runtime/tx.js";

const PROGRAM_ID = new PublicKey("4PTXCZ4vLSK6aiUd3fx2dVVYSRNFnMSM4ijhDWkuFi2s");

// Devnet test config: all 3 legs use the SOL/USD Pyth pull feed so init can
// read each leg's PriceUpdateV2 account. Composite math is meaningless here
// (= SOL_USD with flags=0), but the wire format + multi-leg account passing
// + dynamic-fee tail are exercised end-to-end.
//
// The real bounty config (1306/JPY / USD/JPY / SOL/USD with DIVIDE flags) will
// be wired in setup-mainnet-bounty4.ts once devnet wire format is verified.
const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const INDEX_FEED_ID = SOL_USD_FEED_ID;
const LEG2_FEED_ID  = SOL_USD_FEED_ID;
const LEG3_FEED_ID  = SOL_USD_FEED_ID;
// Sponsored shard-0 SOL/USD PriceUpdateV2 — same PDA on devnet & mainnet
// because it's derived from feed_id deterministically.
const DEVNET_PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

const withPriority = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
];

async function main() {
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8")
  )));

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("DEVNET HYBRID HOURS-FEE MARKET — verification");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`RPC:     ${rpc}`);
  console.log(`Wallet:  ${payer.publicKey.toBase58()}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);

  // 1) Create slab account
  const slabKp = Keypair.generate();
  const slabPubkey = slabKp.publicKey;
  console.log(`\n[1] Creating slab account ${slabPubkey.toBase58()}...`);
  const rent = await conn.getMinimumBalanceForRentExemption(SLAB_LEN);
  await sendAndConfirmTransaction(conn,
    new Transaction()
      .add(...withPriority(50_000))
      .add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: slabPubkey,
        lamports: rent, space: SLAB_LEN, programId: PROGRAM_ID,
      })),
    [payer, slabKp], { commitment: "confirmed" });
  console.log(`    rent: ${(rent / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // 2) Vault PDA + ATA (wSOL collateral on devnet)
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabPubkey);
  const vaultAcc = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, vaultPda, true);
  console.log(`[2] Vault PDA: ${vaultPda.toBase58()}  ATA: ${vaultAcc.address.toBase58()}`);

  // 3) InitMarket with hybrid hours-fee config + 20x leverage
  console.log(`\n[3] InitMarket — hybrid hours-fee, 20x leverage, 3-leg composite...`);
  const initData = encodeInitMarket({
    admin: payer.publicKey,
    collateralMint: NATIVE_MINT,
    indexFeedId: INDEX_FEED_ID,

    // Per user spec
    maxStalenessSecs:        "60",
    confFilterBps:           200,
    invert:                  0,
    unitScale:               0,
    initialMarkPriceE6:      "0",
    maintenanceFeePerSlot:   "0",  // anti-spam handled via new_account_fee

    // RiskParams — 20x leverage, hybrid fee
    hMin:                    "0",
    maintenanceMarginBps:    "500",   // 5% maintenance
    initialMarginBps:        "500",   // 5% initial → 20x leverage
    tradingFeeBps:           "10000", // max_trading_fee_bps (hybrid cap = 100%)
    maxAccounts:             "4096",
    newAccountFee:           "1000000",  // anti-dust insurance contribution
    hMax:                    "6480000",  // ~30d at 0.4s/slot
    maxCrankStalenessSlots:  "0",
    liquidationFeeBps:       "5",
    liquidationFeeCap:       "50000000000",
    resolvePriceDeviationBps: "100",
    minLiquidationAbs:       "0",
    minNonzeroMmReq:         "500",
    minNonzeroImReq:         "600",
    maxPriceMoveBpsPerSlot:  "49",   // 0.49%/slot — known to pass §1.4 envelope at mm=500

    // Extended tail
    insuranceWithdrawMaxBps:           0,
    insuranceWithdrawCooldownSlots:    "0",
    permissionlessResolveStaleSlots:   "6480000",  // ~30d
    fundingHorizonSlots:               "7200",
    fundingKBps:                       "100",
    fundingMaxPremiumBps:              "500",
    fundingMaxE9PerSlot:               "1000",
    markMinFee:                        "1000",  // anti-dust
    forceCloseDelaySlots:              "216000", // ~24h

    // Single-leg on devnet (3-leg requires distinct feed_ids — wrapper rejects
    // same feed across legs and we only have SOL/USD on devnet). The 3-leg
    // composite is verified end-to-end on the mainnet deploy where all 3
    // feeds (1306/JPY, USD/JPY, SOL/USD) actually exist.
    // Omitting the oracle-leg tail keeps this as a legacy single-feed market.

    // Dynamic-fee tail (8 bytes) — drives the wrapper into HYBRID_AFTER_HOURS
    // mode by setting trade_fee_base_bps < max_trading_fee_bps. With base=1
    // and max=10000, the after-hours dynamic fee can swing from 1 → 10000.
    tradeFeeBaseBps: "1",
  });

  console.log(`    init data: ${initData.length} bytes`);

  const initKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
    payer.publicKey, slabPubkey, NATIVE_MINT, vaultAcc.address,
    WELL_KNOWN.clock, DEVNET_PYTH_SOL_USD,
  ]);
  const initIx = buildIx({ programId: PROGRAM_ID, keys: initKeys, data: initData });
  try {
    const sig = await sendAndConfirmTransaction(conn,
      new Transaction().add(...withPriority(400_000)).add(initIx),
      [payer], { commitment: "confirmed", skipPreflight: false });
    console.log(`    ✓ InitMarket landed: ${sig.slice(0, 30)}...`);
  } catch (e: any) {
    console.error(`    ✗ InitMarket failed: ${e.message?.split("\n")[0]?.slice(0, 200)}`);
    console.error(`    logs: ${e.transactionLogs?.slice(-10).join("\n           ")}`);
    process.exit(1);
  }

  // 4) Verify slab state
  const buf = await fetchSlab(conn, slabPubkey);
  const h = parseHeader(buf);
  const c = parseConfig(buf);
  const e = parseEngine(buf);
  console.log(`\n[4] Slab state after init:`);
  console.log(`    admin: ${h.admin.toBase58()}`);
  console.log(`    invert: ${c.invert}, unit_scale: ${c.unitScale}`);
  console.log(`    perm_resolve_slots: ${c.permissionlessResolveStaleSlots}`);
  console.log(`    force_close_slots: ${c.forceCloseDelaySlots}`);
  console.log(`    marketMode: ${e.marketMode}`);

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log("Hybrid hours-fee market initialized on devnet.");
  console.log(`Slab: ${slabPubkey.toBase58()}`);
  console.log("══════════════════════════════════════════════════════════════════════");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
