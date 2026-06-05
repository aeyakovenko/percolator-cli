/**
 * Matcher LP counter exercise — per user direction:
 *
 *   "create matcher instance; init it with the lp account derived pda;
 *    set the lp account to the matcher program and matcher instance;
 *    that is all we need"
 *
 * Wrapper 7144d9b reshaped the matcher binding: instead of a separate auth PDA
 * (or signer_b co-sign), the LP portfolio now carries a 104-byte
 * `PortfolioMatcherConfigV16` tail. Flow:
 *
 *   1. Generate the matcher context (regular keypair, matcher-owned).
 *   2. Derive `matcher_delegate` PDA under wrapper PROG with seeds
 *      `[matcher, market, lp_portfolio, lp_owner, matcher_program, matcher_context]`.
 *   3. Matcher tag 2 — records `lp_pda = matcher_delegate` in MatcherCtx.
 *   4. Wrapper `SetMatcherConfig` (tag 68) — LP owner signs, writes the
 *      `{matcher_program, matcher_context, matcher_delegate, enabled=1}` tuple
 *      into the LP portfolio's tail.
 *   5. TradeCpi (tag 10) now has 7 fixed accounts (no signer_b):
 *      [signer_a, market, account_a, account_b, matcher_prog, matcher_ctx, matcher_delegate, …tail]
 *      Wrapper reads the LP portfolio's matcher config and verifies it matches
 *      the passed program/context/delegate.  Fast path at v16_program.rs:6708.
 *
 * Flow:
 *   1. Init smoke market, LP + taker portfolios, fund both.
 *   2. Top up the backing bucket (the pool whose lien tracks the counter).
 *   3. Create matcher context account (regular keypair, matcher-owned).
 *   4. Compute matcher_delegate PDA from (market, lp, lp_owner, matcher_prog,
 *      matcher_ctx) under the wrapper.
 *   5. Init the matcher (tag 2) with matcher_delegate as account[0].
 *   6. Call TradeCpi with admin co-signing both signer_a (taker) and signer_b
 *      (LP owner) so the auth-PDA check is bypassed.
 *   7. Phase 1: push the Hyperp mark DOWN with spaced cranks → LP short PnL goes
 *      positive → `add_account_source_positive_pnl_not_atomic` populates the LP's
 *      `source_claim_bound_num` against domain 0. This is the v16 prerequisite for
 *      the backing bucket to even be eligible for consumption.
 *   8. Phase 2: push the mark back UP and past 1.0 → LP loss exceeds claim + capital
 *      → engine moves bucket.valid_liened → bucket.consumed_liened.
 *   9. SyncBackingDomainLedger → reads `bucket.consumed_liened + bucket.impaired_liened`
 *      and credits the delta into `cumulative_loss_atoms`.
 *
 * Result (devnet wrapper 8306372, matcher 5ogNxr4u): cumulativeLoss grew by
 * ~37.4M atoms across the round-trip. The deterministic-farm counter chain works
 * end-to-end. The single-trade fresh-LP-loses scenario does NOT increment the
 * counter — it hits SettleB::RecoveryRequired because the LP has no prior claim.
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import {
  encInitMarket, encInitPortfolio, encDeposit, encConfigureHyperpMark,
  encTopUpBackingBucket, encSyncBackingDomainLedger, encPushHyperpMark,
  encTradeCpi, encPermissionlessCrank, encSetMatcherConfig,
  marketAccountLenFor, PORTFOLIO_ACCOUNT_LEN, HEADER_LEN,
} from "../../src/v16/index.js";
import { parseMarketGroup, parsePortfolio } from "../../src/v16/parsers.js";

const HOME = process.env.HOME!;
const RPC = `https://devnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
const conn = new Connection(RPC, "confirmed");
const PROG = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const MATCHER = new PublicKey("5ogNxr4uFXZXoeJ4cP89kKZkx1FkbaD2FBQr91KoYZep");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));

const cu = (limit = 1_400_000) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];
const send = (ixs: TransactionInstruction[], signers: Keypair[] = [admin]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...cu(), ...ixs), signers, { commitment: "confirmed", skipPreflight: true });
const code = (e: any) => {
  const s = (e?.transactionLogs ?? e?.logs ?? []).join(" ") + " " + (e?.message ?? "");
  return s.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? s.match(/"Custom":\s*(\d+)/)?.[1] ?? "?";
};
async function fullLogs(sig: string): Promise<string> {
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
  return (tx?.meta?.logMessages ?? []).slice(-15).join("\n      ");
}
async function trySend(label: string, ixs: TransactionInstruction[], signers: Keypair[] = [admin]) {
  try { await send(ixs, signers); console.log(`  ✓ ${label}`); }
  catch (e: any) {
    const c = code(e);
    const sigm = (e?.message ?? "").match(/Transaction (\w{32,})/);
    console.log(`  ✗ ${label}: 0x${c}`);
    if (sigm) console.log(`    logs:\n      ${await fullLogs(sigm[1])}`);
    throw e;
  }
}

function encMatcherInitVamm(p: {
  kind: number; tradingFeeBps: number; baseSpreadBps: number; maxTotalBps: number;
  impactKBps: number; liquidityNotionalE6: bigint; maxFillAbs: bigint; maxInventoryAbs: bigint;
}): Buffer {
  const b = Buffer.alloc(66);
  b[0] = 2;
  b[1] = p.kind;
  b.writeUInt32LE(p.tradingFeeBps, 2);
  b.writeUInt32LE(p.baseSpreadBps, 6);
  b.writeUInt32LE(p.maxTotalBps, 10);
  b.writeUInt32LE(p.impactKBps, 14);
  b.writeBigUInt64LE(p.liquidityNotionalE6 & 0xffffffffffffffffn, 18);
  b.writeBigUInt64LE(p.liquidityNotionalE6 >> 64n, 26);
  b.writeBigUInt64LE(p.maxFillAbs & 0xffffffffffffffffn, 34);
  b.writeBigUInt64LE(p.maxFillAbs >> 64n, 42);
  b.writeBigUInt64LE(p.maxInventoryAbs & 0xffffffffffffffffn, 50);
  b.writeBigUInt64LE(p.maxInventoryAbs >> 64n, 58);
  return b;
}

// ---- BackingDomainLedger parser ----
function u128(b: Buffer, o: number): bigint {
  return b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
}
function parseLedgerCounters(buf: Buffer) {
  let o = HEADER_LEN + 32 + 32 + 16 * 6;
  const cumLoss = u128(buf, o);
  const cumRecov = u128(buf, o + 16);
  const lastUnavail = u128(buf, o + 32);
  return { cumLoss, cumRecov, lastUnavail };
}

(async () => {
  console.log("=".repeat(72));
  console.log("Matcher LP counter exercise — devnet 7144d9b, matcher 5ogNxr4u…");
  console.log("=".repeat(72));

  // ---- accounts ----
  const market = Keypair.generate();
  const lp = Keypair.generate();
  const taker = Keypair.generate();
  const matcherCtx = Keypair.generate();
  const bckLedger = Keypair.generate();
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.publicKey.toBuffer()], PROG);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);

  // The wrapper's matcher_delegate PDA: this is the lp_pda we record into MatcherCtx.
  // Derived from (market, lp_portfolio, lp_owner, matcher_prog, matcher_ctx) under wrapper.
  const [matcherDelegate, delegateBump] = PublicKey.findProgramAddressSync([
    Buffer.from("matcher"),
    market.publicKey.toBuffer(),
    lp.publicKey.toBuffer(),
    admin.publicKey.toBuffer(),
    MATCHER.toBuffer(),
    matcherCtx.publicKey.toBuffer(),
  ], PROG);
  console.log(`  market           : ${market.publicKey.toBase58()}`);
  console.log(`  LP portfolio     : ${lp.publicKey.toBase58()}`);
  console.log(`  taker portfolio  : ${taker.publicKey.toBase58()}`);
  console.log(`  matcher context  : ${matcherCtx.publicKey.toBase58()}`);
  console.log(`  matcher delegate : ${matcherDelegate.toBase58()}  (bump ${delegateBump})`);

  const mkLen = marketAccountLenFor(1);
  const mkRent = await conn.getMinimumBalanceForRentExemption(mkLen);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  const ctxRent = await conn.getMinimumBalanceForRentExemption(320);
  const ledRent = await conn.getMinimumBalanceForRentExemption(2048);

  await trySend("createAccounts: mkt + lp + taker + matcher_ctx + bck_ledger", [
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: mkLen, programId: PROG }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: lp.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROG }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: taker.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROG }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: matcherCtx.publicKey,
      lamports: ctxRent, space: 320, programId: MATCHER }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: bckLedger.publicKey,
      lamports: ledRent, space: 2048, programId: PROG }),
  ], [admin, market, lp, taker, matcherCtx, bckLedger]);

  await trySend("InitMarket", [new TransactionInstruction({
    programId: PROG, keys: [
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
  const slot0 = BigInt(await conn.getSlot("confirmed"));
  await trySend("ConfigureHyperpMark @ 1.0", [new TransactionInstruction({
    programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
    ], data: encConfigureHyperpMark({ assetIndex: 0, nowSlot: slot0, initialMarkE6: 1_000_000n,
      markEwmaHalflifeSlots: 1n, markMinFee: 500n } as any),
  })]);
  for (const [pf, label] of [[lp, "lp"], [taker, "taker"]] as const) {
    await trySend(`InitPortfolio ${label}`, [new TransactionInstruction({ programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
      { pubkey: pf.publicKey, isSigner: false, isWritable: true },
    ], data: encInitPortfolio() })]);
  }
  await trySend("wrap + ATAs", [
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminAta, lamports: 2_000_000_000 }),
    createSyncNativeInstruction(adminAta),
  ]);
  const dep = (pf: PublicKey, amt: bigint) => new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: pf, isSigner: false, isWritable: true }, { pubkey: adminAta, isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }],
    data: encDeposit(amt) });
  // LP intentionally thin: 10M cap on a 100M short position (10x lev, mm@5%=5M).
  // A small adverse mark move blows past LP's capital → residual must come from backing.
  await trySend("Deposit lp 10M (thin LP, easy backing engagement)", [dep(lp.publicKey, 10_000_000n)]);
  await trySend("Deposit taker 300M", [dep(taker.publicKey, 300_000_000n)]);
  const expirySlot = BigInt(await conn.getSlot("confirmed")) + 10_000_000n;
  await trySend("TopUpBackingBucket(dom0, 400M)", [new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: adminAta, isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ], data: encTopUpBackingBucket({ domain: 0, amount: 400_000_000n, expirySlot }) })]);

  // ---- create the matcher instance: init it with the LP-account-derived PDA ----
  await trySend("Matcher init (tag 2) with delegate as lp_pda", [new TransactionInstruction({
    programId: MATCHER, keys: [
      { pubkey: matcherDelegate, isSigner: false, isWritable: false },  // becomes lp_pda in MatcherCtx
      { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
    ], data: encMatcherInitVamm({
      kind: 1, // 1 = vAMM (per memory "kind (0=Passive, 1=vAMM)")
      tradingFeeBps: 10, baseSpreadBps: 50, maxTotalBps: 1000,
      impactKBps: 1, liquidityNotionalE6: 1_000_000_000n,
      maxFillAbs: 100_000_000n, maxInventoryAbs: 500_000_000n,
    }),
  })]);

  // ---- SetMatcherConfig (tag 68 — 7144d9b) ----
  // Wrapper writes the matcher_program / matcher_context / matcher_delegate tuple
  // into the LP portfolio's 104-byte tail. After this, TradeCpi accepts unsigned
  // LP fills as long as the passed matcher accounts byte-for-byte match.
  await trySend("SetMatcherConfig (enable matcher on LP portfolio)", [new TransactionInstruction({
    programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },        // lp_owner
      { pubkey: market.publicKey, isSigner: false, isWritable: false },
      { pubkey: lp.publicKey, isSigner: false, isWritable: true },           // lp portfolio
      { pubkey: MATCHER, isSigner: false, isWritable: false },
      { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: false },
      { pubkey: matcherDelegate, isSigner: false, isWritable: false },
    ], data: encSetMatcherConfig(1),
  })]);

  // ---- baseline ledger ----
  const ledIx = (data: Buffer) => new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: bckLedger.publicKey, isSigner: false, isWritable: true },
  ], data });
  await trySend("SyncBackingDomainLedger pre-trade", [ledIx(encSyncBackingDomainLedger(0))]);
  const L0 = parseLedgerCounters(Buffer.from((await conn.getAccountInfo(bckLedger.publicKey, "confirmed"))!.data));
  console.log(`  [pre-trade  ] cumLoss=${L0.cumLoss}  cumRecov=${L0.cumRecov}  lastUnavail=${L0.lastUnavail}`);

  // ---- TradeCpi (7144d9b: 7 fixed accounts, no signer_b) ----
  // Account layout (v16_program.rs:6751+):
  //   0  signer_a            (taker signer)
  //   1  market
  //   2  account_a           (taker portfolio)
  //   3  account_b           (LP portfolio)
  //   4  matcher_program
  //   5  matcher_context
  //   6  matcher_delegate    (PDA derived under wrapper)
  //   7+ tail (oracle accts; empty for Hyperp asset 0 which has no external oracle)
  console.log("\n  attempting TradeCpi: taker +100M long against LP via matcher…");
  try {
    await send([new TransactionInstruction({
      programId: PROG, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },   // signer_a (taker)
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: taker.publicKey, isSigner: false, isWritable: true },
        { pubkey: lp.publicKey, isSigner: false, isWritable: true },
        { pubkey: MATCHER, isSigner: false, isWritable: false },
        { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
        { pubkey: matcherDelegate, isSigner: false, isWritable: false },
      ], data: encTradeCpi({ assetIndex: 0, sizeQ: 100_000_000n, feeBps: 1n, limitPrice: 1_100_000n }),
    })]);
    console.log("  ✓ TradeCpi succeeded — LP filled the trade");
    // Diagnostic: did the trade actually move position state?
    const mai = (await conn.getAccountInfo(market.publicKey, "confirmed"))!;
    const mg: any = parseMarketGroup(Buffer.from(mai.data));
    const a0 = mg.assets[0];
    console.log(`    asset[0] OI long=${a0.oiEffLongQ} short=${a0.oiEffShortQ}  storedPos long=${a0.storedPosCountLong} short=${a0.storedPosCountShort}  effPrice=${a0.effectivePrice}`);
    const lai = (await conn.getAccountInfo(lp.publicKey, "confirmed"))!;
    const lpp: any = parsePortfolio(Buffer.from(lai.data));
    console.log(`    LP    cap=${lpp.capital}  pnl=${lpp.pnl}  legs=${lpp.legs.length} active_bitmap=0x${lpp.activeBitmap.toString(16)}` + (lpp.legs[0] ? `  leg[0]: side=${lpp.legs[0].side} basisPosQ=${lpp.legs[0].basisPosQ}` : ""));
    const tai = (await conn.getAccountInfo(taker.publicKey, "confirmed"))!;
    const tkp: any = parsePortfolio(Buffer.from(tai.data));
    console.log(`    taker cap=${tkp.capital}  pnl=${tkp.pnl}  legs=${tkp.legs.length} active_bitmap=0x${tkp.activeBitmap.toString(16)}` + (tkp.legs[0] ? `  leg[0]: side=${tkp.legs[0].side} basisPosQ=${tkp.legs[0].basisPosQ}` : ""));
  } catch (e: any) {
    const c = code(e);
    const sigm = (e?.message ?? "").match(/Transaction (\w{32,})/);
    console.log(`  ✗ TradeCpi: 0x${c}`);
    if (sigm) console.log(`    logs:\n      ${await fullLogs(sigm[1])}`);
    process.exit(1);
  }

  // ---- Phase 1: push mark DOWN to give LP positive PnL → builds source_claim_bound ----
  // The v16 engine requires an LP to have an outstanding source_claim on a backing domain
  // BEFORE it can engage that domain's bucket for IM during a stress scenario.  That claim
  // is bootstrapped by realized positive PnL via `add_account_source_positive_pnl_not_atomic`.
  // So: phase 1 walks the LP into +PnL, phase 2 walks it past its claim into bucket impairment.
  console.log("\n  Phase 1: push mark DOWN to 0.5 → LP short gains → realized PnL builds source_claim…");
  {
    const slot = BigInt(await conn.getSlot("confirmed"));
    await send([new TransactionInstruction({ programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
    ], data: encPushHyperpMark({ assetIndex: 0, nowSlot: slot, markE6: 500_000n } as any) })]);
  }
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const slot = BigInt(await conn.getSlot("confirmed"));
    try {
      await send([new TransactionInstruction({ programId: PROG, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: lp.publicKey, isSigner: false, isWritable: true },
      ], data: encPermissionlessCrank({ action: 0, assetIndex: 0, nowSlot: slot,
        fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }) })]);
    } catch { /* tolerate */ }
    const mai = (await conn.getAccountInfo(market.publicKey, "confirmed"))!;
    const mg: any = parseMarketGroup(Buffer.from(mai.data));
    const eff = mg.assets[0].effectivePrice;
    const lai = (await conn.getAccountInfo(lp.publicKey, "confirmed"))!;
    const lpp: any = parsePortfolio(Buffer.from(lai.data));
    console.log(`    [P1 crank ${i+1}/10] effPrice=${eff}  LP cap=${lpp.capital} pnl=${lpp.pnl}`);
    if (eff <= 600_000n) break;
  }
  // Sync now — does the bucket already register a lien? log unavailable
  await trySend("SyncBackingDomainLedger after P1", [ledIx(encSyncBackingDomainLedger(0))]);
  const L1 = parseLedgerCounters(Buffer.from((await conn.getAccountInfo(bckLedger.publicKey, "confirmed"))!.data));
  console.log(`  [after P1   ] cumLoss=${L1.cumLoss}  cumRecov=${L1.cumRecov}  lastUnavail=${L1.lastUnavail}`);

  // ---- Phase 2: push mark UP past breakage to drive LP short underwater ----
  console.log("\n  Phase 2: push target mark to 2.0 once, then 12 spaced cranks to walk effective price up…");
  {
    const slot = BigInt(await conn.getSlot("confirmed"));
    await send([new TransactionInstruction({ programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
    ], data: encPushHyperpMark({ assetIndex: 0, nowSlot: slot, markE6: 2_000_000n } as any) })]);
  }
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const slot = BigInt(await conn.getSlot("confirmed"));
    try {
      await send([new TransactionInstruction({ programId: PROG, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: lp.publicKey, isSigner: false, isWritable: true },
      ], data: encPermissionlessCrank({ action: 0, assetIndex: 0, nowSlot: slot,
        fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }) })]);
    } catch { /* tolerate */ }
    const mai = (await conn.getAccountInfo(market.publicKey, "confirmed"))!;
    const mg: any = parseMarketGroup(Buffer.from(mai.data));
    const eff = mg.assets[0].effectivePrice;
    console.log(`    [crank ${i+1}/12] effPrice=${eff}`);
    if (eff >= 1_100_000n) break;
  }
  // Now liquidate the LP — this is what engages the backing bucket
  console.log("\n  PermissionlessCrank action=1 (Liquidate) on LP — engages backing…");
  try {
    const slot = BigInt(await conn.getSlot("confirmed"));
    const sig = await send([new TransactionInstruction({ programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
      { pubkey: lp.publicKey, isSigner: false, isWritable: true },
    ], data: encPermissionlessCrank({ action: 1, assetIndex: 0, nowSlot: slot,
      fundingRateE9: 0n, closeQ: 50_000_000n, feeBps: 0n, recoveryReason: 0 }) })]);
    console.log(`    liquidate sig=${sig}`);
  } catch (e: any) {
    const msg = typeof e === "object" ? JSON.stringify(e, null, 2) : String(e);
    console.log(`    liquidate failed:\n${msg}`);
    if (e?.logs) console.log(`    logs:\n      ${e.logs.join("\n      ")}`);
    const sigm = msg.match(/Signature ([1-9A-HJ-NP-Za-km-z]{32,})/);
    if (sigm) {
      try {
        console.log(`    fetched logs:\n      ${await fullLogs(sigm[1])}`);
      } catch {}
    }
  }
  await trySend("SyncBackingDomainLedger post-loss", [ledIx(encSyncBackingDomainLedger(0))]);
  const L2 = parseLedgerCounters(Buffer.from((await conn.getAccountInfo(bckLedger.publicKey, "confirmed"))!.data));
  console.log(`  [post-loss  ] cumLoss=${L2.cumLoss}  cumRecov=${L2.cumRecov}  lastUnavail=${L2.lastUnavail}`);

  // Diagnostic: post-loss state of asset + LP
  {
    const mai = (await conn.getAccountInfo(market.publicKey, "confirmed"))!;
    const mg: any = parseMarketGroup(Buffer.from(mai.data));
    const a0 = mg.assets[0];
    console.log(`    asset[0] effPrice=${a0.effectivePrice}  fundPxLast=${a0.fundPxLast}  slotLast=${a0.slotLast}`);
    console.log(`    market   vault=${mg.vault}  c_tot=${mg.cTot}  insurance=${mg.insurance}`);
    const lai = (await conn.getAccountInfo(lp.publicKey, "confirmed"))!;
    const lpp: any = parsePortfolio(Buffer.from(lai.data));
    console.log(`    LP       cap=${lpp.capital}  pnl=${lpp.pnl}  legs=${lpp.legs.length}`);
  }

  const lossDelta = L2.cumLoss - L0.cumLoss;
  if (lossDelta > 0n) {
    console.log(`\n  🎯 cumulativeLoss grew by ${lossDelta} atoms — backing bucket was liened, counter incremented.`);
    process.exit(0);
  } else {
    console.log(`\n  cumulativeLoss did not grow.  Backing bucket was not engaged.  Likely causes:`);
    console.log(`    - Phase 1 mark move was too small to accrue positive PnL into source_claim`);
    console.log(`    - Phase 2 mark move did not exceed claim + capital`);
    console.log(`    - LP had no source_domain entry to lien against`);
    process.exit(1);
  }
})().catch(e => console.error("\nFATAL:", e?.message?.slice(0, 200) || e));
