/**
 * Deploy ../percolator-stress/max_risk.md ("bounty_sol_20x_max") to devnet.
 *
 * Current wrapper (post-bounty-2-cleanup) accepts every spec value
 * verbatim — `h_min=0` is decoupled from the perm-resolve floor and
 * `MAX_PROFIT_MATURITY_SLOTS=6_480_000` clears `h_max=86_400`. No
 * spec adaptation required.
 *
 * Spec-faithful values that deploy as-is:
 *   maintenance_margin_bps       = 500   (= im, no opening buffer)
 *   initial_margin_bps           = 500   (1/L = 5%, 20x max nominal)
 *   trading_fee_bps              =   1
 *   liquidation_fee_bps          =   5
 *   max_price_move_bps_per_slot  =  49   (99.2% of §1.4 envelope at mm=500)
 *   max_accrual_dt_slots         =  10
 *   min_nonzero_mm_req           = 500
 *   min_nonzero_im_req           = 600
 *   min_liquidation_abs          =   0
 *   liquidation_fee_cap          = 50_000_000_000
 *
 * Collateral: wrapped SOL (9 dec, unit_scale=0). Oracle: Chainlink SOL/USD
 * (devnet — same feed the v12.21 reference market uses).
 *
 * Writes the deployment summary to devnet-max-risk-market.json.
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

  // ── Step 4: InitMarket (max_risk.md spec) ──
  console.log("\n[3] InitMarket (bounty_sol_20x_max — §1.4 envelope-ceiling config)...");
  const feedIdHex = Buffer.from(CHAINLINK_SOL_USD.toBytes()).toString("hex");
  const initArgs = prodInitMarketArgs(payer.publicKey, NATIVE_MINT, {
    indexFeedId:          feedIdHex,
    initialMarkPriceE6:   "0",          // non-Hyperp; engine reads Chainlink at init
    unitScale:            0,
    invert:               1,            // SOL-per-USD mark
    maxStalenessSecs:     "60",
    confFilterBps:        50,           // v12.21 floor

    // ─── max_risk.md RiskParams (verbatim) ───
    maintenanceMarginBps:  "500",       // mm = im (no opening buffer)
    initialMarginBps:      "500",       // 1/L = 5%, 20x nominal
    tradingFeeBps:         "1",         // most aggressive globally
    liquidationFeeBps:     "5",         // frees envelope for max_move
    // 1c2de3c wrapper: MAX_ACCRUAL_DT_SLOTS=10, h_min=0 allowed.
    // Spec target: max_move=49 × max_dt=10 = 490 bps/accrual.
    // §1.4 envelope: 49*10 + 1 (funding) + 5 (liq) = 496 < 500 (mm) ✓
    maxPriceMoveBpsPerSlot:"49",        // 99.2% of §1.4 envelope ceiling
    minNonzeroMmReq:       "500",       // = mm, gives exact-N proof room
    minNonzeroImReq:       "600",
    minLiquidationAbs:     "0",         // wrapper enforces dust gate via newAccountFee
    liquidationFeeCap:     "50000000000",

    // h_min=0 fast-path, h_max=86_400, and perm_resolve decoupled from
    // MAX_ACCRUAL_DT_SLOTS (commits 715215f + cc0650a).
    hMin:                            "0",       // SPEC FAITHFUL fast-path
    hMax:                            "86400",   // SPEC FAITHFUL ~9.6h profit maturity ceiling
    permissionlessResolveStaleSlots: "48",      // ~19 s auto-shutdown window for this test
    forceCloseDelaySlots:            "96",      // 2× perm_resolve
    maxCrankStalenessSlots:          "0",       // v12.21 read+discard

    // Anti-spam (max_risk.md §4 inherits from config.md §4 with
    // SOL-denominated dollar conversions at SOL ≈ $85)
    newAccountFee:         "5882000",   // 0.005882 SOL ≈ $0.50 → insurance
    maintenanceFeePerSlot: "5",         // spec rate (USDC atomic/slot literal)

    // Insurance-operator path: keep live at init, burn afterward
    insuranceWithdrawMaxBps:         100,
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
  // Helper: bundle a fresh KeeperCrank with an oracle-sensitive ix so the
  // engine sees a freshly-updated `last_good_oracle_slot`. With the new
  // MAX_ACCRUAL_DT_SLOTS=10 (and perm_resolve_stale_slots=10), any tx that
  // touches the oracle after ~10 slots of staleness fires OracleStale (0x6).
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    payer.publicKey, slab.publicKey, WELL_KNOWN.clock, CHAINLINK_SOL_USD,
  ]);
  const crankIx = () => buildIx({
    programId: PROGRAM_ID, keys: crankKeys,
    data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }),
  });
  {
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(crankIx());
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

  // ── Step 8: deposit LP collateral (with crank prefix) ──
  // perm_resolve_stale_slots=10 means oracle-touching tx fail OracleStale
  // after ~4 sec without a fresh KeeperCrank update to last_good_oracle_slot.
  // Bundle a crank with each oracle-sensitive instruction.
  console.log("\n[7] Depositing LP collateral...");
  {
    const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      payer.publicKey, slab.publicKey, adminAta.address, vaultAcc.address,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 460_000 }))
      .add(crankIx())
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeDepositCollateral({ userIdx: 0, amount: LP_COLLATERAL_AMOUNT.toString() }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    deposited ${Number(LP_COLLATERAL_AMOUNT) / LAMPORTS_PER_SOL} SOL`);
  }

  // ── Step 9: insurance top-up (with crank prefix) ──
  console.log("\n[8] Topping up insurance fund...");
  {
    const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
      payer.publicKey, slab.publicKey, adminAta.address, vaultAcc.address,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 460_000 }))
      .add(crankIx())
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeTopUpInsurance({ amount: INSURANCE_FUND_AMOUNT.toString() }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    insurance += ${Number(INSURANCE_FUND_AMOUNT) / LAMPORTS_PER_SOL} SOL`);
  }

  // ── Step 9: UpdateConfig — enable 20× deposit cap (with crank prefix) ──
  console.log("\n[9] UpdateConfig: tvlInsuranceCapMult = 20 (deposit cap = 20 × insurance)...");
  {
    const keys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, CHAINLINK_SOL_USD,
    ]);
    const t = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 460_000 }))
      .add(crankIx())
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
  fs.writeFileSync("devnet-max-risk-market.json", JSON.stringify(out, null, 2));
  console.log("\n    devnet-max-risk-market.json written.");

  const endBal = await conn.getBalance(payer.publicKey);
  console.log(`\nSOL spent:  ${((startBal - endBal) / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log(`SOL left:   ${(endBal / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log("═".repeat(70));
}

main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
