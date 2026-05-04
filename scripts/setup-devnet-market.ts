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
  encodeUpdateConfig, encodeUpdateAuthority, AUTHORITY_KIND,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_INIT_LP, ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE, ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_UPDATE_CONFIG, ACCOUNTS_UPDATE_ADMIN,
  buildAccountMetas, WELL_KNOWN,
} from "../src/abi/accounts.js";
import { deriveVaultAuthority, deriveLpPda } from "../src/solana/pda.js";
import {
  parseHeader, parseConfig, parseEngine, parseUsedIndices, fetchSlab, SLAB_LEN,
} from "../src/solana/slab.js";
import { buildIx } from "../src/runtime/tx.js";
import { prodInitMarketArgs } from "./_default-market.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const PROGRAM_ID = new PublicKey("2b7EnjdG5sJmwMh7NecaVHu7FjmyCHJ9jmFnMAKrXF9R");
const MATCHER_PROGRAM_ID = new PublicKey("5ogNxr4uFXZXoeJ4cP89kKZkx1FkbaD2FBQr91KoYZep");
const CHAINLINK_SOL_USD = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");
const CHAINLINK_OWNER = "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny";
const MATCHER_CTX_SIZE = 320;

// Funding amounts (wrapped SOL, 9 decimals).
// $500 insurance at SOL≈$85  ⇒  5.88 SOL
const INSURANCE_FUND_AMOUNT = 5_880_000_000n;
// 1 SOL LP seed (bounded by the 20× cap once enabled: c_tot ≤ 20 × ins = 117.6 SOL)
const LP_COLLATERAL_AMOUNT  = 1_000_000_000n;
// Wrap headroom: 0.12 LP init fee + 1 SOL LP deposit + 5.88 SOL insurance
//                + ~0.1 SOL for tx fees/atas = 7.1 SOL; round to 8.
const WRAP_AMOUNT_SOL = 8;
const WRAP_AMOUNT           = WRAP_AMOUNT_SOL * LAMPORTS_PER_SOL;

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
    // Chainlink has no confidence interval, so confFilter is unused. v12.21
    // requires confFilterBps in [50, 1000]; pick the floor as a no-op value.
    confFilterBps:        50,
    // $5/day target for SOL-9 collateral: 270 lamports/slot × 216 000 = 58.3 M/day
    maintenanceFeePerSlot: "270",
    // Leverage: 5× (20% IM / 10% MM)
    initialMarginBps:      "2000",
    maintenanceMarginBps:  "1000",
    // SOL-denominated minimums (~$10 at SOL=$85 is 0.118 SOL)
    // v12.20: min_initial_deposit is gone; the dust gate is now the
    // insurance-destined new_account_fee charged on every InitUser.
    // v12.21 §1.4 envelope: at the floor account size, worst-case liq fee
    // must fit within the MM floor. Keep minLiquidationAbs ≪ minNonzeroMmReq.
    newAccountFee:        "118000000",    // 0.118 SOL ≈ $10 into insurance per account
    minNonzeroMmReq:      "10000000",     // 0.01 SOL — covers liq-fee floor (1M) with headroom
    minNonzeroImReq:      "20000000",     // 0.02 SOL (2× MM)
    liquidationFeeCap:    "11700000000",  // 11.7 SOL cap ≈ $1 000 max
    minLiquidationAbs:    "1000000",      // 0.001 SOL — small floor so envelope holds
    // v12.21: hard cap permissionlessResolveStaleSlots <= MAX_ACCRUAL_DT_SLOTS = 100.
    // 100 slots ≈ 40 sec — operationally requires a continuous (sub-40s) cranker.
    // The §14.1 invariant also forces h_max <= perm_resolve, so warmup ceilings
    // collapse to ≤ 40 s.
    permissionlessResolveStaleSlots: "100",
    forceCloseDelaySlots:            "200",
    maxCrankStalenessSlots:          "0",   // v12.21 read+discard
    hMin:                            "10",    // ~4 s warmup floor
    hMax:                            "100",   // ~40 s warmup ceiling (= perm-resolve)
    // v12.20 removed max_insurance_floor — no admin-side cap to seed.
    // Insurance-operator path stays live at init with a per-call cap; burned after.
    insuranceWithdrawMaxBps:         100,       // 1% per tx (soft-rate-limited via operator before burn)
    insuranceWithdrawCooldownSlots:  "10",
  });
  {
    const keys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      payer.publicKey, slab.publicKey, NATIVE_MINT, vaultAcc.address,
      WELL_KNOWN.clock, CHAINLINK_SOL_USD,
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

  // ── Step 9: UpdateConfig — enable 20× deposit cap ──
  console.log("\n[9] UpdateConfig: tvlInsuranceCapMult = 20 (deposit cap = 20 × insurance)...");
  {
    const keys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, CHAINLINK_SOL_USD,
    ]);
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeUpdateConfig({
          fundingHorizonSlots:  "7200",
          fundingKBps:          "100",
          fundingMaxPremiumBps: "500",
          fundingMaxE9PerSlot:  "1000",
          tvlInsuranceCapMult:  20,
        }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    const cCheck = parseConfig(await fetchSlab(conn, slab.publicKey));
    if (cCheck.tvlInsuranceCapMult !== 20) {
      throw new Error(`tvlInsuranceCapMult verification: got ${cCheck.tvlInsuranceCapMult}`);
    }
    console.log(`    ✓ cap active: c_tot ≤ 20 × insurance (${Number(INSURANCE_FUND_AMOUNT)*20/LAMPORTS_PER_SOL} SOL max)`);
  }

  // ── Step 10: Burn authorities (ADMIN last) ──
  // v12.20 merged the former CLOSE kind into ADMIN. For NON-HYPERP markets
  // (like this Chainlink one) `hyperp_authority` is already zeroed at
  // InitMarket (wrapper sets it to [0; 32] when is_hyperp=false), so it
  // cannot and need not be burned — the burn tx would fail signing as
  // Pubkey::default. That leaves three live authorities to burn.
  console.log("\n[10] Burning authorities (hyperp_mark already zero at init for non-Hyperp)...");
  const ZERO = PublicKey.default;
  for (const [name, kind] of [
    ["INSURANCE_OPERATOR", AUTHORITY_KIND.INSURANCE_OPERATOR],
    ["INSURANCE",          AUTHORITY_KIND.INSURANCE],
    ["ADMIN",              AUTHORITY_KIND.ADMIN], // must be last
  ] as const) {
    const keys = buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [payer.publicKey, ZERO, slab.publicKey]);
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeUpdateAuthority({ kind, newPubkey: ZERO }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    ✓ ${name} burned`);
  }

  // ── Step 11: verify state ──
  console.log("\n[9] Verifying final market state...");
  const final = await conn.getAccountInfo(slab.publicKey);
  if (!final) throw new Error("slab fetch failed");
  const h = parseHeader(final.data);
  const c = parseConfig(final.data);
  const e = parseEngine(final.data);
  const indices = parseUsedIndices(final.data);
  const ZERO_KEY = PublicKey.default;
  const status = (pk: PublicKey) => pk.equals(ZERO_KEY) ? "🔥 BURNED" : pk.toBase58();
  console.log(`    admin:              ${status(h.admin)}`);
  console.log(`    hyperp_authority:   ${status(c.hyperpAuthority)}`);
  console.log(`    insurance_auth:     ${status(h.insuranceAuthority)}`);
  console.log(`    insurance_operator: ${status(h.insuranceOperator)}`);
  console.log(`    inverted:          ${c.invert === 1 ? "yes" : "no"}`);
  console.log(`    tvl_cap_mult:      ${c.tvlInsuranceCapMult} (deposit cap = k × insurance)`);
  console.log(`    perm_resolve:      ${c.permissionlessResolveStaleSlots} slots (~${Number(c.permissionlessResolveStaleSlots)*0.4/3600}h)`);
  console.log(`    force_close delay: ${c.forceCloseDelaySlots} slots (~${Number(c.forceCloseDelaySlots)*0.4/3600}h)`);
  console.log(`    maint fee / slot:  ${c.maintenanceFeePerSlot} (~${Number(c.maintenanceFeePerSlot)*216000/1e9} SOL/day/account)`);
  console.log(`    unit_scale:        ${c.unitScale}`);
  console.log(`    max_staleness:     ${c.maxStalenessSecs}`);
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
    insuranceFundUsd: "≈ $500 at SOL=$85",
    tvlInsuranceCapMult: 20,
    tvlCapUsd: "≈ $10 000 max c_tot",
    admin: "🔥 BURNED",
    insuranceAuthority: "🔥 BURNED",
    insuranceOperator: "🔥 BURNED",
    hyperpAuthority: "🔥 BURNED",
    initialAdminAta: adminAta.address.toBase58(),
    maintenanceFeePerSlot: initArgs.maintenanceFeePerSlot,
    expectedDailyFee: "≈ 0.058 SOL/account/day (≈ $5 @ SOL=$85)",
    permissionlessResolveStaleSlots: initArgs.permissionlessResolveStaleSlots,
    forceCloseDelaySlots: initArgs.forceCloseDelaySlots,
    autoShutdown: "48h oracle stale → ResolvePermissionless; 48h post-resolve → ForceCloseResolved",
  };
  fs.writeFileSync("devnet-market.json", JSON.stringify(out, null, 2));
  console.log("\n    devnet-market.json written.");

  const endBal = await conn.getBalance(payer.publicKey);
  console.log(`\nSOL spent:  ${((startBal - endBal) / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log(`SOL left:   ${(endBal / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log("═".repeat(70));
}

main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
