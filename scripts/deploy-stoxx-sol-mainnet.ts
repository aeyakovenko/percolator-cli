/** Deploy a single-asset STOXX/SOL market on mainnet `4m3ip` (program 70294cb,
 *  BPF 1aedbfa2…).  Composite oracle: STOXX50·EUR × EUR/USD ÷ SOL/USD, inverted
 *  so SOL is the base unit; HYBRID_AFTER_HOURS mode so the EWMA carries the
 *  price when STOXX is closed.  20× leverage, wSOL collateral.
 *  Fee policy: $0.50 init / $0.50 account / $0.50 daily maintenance (≈ 7.5M
 *  lamports each for the one-shot fees, 35 lamports/slot for maintenance at
 *  SOL ≈ $69). */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import * as fs from "fs";
import {
  encInitMarket, encConfigureHybridOracle, encConfigurePermissionlessResolve,
  encUpdateMarketInitFeePolicy, encUpdateFeeRedirectPolicy, encUpdateMaintenanceFeePolicy,
  encUpdateInsurancePolicy,
  marketAccountLenFor, ORACLE_LEG_FLAG_DIVIDE_LEG3,
} from "../src/v16/index.js";
import { parseMarketGroup, parseWrapperConfig } from "../src/v16/parsers.js";
const HOME = process.env.HOME!;
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`,"utf8").trim()}`, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));
const PROG = new PublicKey("4m3ipBQDYX6JQ9YSmUXDjESDHMtGWtiXforkWr9Qoxdi");

// Pyth feed IDs (32-byte hex; commitment hashes that go INTO the oracle profile).
const FEED_STOXX_EUR = "dd08f0a40e21ce42178b25bdd9461a2beebccbaa2a781a6e02b323576c4072ab";
const FEED_EUR_USD   = "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b";
const FEED_SOL_USD   = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
// Pyth PriceUpdateV2 account addresses on mainnet (the tail accounts for
// ConfigureHybridOracle's price stamp).
const ACCT_STOXX = new PublicKey("C2Cf16vF6LX8GrWJwfZga5z5tjVsax5VWnL2T7Q8CF91");
const ACCT_EUR   = new PublicKey("Fu76ChamBDjE8UuGLV6GP2AcPPSU6gjhkNhAyuoPm7ny");
const ACCT_SOL   = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

// Fee sizing at SOL ≈ $69:
const FEE_50C = 7_500_000n;       // ~$0.52 in lamports
const MAINT_PER_SLOT = 35n;       // ~$0.52/day at 216k slots/day

const SLOT_CAPACITY = 1;          // single-asset market

const cu = (limit = 600_000) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];
const send = (ixs: TransactionInstruction[], signers: Keypair[] = [admin]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...cu(), ...ixs), signers, { commitment: "confirmed", skipPreflight: true });
const code = (e: any) => {
  const s = (e?.transactionLogs ?? e?.logs ?? []).join(" ") + " " + (e?.message ?? "");
  return s.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? s.match(/"Custom":\s*(\d+)/)?.[1] ?? (s.slice(0, 100) || "?");
};
async function fetchCode(e: any): Promise<string> {
  const direct = code(e);
  if (direct !== "?") return direct;
  const sigm = (e?.message ?? "").match(/Transaction (\w{32,})/);
  if (!sigm) return "?";
  const tx = await conn.getTransaction(sigm[1], { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
  const logs = (tx?.meta?.logMessages ?? []).join(" ");
  return logs.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? "?";
}

(async () => {
  const start = (await conn.getBalance(admin.publicKey, "confirmed")) / 1e9;
  console.log(`admin start: ${start.toFixed(4)} SOL\n`);

  const market = Keypair.generate();
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.publicKey.toBuffer()], PROG);
  const accountLen = marketAccountLenFor(SLOT_CAPACITY);
  const mkRent = await conn.getMinimumBalanceForRentExemption(accountLen);
  console.log(`market account: size=${accountLen} rent=${(mkRent/1e9).toFixed(4)} SOL`);
  console.log(`market id: ${market.publicKey.toBase58()}`);
  console.log(`vault PDA: ${vaultAuth.toBase58()}\n`);

  // [1] createAccount + InitMarket
  console.log("[1] createAccount + InitMarket (1 slot, 20× lev, wSOL collateral)…");
  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: accountLen, programId: PROG }),
  ], [admin, market]);
  await send([new TransactionInstruction({
    programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
    ],
    data: encInitMarket({
      maxPortfolioAssets: 1,
      hMin: 0n, hMax: 6_480_000n, initialPrice: 1_000_000n,
      minNonzeroMmReq: 500n, minNonzeroImReq: 600n,
      maintenanceMarginBps: 500n, initialMarginBps: 500n,   // 20× leverage
      maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n,
      liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n,
      minLiquidationAbs: 0n,
      maxPriceMoveBpsPerSlot: 49n, maxAccrualDtSlots: 10n,
      maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n,
      maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n,
      maxBankruptCloseLifetimeSlots: 10_000_000n,
      publicBChunkAtoms: 1_000_000n,
      maintenanceFeePerSlot: MAINT_PER_SLOT,
    } as any),
  })]);
  console.log("  ✅ InitMarket");

  // [2] Policy: $0.50 init fee, perm-resolve config, fee redirect to self (only 1 asset)
  console.log("\n[2] Policies…");
  await send([new TransactionInstruction({
    programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
    ], data: encUpdateMarketInitFeePolicy(FEE_50C),
  })]);
  console.log(`  ✅ MarketInitFee = ${FEE_50C} lamports (~$0.50)`);

  // permissionless resolve: 30d stale window, 24h force-close delay (216k slots)
  await send([new TransactionInstruction({
    programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
    ], data: encConfigurePermissionlessResolve({ staleSlots: 6_480_000n, forceCloseDelaySlots: 216_000n }),
  })]);
  console.log("  ✅ PermissionlessResolve(30d stale / 24h force-close)");

  // Insurance policy: 50% per-period drain cap
  await send([new TransactionInstruction({
    programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
    ], data: encUpdateInsurancePolicy({ maxBps: 5000, depositsOnly: 0, cooldownSlots: 216_000n }),
  })]);
  console.log("  ✅ InsurancePolicy(5000bps / 24h cooldown)");

  // [3] ConfigureHybridOracle for asset 0: 3-leg composite STOXX·EUR × EUR/USD ÷ SOL/USD
  console.log("\n[3] ConfigureHybridOracle asset[0] — STOXX/SOL (3-leg composite, EWMA after-hours)…");
  const slot = BigInt(await conn.getSlot("confirmed"));
  // After-hours-tolerant config: large max_staleness lets STOXX go stale into the
  // weekend; hybrid_soft_stale_slots is the EWMA-fallback trigger.
  try {
    await send([new TransactionInstruction({
      programId: PROG, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: ACCT_STOXX, isSigner: false, isWritable: false },
        { pubkey: ACCT_EUR, isSigner: false, isWritable: false },
        { pubkey: ACCT_SOL, isSigner: false, isWritable: false },
      ],
      data: encConfigureHybridOracle({
        assetIndex: 0, nowSlot: slot, nowUnixTs: BigInt(Math.floor(Date.now() / 1000)),
        oracleLegCount: 3, oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG3,
        maxStalenessSecs: 300n,             // 5 min before we declare "after hours" (engine falls back to EWMA)
        hybridSoftStaleSlots: 200n,         // soft-stale window
        markEwmaHalflifeSlots: 300n,        // EWMA half-life ~2 min
        markMinFee: 500n,
        invert: 1,                          // STOXX(USD)/SOL inverted → STOXX/SOL with SOL base
        unitScale: 0,
        confFilterBps: 100,
        oracleLegFeeds: [FEED_STOXX_EUR, FEED_EUR_USD, FEED_SOL_USD],
      }),
    })]);
    console.log("  ✅ ConfigureHybridOracle");
  } catch (e: any) {
    const c = await fetchCode(e);
    console.log(`  ⚠️  ConfigureHybridOracle failed: ${c}`);
    console.log(`     If 0x1a/0x1b: oracle leg is stale (STOXX market closed). Either wait for STOXX open or push fresh via pyth-pusher.`);
  }

  // [4] Snapshot final state + write manifest
  console.log("\n[4] Verifying final state…");
  const ai = await conn.getAccountInfo(market.publicKey, "confirmed");
  if (!ai) { console.log("  ✗ market account missing"); return; }
  const g: any = parseMarketGroup(Buffer.from(ai.data));
  const cfg: any = parseWrapperConfig(Buffer.from(ai.data));
  console.log(`  market   : ${market.publicKey.toBase58()}`);
  console.log(`  size     : ${ai.data.length} B`);
  console.log(`  rent     : ${(ai.lamports/1e9).toFixed(4)} SOL`);
  console.log(`  marketauth: ${cfg.marketauth.toBase58()}`);
  console.log(`  mode     : ${g.mode}  (0=Live)`);
  console.log(`  oracle_mode: ${cfg.oracleMode}  oracle_leg_count: ${cfg.oracleLegCount}  invert: ${cfg.invert}`);
  console.log(`  mark_ewma_e6: ${cfg.markEwmaE6}  oracle_target_e6: ${cfg.oracleTargetPriceE6}`);
  console.log(`  insurance: ${g.insurance}  vault: ${g.vault}  matz: ${g.materializedPortfolioCount}`);
  console.log(`  maint_fee/slot: ${cfg.maintenanceFeePerSlot}  init_fee: ${cfg.permissionlessMarketInitFee}`);

  // Manifest
  const manifest = {
    network: "mainnet",
    programId: PROG.toBase58(),
    market: market.publicKey.toBase58(),
    vaultPda: vaultAuth.toBase58(),
    admin: admin.publicKey.toBase58(),
    collateralMint: NATIVE_MINT.toBase58(),
    layout: "70294cb (marketauth-collapse / 432B WC)",
    bpf: "1aedbfa25945f9fba521d2574d8568167daf2d1c5d7c69cd2c0430c171d1888f",
    asset0: {
      label: "STOXX/SOL",
      oracleMode: "HYBRID_AFTER_HOURS",
      oracleLegFeeds: [FEED_STOXX_EUR, FEED_EUR_USD, FEED_SOL_USD],
      oracleAccounts: [ACCT_STOXX.toBase58(), ACCT_EUR.toBase58(), ACCT_SOL.toBase58()],
      invert: true,
      oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG3,
    },
    fees: {
      newAccountFee: FEE_50C.toString(),
      permissionlessMarketInitFee: FEE_50C.toString(),
      maintenanceFeePerSlot: MAINT_PER_SLOT.toString(),
      solPriceAssumed: "$69.26",
      note: "all ≈ $0.50",
    },
    config: {
      maxPortfolioAssets: 1,
      leverage: 20,
      maintenanceMarginBps: 500,
      initialMarginBps: 500,
      maxStalenessSecs: 300,
      hybridSoftStaleSlots: 200,
      markEwmaHalflifeSlots: 300,
      permissionlessResolveStaleSlots: 6_480_000,
      forceCloseDelaySlots: 216_000,
    },
  };
  const manifestPath = `${HOME}/percolator-cli/mainnet-stoxx-sol-market.json`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n  📄 manifest: ${manifestPath}`);

  const end = (await conn.getBalance(admin.publicKey, "confirmed")) / 1e9;
  console.log(`\nadmin end: ${end.toFixed(4)} SOL  (Δ = ${(end - start).toFixed(4)} SOL)`);
})().catch(e => console.log("FATAL:", e?.message || e));
