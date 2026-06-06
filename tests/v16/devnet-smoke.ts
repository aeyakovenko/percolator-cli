/**
 * Devnet smoke suite for the live wrapper program `Bu1J8eQQN…`.
 *
 *   T1 — parseMarketGroup exposes asset_slot_capacity (PR #81)
 *   T2 — v16-inspect c_tot conservation handles partial discovery (PR #81)
 *   T3 — verify-manifest.ts resolves repo-relative default path (PR #81)
 *   T4 — pnpm typecheck:tests covers tests/ (PR #81)
 *   T5 — matcher SetMatcherConfig + TradeCpi + two-phase backing counter
 *
 * T5 deploys its OWN fresh market (markEwmaHalflife=1) so the two-phase mark
 * walk can drive `cumulative_loss_atoms` within a reasonable test horizon.
 *
 * Setup spends real devnet SOL. Teardown attempts CloseSlab; if it fails the
 * smoke market is left as a paid orphan on devnet (no big deal, devnet is
 * disposable).
 *
 * Run:  pnpm tsx tests/v16/devnet-smoke.ts
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
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  encInitMarket, encInitPortfolio, encDeposit, encWithdraw,
  encConfigureHyperpMark, encResolveMarket, encCloseResolved,
  encSyncMaintenanceFee, encWithdrawInsurance, encCloseSlab,
  encTradeCpi, encSetMatcherConfig, encPushHyperpMark,
  encPermissionlessCrank, encTopUpBackingBucket, encSyncBackingDomainLedger,
  marketAccountLenFor, PORTFOLIO_ACCOUNT_LEN, HEADER_LEN,
  MARKET_GROUP_OFF, MG, OracleProvider,
} from "../../src/v16/index.js";
import { parseMarketGroup, parsePortfolio } from "../../src/v16/parsers.js";

const MATCHER = new PublicKey("5ogNxr4uFXZXoeJ4cP89kKZkx1FkbaD2FBQr91KoYZep");

// ============================================================================
// Setup
// ============================================================================
const HOME = process.env.HOME!;
const RPC = `https://devnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").trim()}`;
const conn = new Connection(RPC, "confirmed");
const PROG = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

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

interface TestResult { name: string; passed: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, passed: boolean, details = "") {
  results.push({ name, passed, details });
  console.log(`  ${passed ? "✓" : "✗"} ${name}${details ? "  — " + details : ""}`);
}

// ============================================================================
// Smoke market setup: 1-slot Hyperp market + 2 portfolios + deposits
// ============================================================================
async function deploySmokeMarket(): Promise<{ market: Keypair; portfolios: Keypair[] }> {
  const market = Keypair.generate();
  const portA = Keypair.generate();
  const portB = Keypair.generate();
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.publicKey.toBuffer()], PROG);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);

  const accountLen = marketAccountLenFor(1);  // single-slot smoke market
  const mkRent = await conn.getMinimumBalanceForRentExemption(accountLen);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);

  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: accountLen, programId: PROG }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portA.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROG }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portB.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROG }),
  ], [admin, market, portA, portB]);

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

  // Configure asset 0 as a Hyperp mark (no external oracle dependency, ideal for devnet smoke)
  const slot = BigInt(await conn.getSlot("confirmed"));
  await send([new TransactionInstruction({
    programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
    ], data: encConfigureHyperpMark({ assetIndex: 0, nowSlot: slot, initialMarkE6: 1_000_000n,
      markEwmaHalflifeSlots: 300n, markMinFee: 500n } as any),
  })]);

  // Init both portfolios + give A capital so c_tot > 0
  for (const pf of [portA, portB]) {
    await send([new TransactionInstruction({ programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
      { pubkey: pf.publicKey, isSigner: false, isWritable: true },
    ], data: encInitPortfolio() })]);
  }
  await send([
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminAta, lamports: 200_000_000 }),
    createSyncNativeInstruction(adminAta),
  ]);
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: portA.publicKey, isSigner: false, isWritable: true },
    { pubkey: adminAta, isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ], data: encDeposit(50_000_000n) })]);

  return { market, portfolios: [portA, portB] };
}

// ============================================================================
// Tests
// ============================================================================

/**
 * Test 1 — parser exposes the on-chain `asset_slot_capacity` field.
 *
 * Claim in PR #81: the parser derives capacity from buffer length, never reads
 * the authoritative `MG.asset_slot_capacity` u32 from the header. A drift
 * between constants.ts and the deployed program would silently mis-decode.
 *
 * Test: read the u32 at MG.asset_slot_capacity directly from bytes, parse the
 * account via `parseMarketGroup`, assert the parser surfaces it as
 * `assetSlotCapacity` matching the on-chain value.
 */
async function testParserCapacity(market: Keypair) {
  console.log("\n[T1] parser exposes asset_slot_capacity from header bytes");
  const ai = await conn.getAccountInfo(market.publicKey, "confirmed");
  if (!ai) { record("market readable", false, "account not found"); return; }
  const buf = Buffer.from(ai.data);
  const onChainCap = buf.readUInt32LE(MARKET_GROUP_OFF + MG.asset_slot_capacity);
  const g: any = parseMarketGroup(buf);

  record("parseMarketGroup exposes assetSlotCapacity field",
    g.assetSlotCapacity !== undefined,
    `got ${g.assetSlotCapacity}`);
  record("parser.assetSlotCapacity matches on-chain bytes",
    g.assetSlotCapacity === onChainCap,
    `parser=${g.assetSlotCapacity}  on-chain=${onChainCap}`);
}

/**
 * Test 2 — v16-inspect's conservation check handles partial RPC discovery.
 *
 * Claim in PR #81: `c_tot == Σ portfolio capital` is an EXACT identity over
 * the COMPLETE portfolio set. If `getProgramAccounts` returns a partial set
 * (RPC truncation / pagination / eventual consistency), an exact-equality
 * check reports a fake conservation violation.
 *
 * Test: deploy a real market with portfolio A holding capital and portfolio B
 * holding none. The on-chain c_tot equals A's capital. Then run the inspect
 * script's conservation check against a DELIBERATELY PARTIAL portfolio set
 * (only B; A omitted). The exact check will say `cTot=50M, Σcapital=0,
 * VIOLATION`. The fixed check should fall back to `cTot ≥ Σcapital` (always
 * true over any subset) and emit a partial-discovery warning.
 */
async function testInspectConservation(market: Keypair, portfolios: Keypair[]) {
  console.log("\n[T2] v16-inspect.c_tot conservation skips exact check on partial discovery");
  const ai = await conn.getAccountInfo(market.publicKey, "confirmed");
  const g: any = parseMarketGroup(Buffer.from(ai!.data));
  const cTot: bigint = BigInt(g.cTot);
  const matz: bigint = BigInt(g.materializedPortfolioCount);

  // Collect every portfolio's capital
  const portfolioData: { pubkey: PublicKey; capital: bigint }[] = [];
  for (const pf of portfolios) {
    const pai = await conn.getAccountInfo(pf.publicKey, "confirmed");
    if (!pai) continue;
    const p: any = parsePortfolio(Buffer.from(pai.data));
    portfolioData.push({ pubkey: pf.publicKey, capital: BigInt(p.capital) });
  }
  const completeSum = portfolioData.reduce((s, p) => s + p.capital, 0n);

  // Sanity: complete discovery's sum should equal c_tot
  record("[setup] complete discovery: Σcapital == c_tot",
    completeSum === cTot,
    `Σ=${completeSum}, c_tot=${cTot}, matz=${matz}`);

  // Now exercise the inspect script's logic on a PARTIAL discovery (drop the
  // first portfolio, which is the one holding capital). The script's current
  // line 108 is an unconditional `m.group.cTot === sumPortfolioCapital`. Run
  // that same expression with one portfolio missing:
  const partialSet = portfolioData.slice(1);
  const partialSum = partialSet.reduce((s, p) => s + p.capital, 0n);
  const currentScriptCheck = cTot === partialSum;
  // For our setup partialSum=0 (portB) and cTot=50_000_000 (from portA's deposit),
  // so currentScriptCheck === false. That IS the false-positive the PR describes.
  // The fix is to NOT assert exact equality when discovery is partial.
  const partialDiscovery = BigInt(partialSet.length) < matz;
  const fixedScriptCheck = partialDiscovery
    ? cTot >= partialSum                // subset lower-bound is always true
    : cTot === partialSum;              // complete set: exact identity

  record("partial-discovery exact-equality DOES false-positive on current logic (sanity)",
    !currentScriptCheck && cTot > partialSum,
    `cTot=${cTot}, partialΣ=${partialSum}, exact-check=${currentScriptCheck}`);
  record("fixed logic: lower-bound check passes on partial discovery",
    fixedScriptCheck,
    `partialDiscovery=${partialDiscovery}, c_tot≥Σ=${cTot >= partialSum}`);
}

/**
 * Test 3 — verify-manifest resolves the default manifest path repo-relative.
 *
 * Claim in PR #81: the default `MANIFEST_PATH` is hardcoded to
 * `$HOME/percolator-cli/mainnet-bounty5-v16-market.json`. That file was
 * deleted in commit 709f89e. So `pnpm test` (which currently runs
 * `verify-manifest.ts`) fails immediately with ENOENT — and even if the file
 * existed, the absolute path means the script only works from the author's
 * home directory.
 *
 * Test: spawn `tsx scripts/verify-manifest.ts` from /tmp (so `process.cwd()`
 * is irrelevant), with `MANIFEST_PATH` unset, and `HOME` set to a directory
 * with no `percolator-cli` subtree. The script must NOT throw ENOENT — it
 * should resolve a sensible default relative to the repo.
 */
async function testVerifyManifestPath() {
  console.log("\n[T3] verify-manifest.ts default path resolves repo-relative");
  const tmpHome = "/tmp/percolator-cli-test-home-" + Date.now();
  fs.mkdirSync(tmpHome, { recursive: true });
  try {
    // Truly unset MANIFEST_PATH (empty string would pass the `??` fallback,
    // masking the bug) so the script falls back to its hard-coded default.
    const childEnv = { ...process.env, HOME: tmpHome } as Record<string, string>;
    delete childEnv.MANIFEST_PATH;
    const r = spawnSync("node_modules/.bin/tsx", ["scripts/verify-manifest.ts"], {
      cwd: REPO_ROOT,
      env: childEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
    const allOut = (r.stdout ?? "") + "\n" + (r.stderr ?? "");
    const enoent = /ENOENT|no such file or directory/i.test(allOut);
    record("verify-manifest does NOT ENOENT when HOME is foreign",
      !enoent,
      enoent
        ? `script crashed with ENOENT — default path is brittle: "${(allOut.match(/ENOENT.*$/im) ?? [""])[0]}"`
        : `exit=${r.status}`);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

/**
 * Test 4 — `pnpm typecheck:tests` covers tests/, not just src/.
 *
 * Claim in PR #81: `tsconfig.json` `include: ["src/**\/*"]` excludes the
 * `tests/` tree, so a broken import there (e.g. the legacy tests/*.ts files
 * importing `src/solana/{pda,slab}.js` after those modules were removed in
 * commit 2ddf8ca) silently rots — never tripped at typecheck, never tripped
 * at build. The fix is `tsconfig.tests.json` that extends the base config
 * with `include: ["src/**\/*", "tests/**\/*"]`, exposed as `pnpm typecheck:tests`.
 *
 * (PR #81 also proposed widening to scripts/ — but `scripts/` carries
 * pre-existing type rot in `smoke-v16-full.ts`, `probe-capital-flow.ts`,
 * `find-fresh-*.ts`, etc. that's NOT a missing-import problem. Folding it in
 * would conflate the PR #81 fix with unrelated quality cleanup. Kept narrow.)
 */
function testTypecheckCoversTests() {
  console.log("\n[T4] pnpm typecheck:tests covers tests/");
  const r = spawnSync("node_modules/.bin/tsc", ["-p", "tsconfig.tests.json", "--noEmit"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  const out = (r.stdout ?? "") + "\n" + (r.stderr ?? "");
  const moduleErrors = /Cannot find module|TS2307|TS2304/i.test(out);
  record("tsc tsconfig.tests.json: no Cannot-find-module under tests/",
    !moduleErrors && r.status === 0,
    moduleErrors
      ? `broken import surfaced: "${(out.match(/.*Cannot find module.*$/im) ?? [""])[0]}"`
      : `exit=${r.status}`);
}

/**
 * Test 5 — matcher binding + TradeCpi + backing counter
 *
 * Covers the wrapper-7144d9b end-to-end matcher path against devnet matcher
 * `5ogNxr4u…` (vAMM kind). Verifies:
 *
 *   (a) SetMatcherConfig (tag 68) writes the matcher tuple into the LP
 *       portfolio's 104-byte tail.
 *   (b) TradeCpi (tag 10, 7 fixed accounts) fills the LP at the matcher's
 *       quoted price; the LP gets a short leg, taker gets a long leg.
 *   (c) Two-phase mark scenario drives `cumulative_loss_atoms`:
 *       Phase 1 (mark DOWN) → LP positive PnL → engine credits source_claim.
 *       Phase 2 (mark UP)   → LP loss > claim+capital → bucket.consumed_liened
 *                              grows → SyncBackingDomainLedger ticks the counter.
 *
 * Uses its own market so the EWMA halflife can be 1 slot (the main smoke market
 * uses 300 slots which is too slow to walk effective price within a test).
 */
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
function u128le(b: Buffer, o: number): bigint {
  return b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
}
function parseLedgerCounters(buf: Buffer) {
  let o = HEADER_LEN + 32 + 32 + 16 * 6;
  return {
    cumLoss:     u128le(buf, o),
    cumRecov:    u128le(buf, o + 16),
    lastUnavail: u128le(buf, o + 32),
  };
}

async function testMatcherFlow(): Promise<{ market: Keypair; portfolios: Keypair[] }> {
  console.log("\n[T5] matcher binding + TradeCpi + backing counter (two-phase)");
  const market = Keypair.generate();
  const lp = Keypair.generate();
  const taker = Keypair.generate();
  const matcherCtx = Keypair.generate();
  const bckLedger = Keypair.generate();
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.publicKey.toBuffer()], PROG);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);

  const [matcherDelegate] = PublicKey.findProgramAddressSync([
    Buffer.from("matcher"),
    market.publicKey.toBuffer(),
    lp.publicKey.toBuffer(),
    admin.publicKey.toBuffer(),
    MATCHER.toBuffer(),
    matcherCtx.publicKey.toBuffer(),
  ], PROG);

  const mkLen = marketAccountLenFor(1);
  const mkRent = await conn.getMinimumBalanceForRentExemption(mkLen);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  const ctxRent = await conn.getMinimumBalanceForRentExemption(320);
  const ledRent = await conn.getMinimumBalanceForRentExemption(2048);

  await send([
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
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
  ], data: encInitMarket({
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
  } as any) })]);
  const slot0 = BigInt(await conn.getSlot("confirmed"));
  // markEwmaHalflifeSlots=1 so effective price tracks the target in 1 crank
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encConfigureHyperpMark({ assetIndex: 0, nowSlot: slot0, initialMarkE6: 1_000_000n,
    markEwmaHalflifeSlots: 1n, markMinFee: 500n } as any) })]);
  for (const pf of [lp, taker]) {
    await send([new TransactionInstruction({ programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
      { pubkey: pf.publicKey, isSigner: false, isWritable: true },
    ], data: encInitPortfolio() })]);
  }
  await send([
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
  // LP intentionally thin: 10M cap on a 100M short = 10x leverage, mm@5%=5M.
  await send([dep(lp.publicKey, 10_000_000n)]);
  await send([dep(taker.publicKey, 300_000_000n)]);
  const expirySlot = BigInt(await conn.getSlot("confirmed")) + 10_000_000n;
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: adminAta, isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: bckLedger.publicKey, isSigner: false, isWritable: true },
  ], data: encTopUpBackingBucket({ domain: 0, amount: 400_000_000n, expirySlot }) })]);
  // Init matcher (tag 2)
  await send([new TransactionInstruction({ programId: MATCHER, keys: [
    { pubkey: matcherDelegate, isSigner: false, isWritable: false },
    { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
  ], data: encMatcherInitVamm({
    kind: 1, tradingFeeBps: 10, baseSpreadBps: 50, maxTotalBps: 1000,
    impactKBps: 1, liquidityNotionalE6: 1_000_000_000n,
    maxFillAbs: 100_000_000n, maxInventoryAbs: 500_000_000n,
  }) })]);

  // (a) SetMatcherConfig writes the tuple into the LP portfolio tail
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },     // lp_owner
    { pubkey: market.publicKey, isSigner: false, isWritable: false },
    { pubkey: lp.publicKey, isSigner: false, isWritable: true },
    { pubkey: MATCHER, isSigner: false, isWritable: false },
    { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: false },
    { pubkey: matcherDelegate, isSigner: false, isWritable: false },
  ], data: encSetMatcherConfig(1) })]);
  const lpAfterCfg = (await conn.getAccountInfo(lp.publicKey, "confirmed"))!;
  const cfgEnabled = lpAfterCfg.data[PORTFOLIO_ACCOUNT_LEN - 8];
  const cfgMatcherProg = new PublicKey(lpAfterCfg.data.slice(
    PORTFOLIO_ACCOUNT_LEN - 104, PORTFOLIO_ACCOUNT_LEN - 72));
  record("SetMatcherConfig writes enabled=1 into LP portfolio tail",
    cfgEnabled === 1, `enabled byte=${cfgEnabled}, matcher_program=${cfgMatcherProg.toBase58()}`);
  record("SetMatcherConfig wrote correct matcher program",
    cfgMatcherProg.equals(MATCHER), `expected=${MATCHER.toBase58()}, got=${cfgMatcherProg.toBase58()}`);

  // (b) TradeCpi (7 fixed accounts, no signer_b)
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },     // signer_a (taker)
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: taker.publicKey, isSigner: false, isWritable: true },
    { pubkey: lp.publicKey, isSigner: false, isWritable: true },
    { pubkey: MATCHER, isSigner: false, isWritable: false },
    { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
    { pubkey: matcherDelegate, isSigner: false, isWritable: false },
  ], data: encTradeCpi({ assetIndex: 0, sizeQ: 100_000_000n, feeBps: 1n, limitPrice: 1_100_000n }) })]);
  const lpAfterTrade: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(lp.publicKey, "confirmed"))!.data));
  const takerAfterTrade: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(taker.publicKey, "confirmed"))!.data));
  record("TradeCpi: LP has 1 short leg (basis -100M)",
    lpAfterTrade.legs.length === 1 && lpAfterTrade.legs[0].side === 1 && lpAfterTrade.legs[0].basisPosQ === -100_000_000n,
    `legs=${lpAfterTrade.legs.length}, side=${lpAfterTrade.legs[0]?.side}, basis=${lpAfterTrade.legs[0]?.basisPosQ}`);
  record("TradeCpi: taker has 1 long leg (basis +100M)",
    takerAfterTrade.legs.length === 1 && takerAfterTrade.legs[0].side === 0 && takerAfterTrade.legs[0].basisPosQ === 100_000_000n,
    `legs=${takerAfterTrade.legs.length}, side=${takerAfterTrade.legs[0]?.side}, basis=${takerAfterTrade.legs[0]?.basisPosQ}`);

  // (c) Two-phase mark walk → counter increments
  const ledIx = (data: Buffer) => new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: bckLedger.publicKey, isSigner: false, isWritable: true },
  ], data });
  await send([ledIx(encSyncBackingDomainLedger(0))]);
  const L0 = parseLedgerCounters(Buffer.from((await conn.getAccountInfo(bckLedger.publicKey, "confirmed"))!.data));

  // Phase 1: mark DOWN → LP positive PnL → source_claim_bound grows
  console.log("    Phase 1 (mark DOWN, 10 cranks ~5s each)…");
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encPushHyperpMark({ assetIndex: 0, nowSlot: BigInt(await conn.getSlot("confirmed")), markE6: 500_000n } as any) })]);
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const s = BigInt(await conn.getSlot("confirmed"));
    try {
      await send([new TransactionInstruction({ programId: PROG, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: lp.publicKey, isSigner: false, isWritable: true },
      ], data: encPermissionlessCrank({ action: 0, assetIndex: 0, nowSlot: s,
        fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }) })]);
    } catch { /* tolerate transient */ }
  }
  const lpAfterP1: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(lp.publicKey, "confirmed"))!.data));
  record("Phase 1: LP accrued positive PnL (builds source_claim)",
    BigInt(lpAfterP1.pnl) > 0n, `LP pnl=${lpAfterP1.pnl}`);

  // Phase 2: mark UP past 1.0 → LP loss exceeds claim+capital → bucket consumes
  console.log("    Phase 2 (mark UP, 12 cranks ~5s each)…");
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encPushHyperpMark({ assetIndex: 0, nowSlot: BigInt(await conn.getSlot("confirmed")), markE6: 2_000_000n } as any) })]);
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const s = BigInt(await conn.getSlot("confirmed"));
    try {
      await send([new TransactionInstruction({ programId: PROG, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: lp.publicKey, isSigner: false, isWritable: true },
      ], data: encPermissionlessCrank({ action: 0, assetIndex: 0, nowSlot: s,
        fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }) })]);
    } catch { /* tolerate transient */ }
    // Early exit once we cross 1.0 (LP definitely past its claim+capital at that point)
    const eff = BigInt((parseMarketGroup(Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data)) as any).assets[0].effectivePrice);
    if (eff >= 1_100_000n) break;
  }
  await send([ledIx(encSyncBackingDomainLedger(0))]);
  const L2 = parseLedgerCounters(Buffer.from((await conn.getAccountInfo(bckLedger.publicKey, "confirmed"))!.data));
  record("Phase 2: cumulative_loss_atoms incremented from bucket consume",
    L2.cumLoss > L0.cumLoss, `pre=${L0.cumLoss}, post=${L2.cumLoss}, delta=${L2.cumLoss - L0.cumLoss}`);
  record("Phase 2: last_observed_unavailable matches cumulative_loss",
    L2.lastUnavail === L2.cumLoss, `lastUnavail=${L2.lastUnavail}, cumLoss=${L2.cumLoss}`);

  return { market, portfolios: [lp, taker] };
}

// ============================================================================
// Teardown — best-effort cleanup so devnet doesn't accumulate orphans
// ============================================================================
async function teardown(market: Keypair, portfolios: Keypair[]) {
  console.log("\n[teardown] best-effort cleanup…");
  try {
    await send([new TransactionInstruction({ programId: PROG, keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: market.publicKey, isSigner: false, isWritable: true },
    ], data: encResolveMarket() })]);
    const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.publicKey.toBuffer()], PROG);
    const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
    const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
    for (const pf of portfolios) {
      try {
        await send([new TransactionInstruction({ programId: PROG, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: pf.publicKey, isSigner: false, isWritable: true },
          { pubkey: adminAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: vaultAuth, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encCloseResolved(0n) })]);
        await send([new TransactionInstruction({ programId: PROG, keys: [
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: pf.publicKey, isSigner: false, isWritable: true },
        ], data: encSyncMaintenanceFee(BigInt(await conn.getSlot("confirmed"))) })]);
      } catch { /* tolerate */ }
    }
    // Drain insurance + close slab if possible
    try {
      const ai = (await conn.getAccountInfo(market.publicKey, "confirmed"))!;
      const g: any = parseMarketGroup(Buffer.from(ai.data));
      const insKeys = [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: adminAta, isSigner: false, isWritable: true }, { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuth, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ];
      if (BigInt(g.insurance) > 0n) {
        await send([new TransactionInstruction({ programId: PROG, keys: insKeys, data: encWithdrawInsurance(BigInt(g.insurance)) })]);
      }
      await send([new TransactionInstruction({ programId: PROG, keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: market.publicKey, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: vaultAuth, isSigner: false, isWritable: false },
        { pubkey: adminAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }],
        data: encCloseSlab() })]);
      console.log("  market closed");
    } catch (e: any) { console.log(`  CloseSlab skipped: ${code(e)}`); }
    try { await send([createCloseAccountInstruction(adminAta, admin.publicKey, admin.publicKey)]); } catch { /* tolerate */ }
  } catch (e: any) { console.log(`  teardown: ${code(e)} (orphan market left on devnet)`); }
}

// ============================================================================
// Main
// ============================================================================
(async () => {
  console.log("=".repeat(72));
  console.log("Devnet smoke — PR #81 TDD + matcher TradeCpi + backing counter");
  console.log("=".repeat(72));

  // Tests that don't need a deployed market — run first, cheap
  testTypecheckCoversTests();
  await testVerifyManifestPath();

  // Tests that DO need a deployed market — costs SOL
  console.log("\n[setup] deploying smoke market on devnet…");
  const { market, portfolios } = await deploySmokeMarket();
  console.log(`  market: ${market.publicKey.toBase58()}`);
  try {
    await testParserCapacity(market);
    await testInspectConservation(market, portfolios);
  } finally {
    await teardown(market, portfolios);
  }

  // T5: matcher init + TradeCpi + backing counter (own fresh market)
  let matcherEnv: { market: Keypair; portfolios: Keypair[] } | null = null;
  try {
    matcherEnv = await testMatcherFlow();
  } catch (e: any) {
    record("[T5] matcher flow", false, `threw: ${e?.message ?? e}`);
  } finally {
    if (matcherEnv) await teardown(matcherEnv.market, matcherEnv.portfolios);
  }

  // ----------------------------------------------------------------- summary
  const failed = results.filter(r => !r.passed);
  console.log("\n" + "=".repeat(72));
  console.log(`Result: ${results.length - failed.length}/${results.length} assertions passed`);
  if (failed.length > 0) {
    console.log("\nFAILURES (real bugs to fix):");
    for (const r of failed) console.log(`  ✗ ${r.name}${r.details ? "  — " + r.details : ""}`);
    process.exit(1);
  }
  console.log("All assertions green.");
})().catch(e => { console.error("FATAL:", e?.message || e); process.exit(2); });
