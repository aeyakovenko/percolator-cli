/**
 * Mainnet bounty #2 deploy — bounty_sol_20x_max (max_risk.md spec).
 *
 * Differences from setup-devnet-max-risk.ts:
 *   - Targets MAINNET, NEW program id (set MAINNET_BOUNTY2_PROGRAM_ID below
 *     after deploying the BPF; defaults to a placeholder so this script
 *     refuses to run unconfigured).
 *   - NO matcher, NO LP — third parties provision liquidity (per the
 *     deprecated v1 mainnet model). Saves ~1 SOL of LP collateral + matcher
 *     ctx rent.
 *   - 5 SOL insurance seed (~$425 at SOL=$85, smaller than max_risk.md's
 *     $1k spec to fit a ~24 SOL wallet).
 *   - Uses Pyth SOL/USD PriceUpdateV2 instead of Chainlink.
 *
 * Total estimated cost ~18.85 SOL:
 *   program rent           ~3.12 SOL
 *   slab rent             ~10.62 SOL
 *   vault ATA rent         ~0.002 SOL
 *   wrap headroom + insurance  5.10 SOL
 *   tx fees + buffer       ~0.10 SOL
 *
 * Pre-deployment:
 *   1. Build percolator-prog at commit cc0650a:
 *      cd /home/anatoly/percolator-prog && cargo build-sbf
 *      sha256sum target/deploy/percolator_prog.so
 *      # expected: 7c5b75aff1bd2a3f9ea145b63ee74a0c55d3af50922e802dac63388ef0639d1e
 *   2. Generate a fresh program keypair:
 *      solana-keygen new --no-bip39-passphrase -o ~/percolator-bounty2-prog.json
 *   3. Deploy:
 *      solana program deploy --url mainnet-beta \
 *        --program-id ~/percolator-bounty2-prog.json \
 *        /home/anatoly/percolator-prog/target/deploy/percolator_prog.so
 *   4. Set MAINNET_BOUNTY2_PROGRAM_ID below to the program pubkey.
 *   5. npx tsx scripts/setup-mainnet-bounty2.ts
 *
 * Post-deployment:
 *   - Verify mainnet-bounty2-market.json values match max_risk.md.
 *   - Burn upgrade authority:
 *      solana program set-upgrade-authority --url mainnet-beta \
 *        <PROGRAM_ID> --new-upgrade-authority null
 *
 * Win condition (per spec §8): cause `engine.insurance_fund.balance` to
 * decrease below its current value via any sequence of public calls.
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
  encodeInitMarket, encodeTopUpInsurance, encodeKeeperCrank,
  encodeUpdateConfig, encodeUpdateAuthority, AUTHORITY_KIND,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_TOPUP_INSURANCE, ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_UPDATE_CONFIG, ACCOUNTS_UPDATE_ADMIN,
  buildAccountMetas, WELL_KNOWN,
} from "../src/abi/accounts.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import {
  parseHeader, parseConfig, parseEngine, fetchSlab, SLAB_LEN,
} from "../src/solana/slab.js";
import { buildIx } from "../src/runtime/tx.js";
import { prodInitMarketArgs } from "./_default-market.js";

// ============================================================================
// CONSTANTS — fill in after BPF deploy
// ============================================================================

const MAINNET_BOUNTY2_PROGRAM_ID =
  process.env.PERCOLATOR_PROGRAM_ID ?? "FILL_IN_AFTER_BPF_DEPLOY";

// Pyth SOL/USD PriceUpdateV2 (sponsored shard-0)
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const PYTH_RECEIVER_OWNER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const PYTH_SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// 5 SOL insurance seed; wrap a tiny extra for atomic SyncNative + tx fees
const INSURANCE_FUND_AMOUNT = 5_000_000_000n;
const WRAP_AMOUNT = 5.05 * LAMPORTS_PER_SOL;

// Priority fee — set high enough to land first try on a busy mainnet day
const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 50_000;
const withPriority = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS }),
];

// ============================================================================
// PYTH VERIFICATION
// ============================================================================

async function verifyPyth(conn: Connection) {
  const info = await conn.getAccountInfo(PYTH_SOL_USD);
  if (!info) throw new Error(`Pyth feed not found: ${PYTH_SOL_USD.toBase58()}`);
  if (info.owner.toBase58() !== PYTH_RECEIVER_OWNER) {
    throw new Error(`Pyth owner mismatch: got ${info.owner.toBase58()}, expected ${PYTH_RECEIVER_OWNER}`);
  }
  // PriceUpdateV2: discriminator(8)+write_authority(32)+verification(2)+feed_id(32)
  // +price@74(8)+conf@82(8)+expo@90(4)+publish_time@94(8)
  const d = info.data;
  const price = d.readBigInt64LE(74);
  const expo = d.readInt32LE(90);
  const publishTs = Number(d.readBigInt64LE(94));
  const priceUsd = Number(price) * Math.pow(10, expo);
  const ageSec = Math.floor(Date.now() / 1000) - publishTs;
  console.log(`    Pyth SOL/USD: $${priceUsd.toFixed(4)}  (age ${ageSec}s)`);
  if (ageSec > 60) {
    throw new Error(`Pyth feed stale: age ${ageSec}s > 60s — abort deploy`);
  }
  return priceUsd;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("PERCOLATOR — MAINNET BOUNTY #2 (bounty_sol_20x_max, no LP)");
  console.log("══════════════════════════════════════════════════════════════════════");

  if (MAINNET_BOUNTY2_PROGRAM_ID === "FILL_IN_AFTER_BPF_DEPLOY") {
    throw new Error(
      "Set PERCOLATOR_PROGRAM_ID env var or edit MAINNET_BOUNTY2_PROGRAM_ID after deploying the BPF."
    );
  }
  const PROGRAM_ID = new PublicKey(MAINNET_BOUNTY2_PROGRAM_ID);

  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8")
  )));
  console.log(`RPC:    ${rpc}`);
  console.log(`Wallet: ${payer.publicKey.toBase58()}`);
  const balLamports = await conn.getBalance(payer.publicKey);
  console.log(`SOL:    ${(balLamports / LAMPORTS_PER_SOL).toFixed(4)}`);
  if (balLamports < 19 * LAMPORTS_PER_SOL) {
    throw new Error(`Insufficient SOL — need ≥ 19, have ${balLamports / LAMPORTS_PER_SOL}`);
  }

  console.log("\n[1] Verifying Pyth SOL/USD feed...");
  await verifyPyth(conn);

  // ── Step 2: slab account ──
  console.log("\n[2] Creating slab account...");
  const slab = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(SLAB_LEN);
  console.log(`    slab: ${slab.publicKey.toBase58()}`);
  console.log(`    size: ${SLAB_LEN} bytes  rent: ${(rent / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  {
    const t = new Transaction()
      .add(...withPriority(50_000))
      .add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
        lamports: rent, space: SLAB_LEN, programId: PROGRAM_ID,
      }));
    await sendAndConfirmTransaction(conn, t, [payer, slab], { commitment: "confirmed" });
  }

  // ── Step 3: vault PDA + ATA ──
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slab.publicKey);
  const vaultAcc = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, vaultPda, true);
  console.log(`    vault PDA:  ${vaultPda.toBase58()}`);
  console.log(`    vault ATA:  ${vaultAcc.address.toBase58()}`);

  // ── Step 4: InitMarket (max_risk.md verbatim) ──
  console.log("\n[3] InitMarket — bounty_sol_20x_max (mm=im=500, h_min=0, max_move=49)...");
  const initArgs = prodInitMarketArgs(payer.publicKey, NATIVE_MINT, {
    indexFeedId:          PYTH_SOL_USD_FEED_ID,
    initialMarkPriceE6:   "0",                // non-Hyperp; engine reads Pyth at init
    unitScale:            0,
    invert:               1,                  // mark = SOL per USD
    maxStalenessSecs:     "60",
    confFilterBps:        50,                 // wrapper minimum

    // ─── max_risk.md RiskParams (verbatim) ───
    maintenanceMarginBps:  "500",             // mm = im (no opening buffer)
    initialMarginBps:      "500",             // 1/L = 5%, 20x nominal max
    tradingFeeBps:         "1",               // 0.01% — most aggressive globally
    liquidationFeeBps:     "5",               // 0.05% — frees envelope budget
    maxPriceMoveBpsPerSlot:"49",              // 99.2% of §1.4 envelope ceiling
    minNonzeroMmReq:       "500",             // gives exact-N proof room
    minNonzeroImReq:       "600",
    minLiquidationAbs:     "0",               // no per-call dust floor
    liquidationFeeCap:     "50000000000",     // $50K cap (in atomic; pegged)

    // h_min=0 fast-path now accepted by wrapper. h_max in slots = ~9.6h.
    hMin:                            "0",
    hMax:                            "86400",

    // perm_resolve & force_close are deployer choices. 432_000 slots ≈ 48h
    // (matches the deprecated v1 mainnet's auto-shutdown window).
    permissionlessResolveStaleSlots: "432000",
    forceCloseDelaySlots:            "432000",
    maxCrankStalenessSlots:          "0",     // wrapper read+discards in v12.21

    // Anti-spam fees — bounty_sol_20x §4 in SOL terms (SOL@~$85)
    // creation fee: $0.50 ≈ 0.00588 SOL = 5_882_000 lamports
    // recurring:    $1.08/day flat = 5 atomic/slot in USDC; for SOL we
    //               pick a comparable lamport rate — 5 lamports/slot
    //               ≈ 1.08M lamports/day = 0.00108 SOL/day ≈ $0.092/day.
    // (Adjust upward if you want stronger anti-spam; the spec target is
    // $1/day which on SOL≈$85 is ~58 lamports/slot.)
    newAccountFee:         "5882000",
    maintenanceFeePerSlot: "58",              // ~$1/day SOL-denominated

    // Insurance withdraw policy live at init; both burned at end of script.
    insuranceWithdrawMaxBps:         100,     // 1% per tx
    insuranceWithdrawCooldownSlots:  "10",
  });
  {
    const keys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      payer.publicKey, slab.publicKey, NATIVE_MINT, vaultAcc.address,
      WELL_KNOWN.clock, PYTH_SOL_USD,
    ]);
    const t = new Transaction()
      .add(...withPriority(400_000))
      .add(buildIx({ programId: PROGRAM_ID, keys, data: encodeInitMarket(initArgs) }));
    const sig = await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    sig: ${sig.slice(0, 40)}...`);
  }

  // ── Step 5: warm-up keeper crank ──
  console.log("\n[4] Initial permissionless KeeperCrank...");
  const crankIx = () => buildIx({
    programId: PROGRAM_ID,
    keys: buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, PYTH_SOL_USD,
    ]),
    data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }),
  });
  await sendAndConfirmTransaction(conn,
    new Transaction().add(...withPriority(400_000)).add(crankIx()),
    [payer], { commitment: "confirmed", skipPreflight: true });

  // ── Step 6: wrap SOL ──
  console.log("\n[5] Wrapping SOL for insurance fund...");
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  {
    const t = new Transaction()
      .add(...withPriority(30_000))
      .add(SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: adminAta.address, lamports: WRAP_AMOUNT,
      }))
      .add({
        programId: TOKEN_PROGRAM_ID,
        keys: [{ pubkey: adminAta.address, isSigner: false, isWritable: true }],
        data: Buffer.from([17]), // SyncNative
      });
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    wrapped ${(WRAP_AMOUNT / LAMPORTS_PER_SOL).toFixed(4)} SOL → ${adminAta.address.toBase58()}`);
  }

  // ── Step 7: TopUpInsurance — 5 SOL bounty seed ──
  console.log("\n[6] Seeding insurance fund (bounty target = 5 SOL)...");
  {
    const t = new Transaction()
      .add(...withPriority(400_000))
      .add(crankIx())
      .add(buildIx({
        programId: PROGRAM_ID,
        keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
          payer.publicKey, slab.publicKey, adminAta.address, vaultAcc.address,
          WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
        ]),
        data: encodeTopUpInsurance({ amount: INSURANCE_FUND_AMOUNT.toString() }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    insurance += ${(Number(INSURANCE_FUND_AMOUNT) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }

  // ── Step 8: UpdateConfig — enable 20× deposit cap ──
  console.log("\n[7] UpdateConfig: tvlInsuranceCapMult = 20...");
  {
    const t = new Transaction()
      .add(...withPriority(60_000))
      .add(crankIx())
      .add(buildIx({
        programId: PROGRAM_ID,
        keys: buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
          payer.publicKey, slab.publicKey, WELL_KNOWN.clock, PYTH_SOL_USD,
        ]),
        data: encodeUpdateConfig({
          fundingHorizonSlots:  "7200",
          fundingKBps:          "100",
          fundingMaxPremiumBps: "500",
          fundingMaxE9PerSlot:  "1000",
          tvlInsuranceCapMult:  20,
        }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    const c = parseConfig(await fetchSlab(conn, slab.publicKey));
    if (c.tvlInsuranceCapMult !== 20) {
      throw new Error(`tvl_cap_mult verification: got ${c.tvlInsuranceCapMult}`);
    }
    console.log(`    ✓ deposit cap active: c_tot ≤ 20 × ${(Number(INSURANCE_FUND_AMOUNT) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }

  // ── Step 9: Burn 3 market authorities (ADMIN last) ──
  // NON-Hyperp markets initialize hyperp_authority = Pubkey::default()
  // automatically (line 4791 in wrapper), so it's already burned.
  console.log("\n[8] Burning 3 market authorities (hyperp_mark already zero for non-Hyperp)...");
  const ZERO = PublicKey.default;
  for (const [name, kind] of [
    ["INSURANCE_OPERATOR", AUTHORITY_KIND.INSURANCE_OPERATOR],
    ["INSURANCE",          AUTHORITY_KIND.INSURANCE],
    ["ADMIN",              AUTHORITY_KIND.ADMIN], // must be last
  ] as const) {
    const t = new Transaction()
      .add(...withPriority(60_000))
      .add(buildIx({
        programId: PROGRAM_ID,
        keys: buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [payer.publicKey, ZERO, slab.publicKey]),
        data: encodeUpdateAuthority({ kind, newPubkey: ZERO }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    ✓ ${name} burned`);
  }

  // ── Step 10: verify final state ──
  console.log("\n[9] Verifying final market state...");
  const buf = await fetchSlab(conn, slab.publicKey);
  const h = parseHeader(buf);
  const c = parseConfig(buf);
  const e = parseEngine(buf);

  const burned = (pk: PublicKey) => pk.equals(PublicKey.default) ? "🔥 BURNED" : pk.toBase58();
  console.log(`    admin:              ${burned(h.admin)}`);
  console.log(`    hyperp_authority:   ${burned(c.hyperpAuthority)}`);
  console.log(`    insurance_auth:     ${burned(h.insuranceAuthority)}`);
  console.log(`    insurance_operator: ${burned(h.insuranceOperator)}`);
  console.log(`    inverted:           ${c.invert ? "yes" : "no"}`);
  console.log(`    perm_resolve:       ${c.permissionlessResolveStaleSlots} slots (~${(Number(c.permissionlessResolveStaleSlots) * 0.4 / 3600).toFixed(2)}h)`);
  console.log(`    force_close delay:  ${c.forceCloseDelaySlots} slots (~${(Number(c.forceCloseDelaySlots) * 0.4 / 3600).toFixed(2)}h)`);
  console.log(`    maint fee/slot:     ${c.maintenanceFeePerSlot} (~${(Number(c.maintenanceFeePerSlot) * 216_000 / LAMPORTS_PER_SOL).toFixed(6)} SOL/day/account)`);
  console.log(`    new_account_fee:    ${c.newAccountFee} (~${(Number(c.newAccountFee) / LAMPORTS_PER_SOL).toFixed(4)} SOL → insurance)`);
  console.log(`    last_oracle_price:  ${e.lastOraclePrice} (engine-space, after invert)`);
  console.log(`    vault:              ${e.vault} (= ${(Number(e.vault) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log(`    insurance:          ${e.insuranceFund.balance} (= ${(Number(e.insuranceFund.balance) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  console.log(`    market_mode:        ${e.marketMode === 0 ? "Live" : "Resolved"}`);

  const out = {
    network: "mainnet",
    bountyVersion: "bounty_sol_20x_max",
    createdAt: new Date().toISOString(),
    programId: PROGRAM_ID.toBase58(),
    slab: slab.publicKey.toBase58(),
    slabSize: SLAB_LEN,
    mint: NATIVE_MINT.toBase58(),
    collateral: "wSOL (9 decimals, unit_scale=0)",
    vault: vaultAcc.address.toBase58(),
    vaultPda: vaultPda.toBase58(),
    oracle: PYTH_SOL_USD.toBase58(),
    oracleType: "pyth_pull",
    feedId: PYTH_SOL_USD_FEED_ID,
    inverted: true,
    insuranceFundLamports: e.insuranceFund.balance.toString(),
    insuranceFundSol: Number(e.insuranceFund.balance) / LAMPORTS_PER_SOL,
    tvlInsuranceCapMult: c.tvlInsuranceCapMult,
    matcher: "(none — third parties provision their own)",
    admin: "🔥 BURNED",
    insuranceAuthority: "🔥 BURNED",
    insuranceOperator: "🔥 BURNED",
    hyperpAuthority: "🔥 BURNED (auto for non-Hyperp at init)",
    riskParams: {
      maintenance_margin_bps: 500,
      initial_margin_bps: 500,
      trading_fee_bps: 1,
      liquidation_fee_bps: 5,
      max_price_move_bps_per_slot: 49,
      h_min: 0,
      h_max: 86400,
      min_nonzero_mm_req: 500,
      min_nonzero_im_req: 600,
      min_liquidation_abs: 0,
      liquidation_fee_cap: 50_000_000_000,
    },
    permissionlessResolveStaleSlots: c.permissionlessResolveStaleSlots.toString(),
    forceCloseDelaySlots: c.forceCloseDelaySlots.toString(),
    autoShutdown: "48h oracle stale → ResolvePermissionless; 48h post-resolve → ForceCloseResolved",
    nextSteps: [
      "solana program set-upgrade-authority --url mainnet-beta " +
        PROGRAM_ID.toBase58() + " --new-upgrade-authority null",
      "Verify on-chain match: sha256sum target/deploy/percolator_prog.so against deployed program",
      "Announce bounty (Twitter, Immunefi, etc.)",
    ],
  };

  fs.writeFileSync("mainnet-bounty2-market.json", JSON.stringify(out, null, 2));
  console.log("\n    mainnet-bounty2-market.json written.");
  const finalBal = await conn.getBalance(payer.publicKey);
  console.log(`\nSOL spent:  ${((balLamports - finalBal) / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log(`SOL left:   ${(finalBal / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("Next: burn the program upgrade authority. Command in mainnet-bounty2-market.json");
  console.log("══════════════════════════════════════════════════════════════════════");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
