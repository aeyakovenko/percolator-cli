/**
 * Bounty 4 mainnet launch: 20x-leverage STOXX 50 ETF / SOL perp, hybrid
 * hours-fee mode. The composite mark is:
 *
 *     mark = STOXX50_EUR  *  EUR_per_USD  /  USD_per_SOL  =  STOXX50 / SOL
 *
 * During EU equity hours (07:00-15:30 UTC) all 3 legs are fresh; off-hours
 * the STOXX leg goes stale and the wrapper falls back to the EWMA mark +
 * dynamic trade fee path.
 *
 * Authorities are NOT burned here — they stay on the deployer wallet so
 * we can wind the market down later (lesson learned from bounty 3).
 *
 * Pre-reqs:
 *   - solana program deploy --program-id mainnet-bounty4-percolator.json
 *     ~/percolator-prog/target/deploy/percolator_prog.so
 *   - ~25 SOL liquid in admin wallet (slab 12.22 + insurance 5 + fees 0.3)
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { NATIVE_MINT, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as fs from "fs";

import {
  encodeInitMarket, encodeKeeperCrank, encodeTopUpInsurance, encodeUpdateConfig,
  ORACLE_LEG_FLAG_DIVIDE_LEG3,
} from "../src/abi/instructions.js";
import {
  ACCOUNTS_INIT_MARKET, ACCOUNTS_KEEPER_CRANK, ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_UPDATE_CONFIG, buildAccountMetas, WELL_KNOWN,
} from "../src/abi/accounts.js";
import { fetchSlab, parseHeader, parseConfig, parseEngine, SLAB_LEN } from "../src/solana/slab.js";
import { deriveVaultAuthority } from "../src/solana/pda.js";
import { buildIx } from "../src/runtime/tx.js";

const PROGRAM_ID = new PublicKey("4ToDRrQW5j3oeQm8uTAwV9Rp6NhYfH5E5hMKcXkqfwfz");

// Feed IDs and corresponding Pyth-sponsored shard-0 PriceUpdateV2 accounts.
// Derivation: PDA([shard_id_le_2b, feed_id_32b], pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT).
const LEG1_FEED_ID = "dd08f0a40e21ce42178b25bdd9461a2beebccbaa2a781a6e02b323576c4072ab"; // STOXX 50 ETF / EUR
const LEG2_FEED_ID = "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b"; // EUR / USD
const LEG3_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"; // SOL / USD
const LEG1_ACCOUNT = new PublicKey("C2Cf16vF6LX8GrWJwfZga5z5tjVsax5VWnL2T7Q8CF91");
const LEG2_ACCOUNT = new PublicKey("Fu76ChamBDjE8UuGLV6GP2AcPPSU6gjhkNhAyuoPm7ny");
const LEG3_ACCOUNT = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const PYTH_RECEIVER_OWNER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

const INSURANCE_FUND_AMOUNT = 5_000_000_000n;
const WRAP_AMOUNT = 5.05 * LAMPORTS_PER_SOL;
const withPriority = (units: number) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
];

async function verifyPythLeg(conn: Connection, name: string, addr: PublicKey, allowStale: boolean) {
  const info = await conn.getAccountInfo(addr);
  if (!info) throw new Error(`${name} oracle ${addr.toBase58()} NOT FOUND on chain`);
  if (info.owner.toBase58() !== PYTH_RECEIVER_OWNER) {
    throw new Error(`${name} owner mismatch: got ${info.owner.toBase58()}`);
  }
  const d = info.data;
  const price = d.readBigInt64LE(73);
  const expo = d.readInt32LE(89);
  const publishTs = Number(d.readBigInt64LE(93));
  const priceVal = Number(price) * Math.pow(10, expo);
  const ageSec = Math.floor(Date.now() / 1000) - publishTs;
  console.log(`    ${name}: ${priceVal.toFixed(6)}  age=${ageSec}s ${ageSec > 60 ? (allowStale ? "(stale OK, off-hours)" : "(STALE — REJECT)") : ""}`);
  if (!allowStale && ageSec > 60) throw new Error(`${name} too stale (${ageSec}s) — abort`);
  return priceVal;
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("PERCOLATOR — MAINNET BOUNTY #4 (STOXX50/SOL, 20× lev, hybrid hours-fee)");
  console.log("══════════════════════════════════════════════════════════════════════");

  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
  console.log(`RPC:    ${rpc}`);
  console.log(`Wallet: ${payer.publicKey.toBase58()}`);
  const balLamports = await conn.getBalance(payer.publicKey);
  console.log(`SOL:    ${(balLamports / LAMPORTS_PER_SOL).toFixed(4)}`);

  // Program must already be deployed.
  const progAcc = await conn.getAccountInfo(PROGRAM_ID);
  if (!progAcc || !progAcc.executable) {
    throw new Error(`Program ${PROGRAM_ID.toBase58()} not deployed/executable — run solana program deploy first.`);
  }

  // [0] Verify legs. STOXX is allowed stale (off-hours is expected).
  console.log(`\n[0] Verifying Pyth legs on mainnet...`);
  const stoxx = await verifyPythLeg(conn, "STOXX50/EUR", LEG1_ACCOUNT, true);
  const eurusd = await verifyPythLeg(conn, "EUR/USD", LEG2_ACCOUNT, false);
  const solusd = await verifyPythLeg(conn, "SOL/USD", LEG3_ACCOUNT, false);
  // Display the composite we'd compute if all legs were fresh now:
  console.log(`    composite = STOXX_EUR * EUR_USD / SOL_USD = ${(stoxx * eurusd / solusd).toFixed(6)} SOL/share`);

  // [1] Slab
  console.log(`\n[1] Creating slab account...`);
  const slabPath = `/home/anatoly/percolator-bounty4-slab.json`;
  let slabPubkey: PublicKey;
  let slabKp: Keypair | null = null;
  if (process.env.SLAB_PUBKEY) {
    slabPubkey = new PublicKey(process.env.SLAB_PUBKEY);
    console.log(`    slab: ${slabPubkey.toBase58()}  (reused from $SLAB_PUBKEY)`);
  } else {
    slabKp = Keypair.generate();
    slabPubkey = slabKp.publicKey;
    fs.writeFileSync(slabPath, JSON.stringify(Array.from(slabKp.secretKey)));
    console.log(`    slab: ${slabPubkey.toBase58()}  (keypair → ${slabPath})`);
  }
  const rent = await conn.getMinimumBalanceForRentExemption(SLAB_LEN);
  console.log(`    rent: ${(rent / LAMPORTS_PER_SOL).toFixed(4)} SOL  (size=${SLAB_LEN})`);
  const existing = await conn.getAccountInfo(slabPubkey);
  if (!existing) {
    if (!slabKp) throw new Error("SLAB_PUBKEY override given but slab not on chain");
    const t = new Transaction()
      .add(...withPriority(50_000))
      .add(SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: slabPubkey,
        lamports: rent, space: SLAB_LEN, programId: PROGRAM_ID,
      }));
    await sendAndConfirmTransaction(conn, t, [payer, slabKp!], { commitment: "confirmed" });
    console.log("    slab account created");
  } else {
    console.log("    slab account already exists, skipping");
  }

  // [2] Vault PDA + ATA (wSOL)
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabPubkey);
  const vaultAcc = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, vaultPda, true);
  console.log(`[2] Vault PDA: ${vaultPda.toBase58()}  ATA: ${vaultAcc.address.toBase58()}`);

  // [3] InitMarket — bounty_sol_20x_max + 3-leg composite + hybrid hours fee
  console.log(`\n[3] InitMarket — 20x leverage, hybrid HOURS-FEE, 3-leg composite...`);
  const initData = encodeInitMarket({
    admin: payer.publicKey,
    collateralMint: NATIVE_MINT,
    indexFeedId: LEG1_FEED_ID,
    // Sponsored shard-0 publishes ~every 10 min during EU equity hours;
    // 60s would force-reject during the bulk of trading. 600s is wrapper max
    // and widens the bounty surface (stale-mark arb window up to 10 min).
    maxStalenessSecs: "600",
    confFilterBps: 200,
    invert: 1,                     // mark = SOL per share
    unitScale: 0,
    initialMarkPriceE6: "0",       // non-Hyperp; engine reads composite at init
    maintenanceFeePerSlot: "58",   // ~$1/day flat anti-spam

    // RiskParams — same as bounty 3 max-risk
    hMin: "0", hMax: "6480000",    // ~30d profit-maturity
    maintenanceMarginBps: "500",   // 5% MM → 20× nominal leverage
    initialMarginBps: "500",       // mm = im
    tradingFeeBps: "10000",        // max_trading_fee_bps = 100% (hybrid cap)
    maxAccounts: "4096",
    newAccountFee: "5882000",      // ~$0.50 anti-dust
    maxCrankStalenessSlots: "0",
    liquidationFeeBps: "5",
    liquidationFeeCap: "50000000000",
    resolvePriceDeviationBps: "100",
    minLiquidationAbs: "0",
    minNonzeroMmReq: "500",
    minNonzeroImReq: "600",
    maxPriceMoveBpsPerSlot: "49",  // §1.4 envelope ceiling at mm=500

    // Extended tail
    insuranceWithdrawMaxBps: 0,
    insuranceWithdrawCooldownSlots: "0",
    permissionlessResolveStaleSlots: "6480000",  // ~30d — survives any market weekend
    fundingHorizonSlots: "7200",
    fundingKBps: "100",
    fundingMaxPremiumBps: "500",
    fundingMaxE9PerSlot: "1000",
    markMinFee: "1000",            // anti-dust EWMA threshold
    forceCloseDelaySlots: "216000", // ~24h post-resolve grace

    // 3-leg composite — STOXX_EUR × EUR_USD / SOL_USD
    oracleLegCount: 3,
    oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG3,  // leg3 (SOL/USD) divides
    oracleLeg2FeedId: LEG2_FEED_ID,
    oracleLeg3FeedId: LEG3_FEED_ID,

    // Dynamic-fee tail — hybrid HOURS-FEE mode
    tradeFeeBaseBps: "1",          // 1 bp base; EWMA-move bps added in off-hours
  });
  {
    const keys = [
      ...buildAccountMetas(ACCOUNTS_INIT_MARKET, [
        payer.publicKey, slabPubkey, NATIVE_MINT, vaultAcc.address,
        WELL_KNOWN.clock, LEG1_ACCOUNT,
      ]),
      { pubkey: LEG2_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: LEG3_ACCOUNT, isSigner: false, isWritable: false },
    ];
    const t = new Transaction()
      .add(...withPriority(400_000))
      .add(buildIx({ programId: PROGRAM_ID, keys, data: initData }));
    const sig = await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed", skipPreflight: true });
    console.log(`    sig: ${sig.slice(0, 40)}...`);
  }

  // [4] Warm-up crank (3 oracle accounts)
  console.log(`\n[4] Initial KeeperCrank...`);
  const crankIx = () => {
    const keys = [
      ...buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
        payer.publicKey, slabPubkey, WELL_KNOWN.clock, LEG1_ACCOUNT,
      ]),
      { pubkey: LEG2_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: LEG3_ACCOUNT, isSigner: false, isWritable: false },
    ];
    return buildIx({
      programId: PROGRAM_ID, keys,
      data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }),
    });
  };
  await sendAndConfirmTransaction(conn,
    new Transaction().add(...withPriority(400_000)).add(crankIx()),
    [payer], { commitment: "confirmed", skipPreflight: true });

  // [5] Wrap SOL for insurance
  console.log(`\n[5] Wrapping SOL for insurance...`);
  const adminAta = await getOrCreateAssociatedTokenAccount(conn, payer, NATIVE_MINT, payer.publicKey);
  {
    const t = new Transaction()
      .add(...withPriority(30_000))
      .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: adminAta.address, lamports: WRAP_AMOUNT }))
      .add({
        keys: [{ pubkey: adminAta.address, isSigner: false, isWritable: true }],
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        data: Buffer.from([17]),  // SyncNative
      });
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    wrapped ${WRAP_AMOUNT / LAMPORTS_PER_SOL} SOL`);
  }

  // [6] Seed insurance
  console.log(`\n[6] TopUpInsurance ${(Number(INSURANCE_FUND_AMOUNT) / LAMPORTS_PER_SOL).toFixed(4)} SOL...`);
  {
    const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
      payer.publicKey, slabPubkey, adminAta.address, vaultAcc.address, TOKEN_PROGRAM_ID, WELL_KNOWN.clock,
    ]);
    const t = new Transaction()
      .add(...withPriority(400_000))
      .add(crankIx())
      .add(buildIx({ programId: PROGRAM_ID, keys, data: encodeTopUpInsurance({ amount: INSURANCE_FUND_AMOUNT.toString() }) }));
    await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    +${(Number(INSURANCE_FUND_AMOUNT) / LAMPORTS_PER_SOL).toFixed(4)} SOL → insurance`);
  }

  // [7] UpdateConfig: 50× deposit cap
  console.log(`\n[7] UpdateConfig: tvlInsuranceCapMult = 50...`);
  {
    const keys = [
      ...buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [
        payer.publicKey, slabPubkey, WELL_KNOWN.clock, LEG1_ACCOUNT,
      ]),
      { pubkey: LEG2_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: LEG3_ACCOUNT, isSigner: false, isWritable: false },
    ];
    const t = new Transaction()
      .add(...withPriority(400_000))
      .add(crankIx())
      .add(buildIx({
        programId: PROGRAM_ID, keys,
        data: encodeUpdateConfig({
          fundingHorizonSlots:  "7200",
          fundingKBps:          "100",
          fundingMaxPremiumBps: "500",
          fundingMaxE9PerSlot:  "1000",
          tvlInsuranceCapMult:  50,
        }),
      }));
    const sig = await sendAndConfirmTransaction(conn, t, [payer], { commitment: "confirmed" });
    console.log(`    ✓ tvl_cap = 50, sig=${sig.slice(0, 30)}...`);
  }

  // [8] Verify + write manifest. NOT burning authorities.
  console.log(`\n[8] State verification...`);
  const buf = await fetchSlab(conn, slabPubkey);
  const h = parseHeader(buf);
  const c = parseConfig(buf);
  const e = parseEngine(buf);
  console.log(`    admin:           ${h.admin.toBase58()}`);
  console.log(`    insurance auth:  ${h.insuranceAuthority.toBase58()}`);
  console.log(`    insurance op:    ${h.insuranceOperator.toBase58()}`);
  console.log(`    invert:          ${c.invert}`);
  console.log(`    tvl cap mult:    ${c.tvlInsuranceCapMult}`);
  console.log(`    perm_resolve:    ${c.permissionlessResolveStaleSlots} slots`);
  console.log(`    force_close:     ${c.forceCloseDelaySlots} slots`);
  console.log(`    insurance:       ${(Number(e.insuranceFund.balance) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`    vault:           ${(Number(e.vault) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`    market_mode:     ${e.marketMode === 0 ? "Live" : "Resolved"}`);
  console.log(`    last_oracle_e6:  ${e.lastOraclePrice}`);

  const manifest = {
    network: "mainnet",
    bountyVersion: "bounty_stoxx50_sol_20x_hybrid",
    createdAt: new Date().toISOString(),
    programId: PROGRAM_ID.toBase58(),
    slab: slabPubkey.toBase58(),
    slabSize: SLAB_LEN,
    mint: NATIVE_MINT.toBase58(),
    collateral: "wSOL (9 decimals, unit_scale=0)",
    vault: vaultAcc.address.toBase58(),
    vaultPda: vaultPda.toBase58(),
    oracle: LEG1_ACCOUNT.toBase58(),       // leg1 (STOXX 50 ETF / EUR)
    oracleLeg2: LEG2_ACCOUNT.toBase58(),   // leg2 (EUR/USD)
    oracleLeg3: LEG3_ACCOUNT.toBase58(),   // leg3 (SOL/USD)
    oracleType: "pyth_pull_composite_3leg",
    feedId: LEG1_FEED_ID,
    feedIdLeg2: LEG2_FEED_ID,
    feedIdLeg3: LEG3_FEED_ID,
    oracleLegCount: 3,
    oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG3,
    composite: "STOXX50_EUR * EUR_USD / SOL_USD = STOXX50/SOL",
    inverted: true,
    insuranceFundSol: 5,
    tvlInsuranceCapMult: c.tvlInsuranceCapMult,
    matcher: "(none — third parties provision their own)",
    admin: h.admin.toBase58(),
    insuranceAuthority: h.insuranceAuthority.toBase58(),
    insuranceOperator: h.insuranceOperator.toBase58(),
    feeMode: "HYBRID_AFTER_HOURS",
    tradeFeeBaseBps: 1,
    maxTradingFeeBps: 10000,
    riskParams: {
      maintenance_margin_bps: 500, initial_margin_bps: 500,
      max_trading_fee_bps: 10000, trading_fee_base_bps: 1,
      liquidation_fee_bps: 5, max_price_move_bps_per_slot: 49,
      h_min: 0, h_max: 6_480_000,
      min_nonzero_mm_req: 500, min_nonzero_im_req: 600, min_liquidation_abs: 0,
      liquidation_fee_cap: 50_000_000_000,
    },
    permissionlessResolveStaleSlots: c.permissionlessResolveStaleSlots.toString(),
    forceCloseDelaySlots: c.forceCloseDelaySlots.toString(),
    notes: "Authorities NOT burned. Keys live on deployer wallet so the market is wind-down-able.",
    nextSteps: [
      "1. install cron — scripts/mainnet-bounty4-cron-install.ts",
      "2. monitor ~/.cache/percolator/bounty4-tick.log for INSURANCE_DROP, CONSERVATION_BROKEN, anomalies",
      "3. winddown when done: ForceCloseResolved each account → WithdrawInsurance → CloseSlab → program close",
    ],
  };
  fs.writeFileSync("mainnet-bounty4-market.json", JSON.stringify(manifest, null, 2));
  console.log(`\nWrote mainnet-bounty4-market.json`);
  console.log("══════════════════════════════════════════════════════════════════════");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
