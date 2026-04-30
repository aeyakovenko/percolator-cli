/**
 * Provision a persistent inverted SOL/USD market on MAINNET.
 *
 * Collateral: wrapped SOL (9 decimals, unit_scale=0 → 1 lamport = 1 engine unit).
 * Oracle:     Pyth SOL/USD PriceUpdateV2 `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`
 *             (sponsored shard-0, feed_id ef0d8b6f…c280b56d).
 * Invert:     1 — mark reads as "SOL per USD" (1e12 / raw_e6).
 *
 * NO matcher / LP is deployed — third parties provision those.
 *
 * Final state: all 3 market authorities burned (admin last). The upgrade
 * authority is burned separately via `solana program set-upgrade-authority --final`.
 *
 * Writes the deployment summary to mainnet-market.json.
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
// CONSTANTS (mainnet)
// ============================================================================

const PROGRAM_ID = new PublicKey("BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw");

// Pyth SOL/USD PriceUpdateV2 (sponsored shard 0), owner rec5EKMG…
const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
// Canonical SOL/USD feed id (32 bytes hex).
const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Funding amount (wrapped SOL, 9 decimals). 5 SOL insurance fund.
const INSURANCE_FUND_AMOUNT = 5_000_000_000n;
// wrap headroom: 5 SOL insurance + ~0.1 SOL fees/ata/wrap overhead
const WRAP_AMOUNT_LAMPORTS = 5_200_000_000;

// Priority fee: 1 microlamport per CU → effectively 0 lamports on a ~300k CU tx.
const PRIORITY_FEE_MICROLAMPORTS = 1;

// ============================================================================
// PYTH LIVENESS CHECK (decode the PriceUpdateV2 account layout we expect)
// ============================================================================

function decodePythPriceUpdateV2(data: Buffer) {
  if (data.length < 134) throw new Error(`PriceUpdateV2 too short: ${data.length}`);
  // Layout (v12.20 wrapper expects Full verification):
  //   discriminator(8) + write_authority(32) + verification_level(1 byte for Full) +
  //   PriceFeedMessage(84) + posted_slot(8) = 133 used, 134 allocated.
  const vlevel = data.readUInt8(40);
  if (vlevel !== 1) {
    throw new Error(`Pyth account is not Full-verified (tag=${vlevel}); wrapper rejects Partial`);
  }
  const off = 41;
  const feedId = data.subarray(off, off + 32).toString("hex");
  const price = data.readBigInt64LE(off + 32);
  const conf = data.readBigUInt64LE(off + 40);
  const expo = data.readInt32LE(off + 48);
  const publishTime = data.readBigInt64LE(off + 52);
  return { feedId, price, conf, expo, publishTime };
}

async function verifyPythOracle(conn: Connection) {
  const info = await conn.getAccountInfo(PYTH_SOL_USD);
  if (!info) throw new Error(`Pyth PriceUpdateV2 not found: ${PYTH_SOL_USD.toBase58()}`);
  if (info.owner.toBase58() !== PYTH_RECEIVER) {
    throw new Error(`Pyth account owner mismatch: got ${info.owner.toBase58()}`);
  }
  const decoded = decodePythPriceUpdateV2(Buffer.from(info.data));
  if (decoded.feedId !== SOL_USD_FEED_ID) {
    throw new Error(`Feed id mismatch: got ${decoded.feedId}`);
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  const age = now - decoded.publishTime;
  if (age < 0n || age > 60n) {
    throw new Error(`Pyth feed stale: age=${age}s`);
  }
  const priceUsd = Number(decoded.price) * Math.pow(10, decoded.expo);
  if (priceUsd < 10 || priceUsd > 10000) {
    throw new Error(`Pyth price unreasonable: $${priceUsd.toFixed(2)}`);
  }
  return { priceUsd, publishTime: Number(decoded.publishTime), ageSec: Number(age) };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("═".repeat(70));
  console.log("PERCOLATOR — INVERTED SOL/USD MAINNET MARKET (Pyth, no matcher)");
  console.log("═".repeat(70));

  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");

  console.log(`RPC:     ${rpc}`);
  console.log(`Wallet:  ${payer.publicKey.toBase58()}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  const startBal = await conn.getBalance(payer.publicKey);
  console.log(`SOL:     ${(startBal / LAMPORTS_PER_SOL).toFixed(4)}`);

  // Priority-fee helper: 1 microlamport/CU (rounds to 0 lamports on typical txs).
  const withPriority = (cu: number) => [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }),
  ];

  // ── Step 1: verify Pyth oracle liveness ──
  console.log("\n[1] Verifying Pyth SOL/USD oracle...");
  const { priceUsd, ageSec } = await verifyPythOracle(conn);
  console.log(`    account: ${PYTH_SOL_USD.toBase58()}`);
  console.log(`    price:   $${priceUsd.toFixed(4)} (age ${ageSec}s, Full verification)`);

  // ── Step 2: create slab (or reuse uninitialized orphan if SLAB_PUBKEY env set) ──
  let slabPubkey: PublicKey;
  const slabSignerForCreate: Keypair[] = [];
  if (process.env.SLAB_PUBKEY) {
    slabPubkey = new PublicKey(process.env.SLAB_PUBKEY);
    const info = await conn.getAccountInfo(slabPubkey);
    if (!info) throw new Error(`SLAB_PUBKEY account not found: ${slabPubkey.toBase58()}`);
    if (!info.owner.equals(PROGRAM_ID)) {
      throw new Error(`SLAB_PUBKEY not owned by program: ${info.owner.toBase58()}`);
    }
    if (info.data.length !== SLAB_LEN) {
      throw new Error(`SLAB_PUBKEY size mismatch: got ${info.data.length}, need ${SLAB_LEN}`);
    }
    // If already initialized (magic set), reject — this flow must start from a blank slab.
    if (info.data.readBigUInt64LE(0) === 0x504552434f4c4154n) {
      throw new Error(`SLAB_PUBKEY already initialized (magic present)`);
    }
    console.log(`\n[2] Reusing uninitialized slab: ${slabPubkey.toBase58()}`);
    console.log(`    size: ${info.data.length} bytes  already funded`);
  } else {
    console.log("\n[2] Creating slab account...");
    const slab = Keypair.generate();
    const rent = await conn.getMinimumBalanceForRentExemption(SLAB_LEN);
    console.log(`    slab:  ${slab.publicKey.toBase58()}`);
    console.log(`    size:  ${SLAB_LEN} bytes  rent: ${(rent/LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    const t = new Transaction()
      .add(...withPriority(50_000))
      .add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: slab.publicKey,
        lamports: rent, space: SLAB_LEN, programId: PROGRAM_ID,
      }));
    await sendAndConfirmTransaction(conn, t, [payer, slab], { commitment: "confirmed" });
    slabPubkey = slab.publicKey;
    slabSignerForCreate.push(slab);
  }
  const slab = { publicKey: slabPubkey };

  // ── Step 3: vault PDA + ATA ──
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slab.publicKey);
  const vaultAcc = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, vaultPda, true);
  console.log(`    vault pda: ${vaultPda.toBase58()}`);
  console.log(`    vault ata: ${vaultAcc.address.toBase58()}`);

  // ── Step 4: InitMarket (inverted, Pyth SOL/USD) ──
  console.log("\n[3] InitMarket (inverted Pyth SOL/USD, SOL collateral, $5/day maint, $5 new-account)...");
  const initArgs = prodInitMarketArgs(payer.publicKey, NATIVE_MINT, {
    // Pyth pull oracle (feed_id matches account's PriceFeedMessage.feed_id).
    indexFeedId:          SOL_USD_FEED_ID,
    initialMarkPriceE6:   "0",               // non-Hyperp; wrapper reads oracle at init
    unitScale:            0,
    invert:               1,
    // 60 s Pyth staleness; sponsor refreshes ~every 2 s.
    maxStalenessSecs:     "60",
    // 0.5 % Pyth confidence filter (sponsor typically ~0.02%, very tight).
    confFilterBps:        50,

    // $5/day on SOL-9 collateral at SOL=$87: 265 lamports/slot × 216k = 0.0572 SOL ≈ $4.99.
    maintenanceFeePerSlot: "265",

    // Leverage: 5× (20% IM / 10% MM), same as devnet.
    initialMarginBps:      "2000",
    maintenanceMarginBps:  "1000",

    // v12.20 dust gate. $5 at SOL=$87 ≈ 0.0575 SOL.
    newAccountFee:        "57000000",
    minNonzeroMmReq:      "1200000",      // 0.0012 SOL
    minNonzeroImReq:      "2400000",      // 0.0024 SOL
    liquidationFeeCap:    "11500000000",  // 11.5 SOL cap ≈ $1000
    minLiquidationAbs:    "11500000",     // 0.0115 SOL ≈ $1

    // 48-hour auto-shutdown on oracle stale (432 000 slots @ 400 ms).
    // v12.21: hard cap permissionlessResolveStaleSlots <= MAX_ACCRUAL_DT_SLOTS = 100.
    permissionlessResolveStaleSlots: "100",
    forceCloseDelaySlots:            "200",
    maxCrankStalenessSlots:          "0",   // v12.21 read+discard
    hMin:                            "5000",    // ~33 min warmup floor
    hMax:                            "100000",  // ~11 h warmup ceiling

    // Insurance-operator path active at init with per-call cap; burned after.
    insuranceWithdrawMaxBps:         100,       // 1% per tx
    insuranceWithdrawCooldownSlots:  "10",

    // F2 defense: Hyperp + perm_resolve requires mark_min_fee > 0.
    // Not needed for non-Hyperp, but harmless to set.
    markMinFee:                      "0",
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

  // ── Step 5: permissionless crank — verifies Pyth read-path end-to-end ──
  console.log("\n[4] First permissionless KeeperCrank (Pyth read test)...");
  {
    const keys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, PYTH_SOL_USD,
    ]);
    const t = new Transaction()
      .add(...withPriority(400_000))
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }),
      }));
    const sig = await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed", skipPreflight: true });
    const cfg = parseConfig(await fetchSlab(conn, slab.publicKey));
    const eng = parseEngine(await fetchSlab(conn, slab.publicKey));
    console.log(`    sig:             ${sig.slice(0, 40)}...`);
    console.log(`    lastOraclePrice: ${eng.lastOraclePrice}`);
    console.log(`    lastEffective:   ${cfg.lastEffectivePriceE6} (engine-space, inverted)`);
    if (eng.lastOraclePrice === 0n) {
      throw new Error("Pyth read failed — lastOraclePrice still 0 after crank");
    }
    console.log(`    ✓ Pyth read path works on mainnet`);
  }

  // ── Step 6: wrap + fund insurance (5 SOL) ──
  console.log("\n[5] Wrapping SOL + topping up insurance fund...");
  const payerAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  {
    const t = new Transaction()
      .add(...withPriority(30_000))
      .add(SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: payerAta.address,
        lamports: WRAP_AMOUNT_LAMPORTS,
      }))
      .add({
        programId: TOKEN_PROGRAM_ID,
        keys: [{ pubkey: payerAta.address, isSigner: false, isWritable: true }],
        data: Buffer.from([17]), // SyncNative
      });
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
  }
  {
    const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
      payer.publicKey, slab.publicKey, payerAta.address, vaultAcc.address,
      WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
    ]);
    const t = new Transaction()
      .add(...withPriority(60_000))
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeTopUpInsurance({ amount: INSURANCE_FUND_AMOUNT.toString() }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    insurance += ${Number(INSURANCE_FUND_AMOUNT) / LAMPORTS_PER_SOL} SOL`);
  }

  // ── Step 7: enable 20× deposit cap ──
  console.log("\n[6] UpdateConfig: tvlInsuranceCapMult = 20...");
  {
    const keys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
      payer.publicKey, slab.publicKey, WELL_KNOWN.clock, PYTH_SOL_USD,
    ]);
    const t = new Transaction()
      .add(...withPriority(60_000))
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
      throw new Error(`tvlInsuranceCapMult verification failed: ${cCheck.tvlInsuranceCapMult}`);
    }
    console.log(`    ✓ c_tot cap = 20 × insurance = ${Number(INSURANCE_FUND_AMOUNT)*20/LAMPORTS_PER_SOL} SOL`);
  }

  // ── Step 8: burn 3 market authorities (ADMIN last) ──
  // Non-Hyperp markets have hyperp_authority auto-zeroed at InitMarket
  // (wrapper writes [0;32] when is_hyperp=false). Nothing to burn for it.
  console.log("\n[7] Burning market authorities (hyperp_mark already zero for non-Hyperp)...");
  const ZERO = PublicKey.default;
  for (const [name, kind] of [
    ["INSURANCE_OPERATOR", AUTHORITY_KIND.INSURANCE_OPERATOR],
    ["INSURANCE",          AUTHORITY_KIND.INSURANCE],
    ["ADMIN",              AUTHORITY_KIND.ADMIN], // must be last
  ] as const) {
    const keys = buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [payer.publicKey, ZERO, slab.publicKey]);
    const t = new Transaction()
      .add(...withPriority(60_000))
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeUpdateAuthority({ kind, newPubkey: ZERO }),
      }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    ✓ ${name} burned`);
  }

  // ── Step 9: verify final state ──
  console.log("\n[8] Verifying final state...");
  const final = await fetchSlab(conn, slab.publicKey);
  const h = parseHeader(final);
  const c = parseConfig(final);
  const e = parseEngine(final);
  const ZK = PublicKey.default;
  const status = (pk: PublicKey) => pk.equals(ZK) ? "🔥 BURNED" : pk.toBase58();
  console.log(`    admin:              ${status(h.admin)}`);
  console.log(`    hyperp_authority:   ${status(c.hyperpAuthority)}`);
  console.log(`    insurance_auth:     ${status(h.insuranceAuthority)}`);
  console.log(`    insurance_operator: ${status(h.insuranceOperator)}`);
  console.log(`    vault:              ${Number(e.vault)/LAMPORTS_PER_SOL} SOL`);
  console.log(`    insurance:          ${Number(e.insuranceFund.balance)/LAMPORTS_PER_SOL} SOL`);
  console.log(`    market_mode:        ${e.marketMode === 0 ? "Live" : "Resolved"}`);
  console.log(`    last_oracle_price:  ${e.lastOraclePrice} (engine-space, inverted)`);

  // ── Step 10: save manifest ──
  const out = {
    network: "mainnet-beta",
    createdAt: new Date().toISOString(),
    programId: PROGRAM_ID.toBase58(),
    slab: slab.publicKey.toBase58(),
    slabSize: SLAB_LEN,
    mint: NATIVE_MINT.toBase58(),
    collateral: "wSOL (9 decimals, unit_scale=0)",
    vault: vaultAcc.address.toBase58(),
    vaultPda: vaultPda.toBase58(),
    oracle: PYTH_SOL_USD.toBase58(),
    oracleType: "pyth-pull-priceupdatev2",
    feedId: SOL_USD_FEED_ID,
    inverted: true,
    insuranceFundLamports: Number(INSURANCE_FUND_AMOUNT),
    insuranceFundUsd: `≈ $${(5 * priceUsd).toFixed(0)} at SOL=$${priceUsd.toFixed(2)}`,
    tvlInsuranceCapMult: 20,
    maintenanceFeePerSlot: initArgs.maintenanceFeePerSlot,
    expectedDailyFee: `≈ 0.0572 SOL/account/day ≈ $${(5*0.0572/0.0575).toFixed(2)} at SOL=$${priceUsd.toFixed(2)}`,
    newAccountFee: initArgs.newAccountFee,
    newAccountFeeUsd: `≈ $${(0.057 * priceUsd).toFixed(2)}`,
    permissionlessResolveStaleSlots: initArgs.permissionlessResolveStaleSlots,
    forceCloseDelaySlots: initArgs.forceCloseDelaySlots,
    autoShutdown: "48h oracle stale → ResolvePermissionless; 48h post-resolve → ForceCloseResolved",
    admin: "🔥 BURNED",
    insuranceAuthority: "🔥 BURNED",
    insuranceOperator: "🔥 BURNED",
    hyperpAuthority: "🔥 BURNED (non-Hyperp init)",
    matcher: "NOT DEPLOYED — third parties provision their own",
  };
  fs.writeFileSync("mainnet-market.json", JSON.stringify(out, null, 2));
  console.log(`\n    mainnet-market.json written.`);

  const endBal = await conn.getBalance(payer.publicKey);
  console.log(`\nSOL spent: ${((startBal - endBal) / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log(`SOL left:  ${(endBal / LAMPORTS_PER_SOL).toFixed(4)}`);
  console.log("═".repeat(70));
}

main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
