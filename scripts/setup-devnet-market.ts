/**
 * Provision a persistent inverted SOL/USD market on devnet.
 *
 * Collateral: wrapped SOL (9 decimals, unit_scale=0 → 1 lamport = 1 engine unit).
 * Oracle:     Chainlink SOL/USD @ 99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR
 *             (live on devnet, owner HEvSKofv…).
 * Invert:     1 — mark reads as "SOL per USD" (1e12 / raw_e6).
 *
 * Maintenance-fee target: ≈ $5/day/account at SOL ≈ $85.
 *   250 lamports/slot × 216 000 slots/day = 54 M lamports = 0.054 SOL.
 *
 * Writes the deployment summary to devnet-market.json.
 */

import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, NATIVE_MINT,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encodeInitMarket, encodeInitLP, encodeDepositCollateral,
  encodeTopUpInsurance, encodeKeeperCrank,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_INIT_LP, ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE, ACCOUNTS_KEEPER_CRANK, buildAccountMetas, WELL_KNOWN,
} from "../src/abi/accounts.js";
import { deriveVaultAuthority, deriveLpPda } from "../src/solana/pda.js";
import {
  parseHeader, parseConfig, parseEngine, parseUsedIndices, SLAB_LEN,
} from "../src/solana/slab.js";
import { buildIx } from "../src/runtime/tx.js";
import { prodInitMarketArgs } from "./_default-market.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");
const MATCHER_PROGRAM_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const CHAINLINK_SOL_USD = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const CHAINLINK_OWNER = "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny";
const MATCHER_CTX_SIZE = 320;

// Funding amounts (wrapped SOL, 9 decimals).
const INSURANCE_FUND_AMOUNT = 1_000_000_000n;  // 1 SOL
const LP_COLLATERAL_AMOUNT  = 1_000_000_000n;  // 1 SOL
const WRAP_AMOUNT           = 5 * LAMPORTS_PER_SOL; // headroom for fees + funding

// ============================================================================
// CHAINLINK VERIFICATION
// ============================================================================

async function verifyChainlink(conn: Connection): Promise<{ rawE6: bigint; invertedE6: bigint; priceUsd: number; ageSec: number }> {
  const info = await conn.getAccountInfo(CHAINLINK_SOL_USD);
  if (!info) throw new Error(`Chainlink feed not found: ${CHAINLINK_SOL_USD.toBase58()}`);
  if (info.owner.toBase58() !== CHAINLINK_OWNER) {
    throw new Error(`Chainlink owner mismatch: got ${info.owner.toBase58()}, expected ${CHAINLINK_OWNER}`);
  }
  if (info.data.length < 232) {
    throw new Error(`Chainlink data too short: ${info.data.length} bytes (need >= 232)`);
  }

  const decimals = info.data.readUInt8(138);
  const timestamp = Number(info.data.readBigUInt64LE(208));
  const answer = info.data.readBigInt64LE(216);
  const priceUsd = Number(answer) / Math.pow(10, decimals);
  const ageSec = Math.floor(Date.now() / 1000) - timestamp;

  if (ageSec < 0 || ageSec > 3600) {
    throw new Error(`Chainlink feed stale: age=${ageSec}s`);
  }
  if (priceUsd < 10 || priceUsd > 10000) {
    throw new Error(`Chainlink price unreasonable: $${priceUsd.toFixed(2)}`);
  }

  const rawE6 = BigInt(answer) * (10n ** 6n) / (10n ** BigInt(decimals));
  const invertedE6 = 1_000_000_000_000n / rawE6;
  return { rawE6, invertedE6, priceUsd, ageSec };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("═".repeat(70));
  console.log("PERCOLATOR — INVERTED SOL/USD DEVNET MARKET (Chainlink oracle)");
  console.log("═".repeat(70));

  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8"))));
  const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const conn = new Connection(rpc, "confirmed");

  console.log(`RPC:    ${rpc}`);
  console.log(`Wallet: ${payer.publicKey.toBase58()}`);
  const startBal = await conn.getBalance(payer.publicKey);
  console.log(`SOL:    ${(startBal / LAMPORTS_PER_SOL).toFixed(4)}`);

  // ── Step 1: verify oracle liveness ──
  console.log("\n[1] Verifying Chainlink SOL/USD oracle...");
  const { rawE6, invertedE6, priceUsd, ageSec } = await verifyChainlink(conn);
  console.log(`    feed:        ${CHAINLINK_SOL_USD.toBase58()}`);
  console.log(`    price:       $${priceUsd.toFixed(4)}  (age ${ageSec}s)`);
  console.log(`    raw_e6:      ${rawE6}`);
  console.log(`    inverted_e6: ${invertedE6}  (${(Number(invertedE6)/1e6).toFixed(6)} SOL = $1)`);

  // ── Step 2: create slab ──
  console.log("\n[2] Creating slab account...");
  const slab = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(SLAB_LEN);
  console.log(`    slab:  ${slab.publicKey.toBase58()}`);
  console.log(`    size:  ${SLAB_LEN} bytes  rent: ${(rent/LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  {
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }))
      .add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
        lamports: rent, space: SLAB_LEN, programId: PROGRAM_ID,
      }));
    await sendAndConfirmTransaction(conn, t, [payer, slab], { commitment: "confirmed" });
  }

  // ── Step 3: vault PDA + ATA ──
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slab.publicKey);
  const vaultAcc = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, vaultPda, true);
  console.log(`    vault pda:  ${vaultPda.toBase58()}`);
  console.log(`    vault ata:  ${vaultAcc.address.toBase58()}`);

  // ── Step 4: InitMarket (inverted, Chainlink) ──
  console.log("\n[3] InitMarket (inverted Chainlink SOL/USD, SOL collateral)...");
  const feedIdHex = Buffer.from(CHAINLINK_SOL_USD.toBytes()).toString("hex");
  const initArgs = prodInitMarketArgs(payer.publicKey, NATIVE_MINT, {
    // Chainlink oracle account (non-Hyperp path)
    indexFeedId:          feedIdHex,
    // Initial mark ignored for non-Hyperp — program reads Chainlink at init
    initialMarkPriceE6:   "0",
    // SOL-9 collateral, no scaling: 1 lamport = 1 engine unit
    unitScale:            0,
    invert:               1,
    // Chainlink heartbeat is ~seconds on devnet; 60 s cushion is generous
    maxStalenessSecs:     "60",
    // Chainlink has no confidence interval, so confFilter is unused on this path
    confFilterBps:        0,
    // $5/day target for SOL-9 collateral: 250 lamports/slot × 216_000 = 54 M/day
    maintenanceFeePerSlot: "250",
    // SOL-denominated minimums (~$10 at SOL=$85 is 0.118 SOL)
    minInitialDeposit:    "118000000",    // 0.118 SOL
    minNonzeroMmReq:      "1200000",      // 0.0012 SOL
    minNonzeroImReq:      "2400000",      // 0.0024 SOL
    liquidationFeeCap:    "11700000000",  // 11.7 SOL cap ≈ $1 000 max
    minLiquidationAbs:    "11700000",     // 0.0117 SOL ≈ $1 min
    // Insurance ceilings
    maxInsuranceFloor:    "10000000000000000", // 10 M SOL ceiling (engine u128)
    // Non-Hyperp resolvability — perm-resolve already ≤ max_accrual_dt_slots
    // (100 000) so this passes; also satisfies the non-Hyperp invariant
    // (need perm-resolve > 0 OR min_oracle_price_cap > 0).
  });
  {
    const keys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      payer.publicKey, slab.publicKey, NATIVE_MINT, vaultAcc.address,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock, WELL_KNOWN.rent,
      CHAINLINK_SOL_USD,                // accounts[7] = oracle (Chainlink)
      WELL_KNOWN.systemProgram,
    ]);
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(buildIx({ programId: PROGRAM_ID, keys, data: encodeInitMarket(initArgs) }));
    const sig = await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    sig: ${sig.slice(0, 40)}...`);
  }

  // ── Step 5: warm-up keeper crank ──
  console.log("\n[4] Initial permissionless KeeperCrank...");
  {
    const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, CHAINLINK_SOL_USD,
    ]);
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed", skipPreflight: true });
  }

  // ── Step 6: admin wSOL ATA + wrap some SOL ──
  console.log("\n[5] Wrapping SOL for LP collateral + insurance fund...");
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  {
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }))
      .add(SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: adminAta.address,
        lamports: WRAP_AMOUNT,
      }))
      .add({
        programId: TOKEN_PROGRAM_ID,
        keys: [{ pubkey: adminAta.address, isSigner: false, isWritable: true }],
        data: Buffer.from([17]), // SyncNative
      });
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    wrapped ${WRAP_AMOUNT / LAMPORTS_PER_SOL} SOL → ${adminAta.address.toBase58()}`);
  }

  // ── Step 7: passive-matcher LP (idx 0) ──
  console.log("\n[6] Creating passive-matcher LP at idx 0...");
  const matcherCtx = Keypair.generate();
  const [lpPda] = deriveLpPda(PROGRAM_ID, slab.publicKey, 0);

  // Passive matcher init payload (66 bytes, tag=2).
  const matcherInit = Buffer.alloc(66);
  matcherInit[0] = 2; matcherInit[1] = 0;
  matcherInit.writeUInt32LE(5,    2);  // trading_fee_bps    = 5 (0.05%)
  matcherInit.writeUInt32LE(50,   6);  // base_spread_bps    = 50 (0.5%)
  matcherInit.writeUInt32LE(500, 10);  // max_total_bps      = 500 (5%)
  matcherInit.writeUInt32LE(0,   14);  // impact_k_bps       = 0 (Passive)
  matcherInit.writeBigUInt64LE(10_000_000_000_000n, 34); // max_fill_abs lo

  {
    const createMatcher = SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: matcherCtx.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE),
      space: MATCHER_CTX_SIZE, programId: MATCHER_PROGRAM_ID,
    });
    const initMatcher = {
      programId: MATCHER_PROGRAM_ID,
      keys: [
        { pubkey: lpPda, isSigner: false, isWritable: false },
        { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
      ],
      data: matcherInit,
    };
    const initLp = buildIx({
      programId: PROGRAM_ID,
      keys: buildAccountMetas(ACCOUNTS_INIT_LP, [
        payer.publicKey, slab.publicKey, adminAta.address, vaultAcc.address,
        WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
      ]),
      data: encodeInitLP({
        matcherProgram: MATCHER_PROGRAM_ID,
        matcherContext: matcherCtx.publicKey,
        // Must be ≥ min_initial_deposit (0.118 SOL configured above).
        feePayment: "120000000", // 0.12 SOL
      }),
    });
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }))
      .add(createMatcher)
      .add(initMatcher)
      .add(initLp);
    await sendAndConfirmTransaction(conn, t, [payer, matcherCtx], { commitment: "confirmed" });
    console.log(`    matcher ctx: ${matcherCtx.publicKey.toBase58()}`);
    console.log(`    lp pda:      ${lpPda.toBase58()}`);
  }

  // ── Step 8: deposit LP collateral ──
  console.log("\n[7] Depositing LP collateral...");
  {
    const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey, slab.publicKey, adminAta.address, vaultAcc.address,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeDepositCollateral({ userIdx: 0, amount: LP_COLLATERAL_AMOUNT.toString() }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    deposited ${Number(LP_COLLATERAL_AMOUNT) / LAMPORTS_PER_SOL} SOL`);
  }

  // ── Step 9: insurance top-up ──
  console.log("\n[8] Topping up insurance fund...");
  {
    const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
      payer.publicKey, slab.publicKey, adminAta.address, vaultAcc.address,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeTopUpInsurance({ amount: INSURANCE_FUND_AMOUNT.toString() }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    insurance += ${Number(INSURANCE_FUND_AMOUNT) / LAMPORTS_PER_SOL} SOL`);
  }

  // ── Step 10: verify state ──
  console.log("\n[9] Verifying final market state...");
  const final = await conn.getAccountInfo(slab.publicKey);
  if (!final) throw new Error("slab fetch failed");
  const h = parseHeader(final.data);
  const c = parseConfig(final.data);
  const e = parseEngine(final.data);
  const indices = parseUsedIndices(final.data);
  console.log(`    admin:             ${h.admin.toBase58()}`);
  console.log(`    insurance_auth:    ${h.insuranceAuthority.toBase58()}`);
  console.log(`    close_auth:        ${h.closeAuthority.toBase58()}`);
  console.log(`    inverted:          ${c.invert === 1 ? "yes" : "no"}`);
  console.log(`    unit_scale:        ${c.unitScale}`);
  console.log(`    max_staleness:     ${c.maxStalenessSlots}`);
  console.log(`    last_oracle_price: ${e.lastOraclePrice}  (engine-space, after invert)`);
  console.log(`    vault:             ${e.vault}  (= ${Number(e.vault)/LAMPORTS_PER_SOL} SOL)`);
  console.log(`    c_tot:             ${e.cTot}`);
  console.log(`    insurance:         ${e.insuranceFund.balance}  (= ${Number(e.insuranceFund.balance)/LAMPORTS_PER_SOL} SOL)`);
  console.log(`    active accounts:   ${indices.join(", ") || "(none)"}`);
  console.log(`    market_mode:       ${e.marketMode === 0 ? "Live" : "Resolved"}`);

  // ── Step 11: save deployment manifest ──
  const out = {
    network: "devnet",
    createdAt: new Date().toISOString(),
    programId: PROGRAM_ID.toBase58(),
    matcherProgramId: MATCHER_PROGRAM_ID.toBase58(),
    slab: slab.publicKey.toBase58(),
    slabSize: SLAB_LEN,
    mint: NATIVE_MINT.toBase58(),
    collateral: "wSOL (9 decimals, unit_scale=0)",
    vault: vaultAcc.address.toBase58(),
    vaultPda: vaultPda.toBase58(),
    oracle: CHAINLINK_SOL_USD.toBase58(),
    oracleOwner: CHAINLINK_OWNER,
    oracleType: "chainlink",
    inverted: true,
    lp: {
      index: 0,
      pda: lpPda.toBase58(),
      matcherContext: matcherCtx.publicKey.toBase58(),
      collateralLamports: Number(LP_COLLATERAL_AMOUNT),
    },
    insuranceFundLamports: Number(INSURANCE_FUND_AMOUNT),
    admin: payer.publicKey.toBase58(),
    adminAta: adminAta.address.toBase58(),
    maintenanceFeePerSlot: initArgs.maintenanceFeePerSlot,
    expectedDailyFee: "≈ 0.054 SOL/account/day",
    permissionlessResolveStaleSlots: initArgs.permissionlessResolveStaleSlots,
    forceCloseDelaySlots: initArgs.forceCloseDelaySlots,
  };
  fs.writeFileSync("devnet-market.json", JSON.stringify(out, null, 2));
  console.log("\n    devnet-market.json written.");

  const endBal = await conn.getBalance(payer.publicKey);
  console.log(`\nSOL spent:  ${((startBal - endBal) / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log(`SOL left:   ${(endBal / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log("═".repeat(70));
}

main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
