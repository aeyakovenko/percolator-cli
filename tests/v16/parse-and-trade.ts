/**
 * Parse-correctness + trade-roundtrip verification against the deployed BPF.
 *
 *   A.  Mainnet read-only: decode the live STOXX/SOL market + keeper portfolio
 *       with every parser the CLI ships, dump every field, fail if anything
 *       throws or returns nonsense.
 *
 *   B.  Devnet open→close trade: spawn a fresh 1-slot smoke market on the
 *       upgraded devnet program, open a TradeNoCpi bilateral position, parse
 *       the post-open state and assert the leg, OI, capital, c_tot all moved
 *       coherently. Close the position, parse again, assert everything
 *       collapses back. Tear down. This exercises the actual trade flow under
 *       the latest BPF.
 *
 * Use:  pnpm tsx tests/v16/parse-and-trade.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encInitMarket, encInitPortfolio, encDeposit, encTradeNoCpi, encPushHyperpMark,
  encConfigureHyperpMark, encResolveMarket, encCloseResolved,
  encSyncMaintenanceFee, encWithdrawInsurance, encCloseSlab, encWithdrawBackingBucket,
  marketAccountLenFor, PORTFOLIO_ACCOUNT_LEN,
  MARKET_GROUP_OFF, MG, AssetLifecycle,
} from "../../src/v16/index.js";
import {
  parseMarketGroup, parseWrapperConfig, parsePortfolio, parseHeader,
  isMarket, isPortfolio,
} from "../../src/v16/parsers.js";

const HOME = process.env.HOME!;
const HELIUS = fs.readFileSync(`${HOME}/.helius`, "utf8").trim();

const mainnet = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS}`, "confirmed");
const devnet = new Connection(`https://devnet.helius-rpc.com/?api-key=${HELIUS}`, "confirmed");

const PROG_MAIN = new PublicKey("4m3ipBQDYX6JQ9YSmUXDjESDHMtGWtiXforkWr9Qoxdi");
const PROG_DEV = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));

let failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (detail ? " — " + detail : ""));
  if (!ok) failures.push(name + (detail ? ": " + detail : ""));
}

// ============================================================================
//  A. Mainnet read-only parse
// ============================================================================
async function mainnetParseSuite() {
  console.log("\n[A] Mainnet read-only parse verification");
  const M = JSON.parse(fs.readFileSync(`${HOME}/percolator-cli/mainnet-stoxx-sol-market.json`, "utf8"));
  const MKT = new PublicKey(M.market);
  const PF = new PublicKey(M.keeperPortfolio);

  // --- market ---
  const ai = await mainnet.getAccountInfo(MKT, "confirmed");
  check("market account exists", ai !== null, MKT.toBase58().slice(0, 12));
  if (!ai) return;
  const buf = Buffer.from(ai.data);

  check("header magic + version + kind decode", isMarket(buf), `data.length=${buf.length}`);
  const h = parseHeader(buf);
  check("parseHeader returns sane fields", h.version === 16 && h.kind === 1,
    `version=${h.version}, kind=${h.kind}`);

  const cfg: any = parseWrapperConfig(buf);
  check("parseWrapperConfig: marketauth pubkey present", cfg.marketauth.toBase58() === "A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK",
    cfg.marketauth.toBase58().slice(0, 12));
  check("parseWrapperConfig: collateralMint == wSOL", cfg.collateralMint.toBase58() === NATIVE_MINT.toBase58());
  check("parseWrapperConfig: oracle_mode = HYBRID_AFTER_HOURS (1)", cfg.oracleMode === 1, `got ${cfg.oracleMode}`);
  check("parseWrapperConfig: oracle_leg_count = 3", cfg.oracleLegCount === 3, `got ${cfg.oracleLegCount}`);
  check("parseWrapperConfig: invert = 1", cfg.invert === 1, `got ${cfg.invert}`);
  check("parseWrapperConfig: mark_ewma_e6 = oracle_target_e6 (no drift since launch)",
    cfg.markEwmaE6 === cfg.oracleTargetPriceE6,
    `mark=${cfg.markEwmaE6}, target=${cfg.oracleTargetPriceE6}`);
  check("parseWrapperConfig: maintenance_fee_per_slot = 35 lamports", cfg.maintenanceFeePerSlot === 35n);
  check("parseWrapperConfig: permissionless_resolve_stale_slots = 30 days", cfg.permissionlessResolveStaleSlots === 6_480_000n);
  check("parseWrapperConfig: leg feeds populated", cfg.oracleLegFeeds.every((f: string) => f.length === 64 && !/^0+$/.test(f)),
    `feeds=[${cfg.oracleLegFeeds.map((f: string) => f.slice(0, 8)).join(",")}]`);

  const g: any = parseMarketGroup(buf);
  check("parseMarketGroup: marketGroupId = market pubkey", g.marketGroupId === MKT.toBuffer().toString("hex"),
    g.marketGroupId.slice(0, 16));
  check("parseMarketGroup: mode = Live (0)", g.mode === 0, `got ${g.mode}`);
  check("parseMarketGroup: assetSlotCapacity = 1", g.assetSlotCapacity === 1, `got ${g.assetSlotCapacity}`);
  check("parseMarketGroup: assets[0] decoded", g.assets.length === 1, `got ${g.assets.length} non-placeholder assets`);
  check("parseMarketGroup: asset[0].lifecycle = Active", g.assets[0]?.lifecycle === AssetLifecycle.Active,
    `got ${g.assets[0]?.lifecycle}`);
  check("parseMarketGroup: all risk flags clear", g.bankruptcyHlockActive === 0 && g.thresholdStressActive === 0 && g.lossStaleActive === 0);

  // --- portfolio ---
  const pai = await mainnet.getAccountInfo(PF, "confirmed");
  check("keeper portfolio account exists", pai !== null);
  if (!pai) return;
  const pbuf = Buffer.from(pai.data);
  check("portfolio header decodes as KIND_PORTFOLIO", isPortfolio(pbuf), `len=${pbuf.length}`);
  const p: any = parsePortfolio(pbuf);
  check("parsePortfolio: owner = keeper key", p.owner.toBase58() === M.keeperKey, p.owner.toBase58().slice(0, 12));
  check("parsePortfolio: marketGroupId = market pubkey", p.marketGroupId.toBase58() === MKT.toBase58());
  check("parsePortfolio: dormant keeper has zero capital, pnl, legs",
    p.capital === 0n && p.pnl === 0n && p.legs.length === 0);
  check("parsePortfolio: liquidation_lock clear", p.liquidationLock === 0);
}

// ============================================================================
//  B. Devnet open + close trade with parse checks at each step
// ============================================================================
const cu = (limit = 1_400_000) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];
const send = (ixs: TransactionInstruction[], signers: Keypair[] = [admin]) =>
  sendAndConfirmTransaction(devnet, new Transaction().add(...cu(), ...ixs), signers, { commitment: "confirmed", skipPreflight: true });
const code = (e: any) => {
  const s = (e?.transactionLogs ?? e?.logs ?? []).join(" ") + " " + (e?.message ?? "");
  return s.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? s.match(/"Custom":\s*(\d+)/)?.[1] ?? "?";
};

async function devnetTradeRoundtripSuite() {
  console.log("\n[B] Devnet trade-roundtrip parse verification");
  // ---- setup ----
  const market = Keypair.generate();
  const portA = Keypair.generate();
  const portB = Keypair.generate();
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.publicKey.toBuffer()], PROG_DEV);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);

  const mkLen = marketAccountLenFor(1);
  const mkRent = await devnet.getMinimumBalanceForRentExemption(mkLen);
  const pfRent = await devnet.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);

  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: mkLen, programId: PROG_DEV }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portA.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROG_DEV }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portB.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROG_DEV }),
  ], [admin, market, portA, portB]);

  await send([new TransactionInstruction({
    programId: PROG_DEV, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
    ],
    data: encInitMarket({
      maxPortfolioAssets: 1,
      hMin: 0n, hMax: 6_480_000n, initialPrice: 1_000_000n,
      minNonzeroMmReq: 500n, minNonzeroImReq: 600n,
      maintenanceMarginBps: 500n, initialMarginBps: 500n,
      maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n,
      liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n,
      minLiquidationAbs: 0n,
      maxPriceMoveBpsPerSlot: 49n, maxAccrualDtSlots: 10n,
      maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n,
      maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n,
      maxBankruptCloseLifetimeSlots: 10_000_000n,
      publicBChunkAtoms: 1_000_000n, maintenanceFeePerSlot: 35n,
    } as any),
  })]);
  const slot0 = BigInt(await devnet.getSlot("confirmed"));
  await send([new TransactionInstruction({
    programId: PROG_DEV, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
    ], data: encConfigureHyperpMark({ assetIndex: 0, nowSlot: slot0, initialMarkE6: 1_000_000n,
      markEwmaHalflifeSlots: 300n, markMinFee: 500n } as any),
  })]);
  for (const pf of [portA, portB]) {
    await send([new TransactionInstruction({ programId: PROG_DEV, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
      { pubkey: pf.publicKey, isSigner: false, isWritable: true },
    ], data: encInitPortfolio() })]);
  }
  await send([
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminAta, lamports: 800_000_000 }),
    createSyncNativeInstruction(adminAta),
  ]);
  const dep = (pf: PublicKey) => new TransactionInstruction({ programId: PROG_DEV, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: pf, isSigner: false, isWritable: true }, { pubkey: adminAta, isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }],
    data: encDeposit(300_000_000n) });
  await send([dep(portA.publicKey)]);
  await send([dep(portB.publicKey)]);
  console.log(`  setup done — market ${market.publicKey.toBase58().slice(0,12)}, 2 portfolios @ 300M lamports each`);

  // ---- pre-trade parse ----
  let ai = (await devnet.getAccountInfo(market.publicKey, "confirmed"))!;
  let g: any = parseMarketGroup(Buffer.from(ai.data));
  check("[pre] market parses, asset[0] active",
    g.mode === 0 && g.assets[0]?.lifecycle === AssetLifecycle.Active);
  check("[pre] c_tot == Σ deposits (600M)", g.cTot === 600_000_000n, `got ${g.cTot}`);
  check("[pre] vault == 600M", g.vault === 600_000_000n, `got ${g.vault}`);
  check("[pre] asset[0].OI long+short = 0", g.assets[0]?.oiEffLongQ === 0n && g.assets[0]?.oiEffShortQ === 0n);

  // ---- OPEN: bilateral TradeNoCpi, A long 10M @ 1.0 / B short 10M @ 1.0 ----
  console.log("  opening bilateral trade: portA +10M long / portB -10M short @ 1.0");
  const tradeKeys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: portA.publicKey, isSigner: false, isWritable: true },
    { pubkey: portB.publicKey, isSigner: false, isWritable: true },
  ];
  try {
    await send([new TransactionInstruction({ programId: PROG_DEV, keys: tradeKeys,
      data: encTradeNoCpi({ assetIndex: 0, sizeQ: 10_000_000n, execPrice: 1_000_000n, feeBps: 1n }) })]);
    check("TradeNoCpi open: tx submitted + confirmed", true);
  } catch (e: any) {
    check("TradeNoCpi open: tx submitted + confirmed", false, `0x${code(e)}`);
  }

  // ---- post-open parse ----
  ai = (await devnet.getAccountInfo(market.publicKey, "confirmed"))!;
  g = parseMarketGroup(Buffer.from(ai.data));
  const a0_open: any = g.assets[0];
  check("[open] asset[0].oi_eff_long_q == 10M", a0_open.oiEffLongQ === 10_000_000n, `got ${a0_open.oiEffLongQ}`);
  check("[open] asset[0].oi_eff_short_q == 10M", a0_open.oiEffShortQ === 10_000_000n, `got ${a0_open.oiEffShortQ}`);
  check("[open] asset[0].stored_pos_count_long == 1", a0_open.storedPosCountLong === 1n);
  check("[open] asset[0].stored_pos_count_short == 1", a0_open.storedPosCountShort === 1n);

  const paiA = (await devnet.getAccountInfo(portA.publicKey, "confirmed"))!;
  const paiB = (await devnet.getAccountInfo(portB.publicKey, "confirmed"))!;
  const pA: any = parsePortfolio(Buffer.from(paiA.data));
  const pB: any = parsePortfolio(Buffer.from(paiB.data));
  check("[open] portA has 1 active leg", pA.legs.length === 1, `got ${pA.legs.length}`);
  check("[open] portA leg.side == long (0)", pA.legs[0]?.side === 0, `got ${pA.legs[0]?.side}`);
  check("[open] portA leg.asset_index == 0", pA.legs[0]?.assetIndex === 0);
  check("[open] portB has 1 active leg", pB.legs.length === 1, `got ${pB.legs.length}`);
  check("[open] portB leg.side == short (1)", pB.legs[0]?.side === 1, `got ${pB.legs[0]?.side}`);
  check("[open] portA active_bitmap bit 0 set", (pA.activeBitmap & 1n) === 1n,
    `0x${pA.activeBitmap.toString(16)}`);
  check("[open] portB active_bitmap bit 0 set", (pB.activeBitmap & 1n) === 1n);

  // ---- CLOSE: push mark to same price, then reverse the trade ----
  console.log("  closing bilateral trade: portA -10M / portB +10M @ 1.0");
  const slot1 = BigInt(await devnet.getSlot("confirmed"));
  await send([new TransactionInstruction({ programId: PROG_DEV, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encPushHyperpMark({ assetIndex: 0, nowSlot: slot1, markE6: 1_000_000n } as any) })]);
  try {
    await send([new TransactionInstruction({ programId: PROG_DEV, keys: tradeKeys,
      data: encTradeNoCpi({ assetIndex: 0, sizeQ: -10_000_000n, execPrice: 1_000_000n, feeBps: 1n }) })]);
    check("TradeNoCpi close: tx submitted + confirmed", true);
  } catch (e: any) {
    check("TradeNoCpi close: tx submitted + confirmed", false, `0x${code(e)}`);
  }

  // ---- post-close parse ----
  ai = (await devnet.getAccountInfo(market.publicKey, "confirmed"))!;
  g = parseMarketGroup(Buffer.from(ai.data));
  const a0_closed: any = g.assets[0];
  check("[close] asset[0].oi_eff_long_q back to 0", a0_closed.oiEffLongQ === 0n, `got ${a0_closed.oiEffLongQ}`);
  check("[close] asset[0].oi_eff_short_q back to 0", a0_closed.oiEffShortQ === 0n);
  check("[close] asset[0].stored_pos_count_long back to 0", a0_closed.storedPosCountLong === 0n);
  check("[close] asset[0].stored_pos_count_short back to 0", a0_closed.storedPosCountShort === 0n);

  const paiA2 = (await devnet.getAccountInfo(portA.publicKey, "confirmed"))!;
  const paiB2 = (await devnet.getAccountInfo(portB.publicKey, "confirmed"))!;
  const pA2: any = parsePortfolio(Buffer.from(paiA2.data));
  const pB2: any = parsePortfolio(Buffer.from(paiB2.data));
  check("[close] portA active legs == 0", pA2.legs.length === 0, `got ${pA2.legs.length}`);
  check("[close] portB active legs == 0", pB2.legs.length === 0, `got ${pB2.legs.length}`);
  check("[close] portA active_bitmap == 0", pA2.activeBitmap === 0n);
  check("[close] portB active_bitmap == 0", pB2.activeBitmap === 0n);
  // c_tot drops by trade fees (1 bps each side × 2 sides × 2 trades) +
  // maintenance fees accrued on both portfolios between open and close.
  // For 600M starting capital, drop should be ≤ a few million lamports.
  const drop = 600_000_000n - g.cTot;
  check("[close] c_tot drop is bounded by trade + maintenance fees",
    g.cTot > 595_000_000n && g.cTot <= 600_000_000n,
    `c_tot=${g.cTot}, drop=${drop} lamports (trade fee + maintenance accrual)`);
  // Vault holds c_tot (portfolio capital) + insurance (fee accrual lives here)
  // + any other off-portfolio pools.  The trade fees deducted from c_tot got
  // routed into insurance — they didn't leave the vault, just changed bucket.
  check("[close] vault ≥ c_tot (subset lower bound, always true)",
    g.vault >= g.cTot, `vault=${g.vault}, c_tot=${g.cTot}`);
  check("[close] vault == c_tot + insurance (no leakage past those two pools)",
    g.vault === g.cTot + g.insurance,
    `vault=${g.vault}, c_tot=${g.cTot}, insurance=${g.insurance}, sum=${g.cTot + g.insurance}`);
  check("[close] insurance == (Σ deposits − c_tot)  (fees routed to insurance)",
    g.insurance === 600_000_000n - g.cTot,
    `insurance=${g.insurance}, expected ${600_000_000n - g.cTot}`);

  // ---- teardown ----
  console.log("  teardown…");
  await send([new TransactionInstruction({ programId: PROG_DEV, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encResolveMarket() })]);
  for (const pf of [portA, portB]) {
    try {
      await send([new TransactionInstruction({ programId: PROG_DEV, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: pf.publicKey, isSigner: false, isWritable: true },
        { pubkey: adminAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuth, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ], data: encCloseResolved(0n) })]);
      await send([new TransactionInstruction({ programId: PROG_DEV, keys: [
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: pf.publicKey, isSigner: false, isWritable: true },
      ], data: encSyncMaintenanceFee(BigInt(await devnet.getSlot("confirmed"))) })]);
    } catch { /* tolerate */ }
  }
  try {
    await send([new TransactionInstruction({ programId: PROG_DEV, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: adminAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ], data: encCloseSlab() })]);
    console.log("  market closed cleanly");
  } catch (e: any) { console.log(`  CloseSlab skipped: 0x${code(e)}`); }
  try { await send([createCloseAccountInstruction(adminAta, admin.publicKey, admin.publicKey)]); } catch { /* tolerate */ }
}

// ============================================================================
(async () => {
  console.log("=".repeat(72));
  console.log("Parse + trade verification — deployed BPF 1c1ca8ff… (wrapper 8306372)");
  console.log("=".repeat(72));
  await mainnetParseSuite();
  await devnetTradeRoundtripSuite();

  console.log("\n" + "=".repeat(72));
  if (failures.length > 0) {
    console.log(`✗ ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.log("  • " + f);
    process.exit(1);
  }
  console.log(`✓ all assertions passed`);
})().catch(e => { console.error("FATAL:", e?.message || e); process.exit(2); });
