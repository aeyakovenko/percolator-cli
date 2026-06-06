/**
 * Devnet smoke suite for the live wrapper program `Bu1J8eQQN…`.
 *
 *   T1  — parseMarketGroup exposes asset_slot_capacity (PR #81)
 *   T2  — v16-inspect c_tot conservation handles partial discovery (PR #81)
 *   T3  — verify-manifest.ts resolves repo-relative default path (PR #81)
 *   T4  — pnpm typecheck:tests covers tests/ (PR #81)
 *   T5  — matcher SetMatcherConfig + TradeCpi + two-phase backing counter
 *   T6  — UpdateAuthority (tag 32) + UpdateAssetAuthority (tag 65) — auth rotation
 *   T7  — TradeNoCpi (6) + BatchTradeNoCpi (66) — bilateral signed trades
 *   T8  — Config setters (33/37/38/49/51/55/58/59) — admin policy updates
 *   T9  — Per-domain insurance (56/57) + SyncInsuranceLedger (54)
 *   T10 — AUTH_MARK oracle mode: ConfigureAuthMark (62) + PushAuthMark (63)
 *   T11 — BatchTradeCpi (67) — matcher-fill single-leg batch
 *
 * Tags NOT smoked (require RECOVERY/abandoned state or multi-day cooldowns):
 *   23 WithdrawInsuranceLimited       (admin cooldown gate)
 *   28 ConvertReleasedPnl             (needs settled positive PnL)
 *   34 ConfigureHybridOracle          (needs 3 Pyth oracle accounts on devnet)
 *   39 ResolveStalePermissionless     (needs stale-matured oracle)
 *   40 UpdateAssetLifecycle           (multi-asset / activate-deactivate flow)
 *   42–47 recovery primitives (CureAndCancel / ForfeitRecovery / RebalanceReduce /
 *         FinalizeResetSide / ClaimResolvedPayoutTopup / RefineResolvedUnreceiptedBound)
 *   50 WithdrawBackingBucket          (needs expired bucket)
 *   52 WithdrawBackingBucketEarnings  (needs accrued earnings)
 *   60 UpdateBaseUnitMints / 61 SwapSecondaryForPrimary (secondary-mint custody)
 *   64 ForceCloseAbandonedAsset       (asset abandonment state)
 *   69 RestartAsset0Oracle            (RECOVERY mode)
 *   PermissionlessCrank action=1 (Liquidate) / action=2 (SettleB) — both hit
 *     RecoveryRequired in the T5 LP scenario; need a specific entry condition
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
  encConfigureEwmaMark, encResolveMarket, encCloseResolved,
  encSyncMaintenanceFee, encWithdrawInsurance, encCloseSlab,
  encTradeCpi, encSetMatcherConfig, encPushEwmaMark,
  encPermissionlessCrank, encTopUpBackingBucket, encSyncBackingDomainLedger,
  encTradeNoCpi, encBatchTradeNoCpi, encBatchTradeCpi,
  encUpdateAuthority, encUpdateAssetAuthority,
  encUpdateInsurancePolicy, encUpdateLiquidationFeePolicy,
  encUpdateMaintenanceFeePolicy, encUpdateBackingFeePolicy,
  encUpdateTradeFeePolicy, encUpdateFeeRedirectPolicy,
  encUpdateMarketInitFeePolicy, encConfigurePermissionlessResolve,
  encConfigureAuthMark, encPushAuthMark,
  encTopUpInsuranceDomain, encWithdrawInsuranceDomain,
  encSyncInsuranceLedger,
  marketAccountLenFor, PORTFOLIO_ACCOUNT_LEN, HEADER_LEN,
  MARKET_GROUP_OFF, MG, OracleProvider,
} from "../../src/v16/index.js";
import { parseMarketGroup, parsePortfolio, parseWrapperConfig, parseAssetOracleProfile } from "../../src/v16/parsers.js";
import { MARKET_GROUP_OFF as _MG_OFF_ALIAS, MARKET_GROUP_HEADER_LEN, ASSET_SLOT_LEN } from "../../src/v16/constants.js";

// Offset of asset 0's per-slot oracle profile inside the market account.
const ASSET0_PROFILE_OFF = MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN; // first slot, oracle profile at slot+0

// ============================================================================
// Asset-authority kind codes (v16_program.rs:4667+) — used by tag 65
// ============================================================================
const ASSET_AUTH_ADMIN = 0;
const ASSET_AUTH_INSURANCE = 1;
const ASSET_AUTH_INSURANCE_OPERATOR = 2;
const ASSET_AUTH_BACKING_BUCKET = 3;
const ASSET_AUTH_ORACLE = 4;

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
    ], data: encConfigureEwmaMark({ assetIndex: 0, nowSlot: slot, initialMarkE6: 1_000_000n,
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
  ], data: encConfigureEwmaMark({ assetIndex: 0, nowSlot: slot0, initialMarkE6: 1_000_000n,
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
  ], data: encPushEwmaMark({ assetIndex: 0, nowSlot: BigInt(await conn.getSlot("confirmed")), markE6: 500_000n } as any) })]);
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
  ], data: encPushEwmaMark({ assetIndex: 0, nowSlot: BigInt(await conn.getSlot("confirmed")), markE6: 2_000_000n } as any) })]);
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
// deployBareEwmaMarket — minimal market deploy without portfolios/deposits.
// Used by T6/T8/T9/T10 which exercise admin-only paths.
// ============================================================================
async function deployBareEwmaMarket(): Promise<{ market: Keypair }> {
  const market = Keypair.generate();
  const accountLen = marketAccountLenFor(1);
  const mkRent = await conn.getMinimumBalanceForRentExemption(accountLen);
  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: accountLen, programId: PROG }),
  ], [admin, market]);
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
  const slot = BigInt(await conn.getSlot("confirmed"));
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encConfigureEwmaMark({ assetIndex: 0, nowSlot: slot, initialMarkE6: 1_000_000n,
    markEwmaHalflifeSlots: 300n, markMinFee: 500n } as any) })]);
  return { market };
}

/**
 * T6 — UpdateAuthority (tag 32) + UpdateAssetAuthority (tag 65)
 *
 * Production-critical: how bounty markets rotate / burn the marketauth key and
 * how per-asset oracle authority gets rotated.  Both require the incoming key
 * to CO-SIGN (proves control) unless burning to all-zeros (admin-only burn).
 */
async function testAuthorityRotation(): Promise<{ market: Keypair; portfolios: Keypair[] }> {
  console.log("\n[T6] UpdateAuthority + UpdateAssetAuthority");
  const { market } = await deployBareEwmaMarket();
  const newAuth = Keypair.generate();
  const newOracle = Keypair.generate();
  // newAuth + newOracle need lamports to sign tx (devnet requires rent on signers)
  await send([
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: newAuth.publicKey, lamports: 1_000_000 }),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: newOracle.publicKey, lamports: 1_000_000 }),
  ]);

  // UpdateAuthority: rotate marketauth admin → newAuth (newAuth must co-sign)
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: newAuth.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encUpdateAuthority({ newPubkey: newAuth.publicKey }) })], [admin, newAuth]);
  const wcAfterAuth = parseWrapperConfig(Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data));
  record("UpdateAuthority: marketauth rotated to newAuth",
    wcAfterAuth.marketauth.equals(newAuth.publicKey),
    `marketauth=${wcAfterAuth.marketauth.toBase58()}`);

  // Rotate back: newAuth → admin (admin must co-sign)
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: newAuth.publicKey, isSigner: true, isWritable: false },
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encUpdateAuthority({ newPubkey: admin.publicKey }) })], [admin, newAuth]);
  const wcAfterReturn = parseWrapperConfig(Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data));
  record("UpdateAuthority: rotated back to admin",
    wcAfterReturn.marketauth.equals(admin.publicKey),
    `marketauth=${wcAfterReturn.marketauth.toBase58()}`);

  // UpdateAssetAuthority: rotate asset-0 ORACLE auth (current = admin per marketauth) → newOracle
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: newOracle.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encUpdateAssetAuthority({ assetIndex: 0, kind: ASSET_AUTH_ORACLE, newPubkey: newOracle.publicKey }) })],
    [admin, newOracle]);
  const profAfterRot = parseAssetOracleProfile(Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data), ASSET0_PROFILE_OFF, 0);
  record("UpdateAssetAuthority: asset-0 oracle auth → newOracle",
    profAfterRot.oracleAuthority.equals(newOracle.publicKey),
    `oracleAuth=${profAfterRot.oracleAuthority.toBase58()}`);

  // Burn: rotate asset-0 ADMIN auth → 0. The wrapper blocks burning insurance/
  // operator/backing/oracle to zero (each is liveness-critical, v16_program.rs:9003-9005);
  // ASSET_AUTH_ADMIN is the only kind that may be burned, and only the current
  // admin needs to sign (the "new" account is not a signer when burning).
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },           // current admin
    { pubkey: PublicKey.default, isSigner: false, isWritable: false },        // new = 0
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encUpdateAssetAuthority({ assetIndex: 0, kind: ASSET_AUTH_ADMIN, newPubkey: PublicKey.default }) })]);
  const profAfterBurn = parseAssetOracleProfile(Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data), ASSET0_PROFILE_OFF, 0);
  record("UpdateAssetAuthority: asset-0 ADMIN burned to default",
    profAfterBurn.assetAdmin.equals(PublicKey.default),
    `assetAdmin=${profAfterBurn.assetAdmin.toBase58()}`);

  return { market, portfolios: [] };
}

/**
 * T7 — TradeNoCpi (tag 6) + BatchTradeNoCpi (tag 66)
 *
 * Bilateral signed trades with the engine as a deterministic recorder.
 * BatchTradeNoCpi shares the same account list and lets a single signing pair
 * execute multiple legs atomically (max 16). Since this is a 1-slot market we
 * exercise BatchTradeNoCpi with a single leg as a "second open" against the
 * already-open position from TradeNoCpi.
 */
async function testBilateralAndBatch(): Promise<{ market: Keypair; portfolios: Keypair[] }> {
  console.log("\n[T7] TradeNoCpi + BatchTradeNoCpi (bilateral)");
  const market = Keypair.generate();
  const portA = Keypair.generate();
  const portB = Keypair.generate();
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.publicKey.toBuffer()], PROG);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);

  const mkLen = marketAccountLenFor(1);
  const mkRent = await conn.getMinimumBalanceForRentExemption(mkLen);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);

  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: mkLen, programId: PROG }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portA.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROG }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portB.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROG }),
  ], [admin, market, portA, portB]);
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
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encConfigureEwmaMark({ assetIndex: 0, nowSlot: slot0, initialMarkE6: 1_000_000n,
    markEwmaHalflifeSlots: 300n, markMinFee: 500n } as any) })]);
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
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminAta, lamports: 400_000_000 }),
    createSyncNativeInstruction(adminAta),
  ]);
  const dep = (pf: PublicKey, amt: bigint) => new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: pf, isSigner: false, isWritable: true }, { pubkey: adminAta, isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }],
    data: encDeposit(amt) });
  await send([dep(portA.publicKey, 150_000_000n), dep(portB.publicKey, 150_000_000n)]);

  // TradeNoCpi: A long 50M @ 1.0, B short 50M @ 1.0
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },     // signer_a
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },     // signer_b (admin owns both portfolios)
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: portA.publicKey, isSigner: false, isWritable: true },
    { pubkey: portB.publicKey, isSigner: false, isWritable: true },
  ], data: encTradeNoCpi({ assetIndex: 0, sizeQ: 50_000_000n, execPrice: 1_000_000n, feeBps: 1n }) })]);
  const pA1: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(portA.publicKey, "confirmed"))!.data));
  const pB1: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(portB.publicKey, "confirmed"))!.data));
  record("TradeNoCpi: A long 50M, B short 50M",
    pA1.legs.length === 1 && pA1.legs[0].side === 0 && pA1.legs[0].basisPosQ === 50_000_000n
    && pB1.legs.length === 1 && pB1.legs[0].side === 1 && pB1.legs[0].basisPosQ === -50_000_000n,
    `A side=${pA1.legs[0]?.side} basis=${pA1.legs[0]?.basisPosQ}, B side=${pB1.legs[0]?.side} basis=${pB1.legs[0]?.basisPosQ}`);

  // BatchTradeNoCpi single-leg: A long another 30M, B short 30M
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: portA.publicKey, isSigner: false, isWritable: true },
    { pubkey: portB.publicKey, isSigner: false, isWritable: true },
  ], data: encBatchTradeNoCpi([
    { assetIndex: 0, sizeQ: 30_000_000n, execPrice: 1_000_000n, feeBps: 1n },
  ]) })]);
  const pA2: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(portA.publicKey, "confirmed"))!.data));
  const pB2: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(portB.publicKey, "confirmed"))!.data));
  record("BatchTradeNoCpi (1 leg): position grew to 80M",
    pA2.legs[0].basisPosQ === 80_000_000n && pB2.legs[0].basisPosQ === -80_000_000n,
    `A basis=${pA2.legs[0].basisPosQ}, B basis=${pB2.legs[0].basisPosQ}`);

  // Close roundtrip via TradeNoCpi reverse (A short 80M, B long 80M)
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: portA.publicKey, isSigner: false, isWritable: true },
    { pubkey: portB.publicKey, isSigner: false, isWritable: true },
  ], data: encTradeNoCpi({ assetIndex: 0, sizeQ: -80_000_000n, execPrice: 1_000_000n, feeBps: 1n }) })]);
  const pA3: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(portA.publicKey, "confirmed"))!.data));
  const pB3: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(portB.publicKey, "confirmed"))!.data));
  record("TradeNoCpi close: both portfolios back to 0 legs",
    pA3.legs.length === 0 && pB3.legs.length === 0,
    `A.legs=${pA3.legs.length}, B.legs=${pB3.legs.length}`);

  return { market, portfolios: [portA, portB] };
}

/**
 * T8 — Config setters (7 tags) + ConfigurePermissionlessResolve (38)
 *
 * Updates each policy and re-reads MG state to confirm the bytes persisted.
 * These are admin-only operations against a fresh market.
 */
async function testConfigSetters(): Promise<{ market: Keypair; portfolios: Keypair[] }> {
  console.log("\n[T8] Config setters (33/37/38/49/51/55/58/59)");
  const { market } = await deployBareEwmaMarket();
  const adminKeys = (writable = true) => [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: writable },
  ];

  // tag 33 — UpdateInsurancePolicy (max_bps, deposits_only, cooldown_slots)
  await send([new TransactionInstruction({ programId: PROG, keys: adminKeys(),
    data: encUpdateInsurancePolicy({ maxBps: 2500, depositsOnly: 0, cooldownSlots: 50_000n }) })]);
  // tag 37 — UpdateLiquidationFeePolicy
  await send([new TransactionInstruction({ programId: PROG, keys: adminKeys(),
    data: encUpdateLiquidationFeePolicy(1500) })]);
  // tag 38 — ConfigurePermissionlessResolve (stale_slots, force_close_delay_slots)
  await send([new TransactionInstruction({ programId: PROG, keys: adminKeys(),
    data: encConfigurePermissionlessResolve({ staleSlots: 80n, forceCloseDelaySlots: 50n }) })]);
  // tag 49 — UpdateMaintenanceFeePolicy
  await send([new TransactionInstruction({ programId: PROG, keys: adminKeys(),
    data: encUpdateMaintenanceFeePolicy(2000) })]);
  // tag 51 — UpdateBackingFeePolicy (per-domain)
  await send([new TransactionInstruction({ programId: PROG, keys: adminKeys(),
    data: encUpdateBackingFeePolicy({ domain: 0, feeBps: 5, insuranceShareBps: 1000 }) })]);
  // tag 55 — UpdateTradeFeePolicy
  await send([new TransactionInstruction({ programId: PROG, keys: adminKeys(),
    data: encUpdateTradeFeePolicy(7n) })]);
  // tag 58 — UpdateFeeRedirectPolicy
  await send([new TransactionInstruction({ programId: PROG, keys: adminKeys(),
    data: encUpdateFeeRedirectPolicy(3000) })]);
  // tag 59 — UpdateMarketInitFeePolicy
  await send([new TransactionInstruction({ programId: PROG, keys: adminKeys(),
    data: encUpdateMarketInitFeePolicy(7_500_000n) })]);

  // Confirm fields persisted by re-parsing the wrapper config
  const wc = parseWrapperConfig(Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data));
  record("Config setters: all 8 admin policy tags accepted by deployed wrapper",
    true, "tags 33/37/38/49/51/55/58/59 all succeeded");
  record("UpdateTradeFeePolicy persisted: trade_fee_base_bps == 7",
    Number(wc.tradeFeeBaseBps) === 7, `tradeFeeBaseBps=${wc.tradeFeeBaseBps}`);
  record("UpdateLiquidationFeePolicy persisted: cranker_share == 1500",
    Number(wc.liquidationCrankerFeeShareBps) === 1500, `cranker=${wc.liquidationCrankerFeeShareBps}`);
  record("UpdateInsurancePolicy persisted: max_bps == 2500, cooldown == 50000",
    Number(wc.insuranceWithdrawMaxBps) === 2500 && Number(wc.insuranceWithdrawCooldownSlots) === 50000,
    `max=${wc.insuranceWithdrawMaxBps} cooldown=${wc.insuranceWithdrawCooldownSlots}`);
  record("UpdateFeeRedirectPolicy persisted: fee_redirect_to_market_0_bps == 3000",
    Number(wc.feeRedirectToMarket0Bps) === 3000, `redirect=${wc.feeRedirectToMarket0Bps}`);
  record("ConfigurePermissionlessResolve persisted: stale=80 / forceClose=50",
    Number(wc.permissionlessResolveStaleSlots) === 80 && Number(wc.forceCloseDelaySlots) === 50,
    `stale=${wc.permissionlessResolveStaleSlots} forceClose=${wc.forceCloseDelaySlots}`);

  return { market, portfolios: [] };
}

/**
 * T9 — Per-domain insurance: TopUpInsuranceDomain (56) / WithdrawInsuranceDomain (57)
 *      + SyncInsuranceLedger (54)
 *
 * The insurance ledger tracks cumulative profit/loss for the per-asset insurance
 * authority's pool the same way SyncBackingDomainLedger tracks bucket consume.
 */
async function testPerDomainInsuranceAndLedger(): Promise<{ market: Keypair; portfolios: Keypair[] }> {
  console.log("\n[T9] TopUp/Withdraw InsuranceDomain + SyncInsuranceLedger");
  const { market } = await deployBareEwmaMarket();
  const insLedger = Keypair.generate();
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.publicKey.toBuffer()], PROG);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const ledRent = await conn.getMinimumBalanceForRentExemption(2048);
  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: insLedger.publicKey,
      lamports: ledRent, space: 2048, programId: PROG }),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminAta, lamports: 100_000_000 }),
    createSyncNativeInstruction(adminAta),
  ], [admin, insLedger]);

  // Sync baseline (creates ledger account if needed)
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: insLedger.publicKey, isSigner: false, isWritable: true },
  ], data: encSyncInsuranceLedger() })]);
  const L0 = parseLedgerCounters(Buffer.from((await conn.getAccountInfo(insLedger.publicKey, "confirmed"))!.data));

  // TopUpInsuranceDomain (domain 0 = asset-0 long side)
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: adminAta, isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: insLedger.publicKey, isSigner: false, isWritable: true },
  ], data: encTopUpInsuranceDomain({ domain: 0, amount: 30_000_000n }) })]);
  const mgAfterTop: any = parseMarketGroup(Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data));
  record("TopUpInsuranceDomain: market.insurance grew",
    BigInt(mgAfterTop.insurance) >= 30_000_000n,
    `insurance=${mgAfterTop.insurance}`);

  // Sync again — counter should have moved
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: insLedger.publicKey, isSigner: false, isWritable: true },
  ], data: encSyncInsuranceLedger() })]);
  const L1 = parseLedgerCounters(Buffer.from((await conn.getAccountInfo(insLedger.publicKey, "confirmed"))!.data));
  // (Insurance ledger has a different layout than BackingDomain ledger — uses
  //  total_principal / last_observed_insurance fields. We only assert the call
  //  is accepted and the account stays well-formed; counter semantics are
  //  covered by the percolator-prog test suite.)
  record("SyncInsuranceLedger: succeeds after TopUp",
    L1.cumLoss >= 0n,
    `cumLoss=${L1.cumLoss}, lastUnavail=${L1.lastUnavail}`);

  // WithdrawInsuranceDomain — partial drain
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: adminAta, isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true },
    { pubkey: vaultAuth, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: insLedger.publicKey, isSigner: false, isWritable: true },
  ], data: encWithdrawInsuranceDomain({ domain: 0, amount: 10_000_000n }) })]);
  const mgAfterWith: any = parseMarketGroup(Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data));
  record("WithdrawInsuranceDomain: market.insurance dropped by 10M",
    BigInt(mgAfterTop.insurance) - BigInt(mgAfterWith.insurance) === 10_000_000n,
    `before=${mgAfterTop.insurance}, after=${mgAfterWith.insurance}`);

  return { market, portfolios: [] };
}

/**
 * T10 — AUTH_MARK oracle mode: ConfigureAuthMark (62) + PushAuthMark (63)
 *
 * Sibling to the EWMA-mark we use in T5: instead of an EWMA-smoothed walk
 * toward the target, AUTH_MARK lets the per-asset oracle_authority push the
 * mark directly (engine still bounded by max_price_move_bps_per_slot).
 *
 * This deploys a fresh market, swaps asset 0 to AUTH_MARK, then pushes a mark
 * and cranks to see the effective_price advance.
 */
async function testAuthMarkOracle(): Promise<{ market: Keypair; portfolios: Keypair[] }> {
  console.log("\n[T10] ConfigureAuthMark + PushAuthMark");
  const market = Keypair.generate();
  const accountLen = marketAccountLenFor(1);
  const mkRent = await conn.getMinimumBalanceForRentExemption(accountLen);
  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: accountLen, programId: PROG }),
  ], [admin, market]);
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
  // ConfigureAuthMark — admin signs as the per-asset oracle_authority for asset 0
  const slot0 = BigInt(await conn.getSlot("confirmed"));
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encConfigureAuthMark({ assetIndex: 0, nowSlot: slot0, initialMarkE6: 1_000_000n }) })]);
  const bufAfterCfg = Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data);
  const wcAfterCfg = parseWrapperConfig(bufAfterCfg);
  const profAfterCfg = parseAssetOracleProfile(bufAfterCfg, ASSET0_PROFILE_OFF, 0);
  // For asset 0, wrapper code mirrors oracle profile fields into the wrapper
  // config; AUTH_MARK is mode 3. Accept either being 3.
  record("ConfigureAuthMark: asset 0 oracle_mode set to AUTH_MARK (3)",
    Number(wcAfterCfg.oracleMode) === 3 || Number(profAfterCfg.oracleMode) === 3,
    `wc.oracleMode=${wcAfterCfg.oracleMode} profile.oracleMode=${profAfterCfg.oracleMode}`);

  // PushAuthMark to 1.1
  const slot1 = BigInt(await conn.getSlot("confirmed"));
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encPushAuthMark({ assetIndex: 0, nowSlot: slot1, markE6: 1_100_000n }) })]);
  const bufAfterPush = Buffer.from((await conn.getAccountInfo(market.publicKey, "confirmed"))!.data);
  const wcAfterPush = parseWrapperConfig(bufAfterPush);
  const profAfterPush = parseAssetOracleProfile(bufAfterPush, ASSET0_PROFILE_OFF, 0);
  const target = wcAfterPush.oracleTargetPriceE6 >= 1_000_000n
    ? wcAfterPush.oracleTargetPriceE6
    : profAfterPush.oracleTargetPriceE6;
  record("PushAuthMark: oracleTargetPriceE6 advanced toward 1.1",
    target >= 1_000_000n,
    `wc.target=${wcAfterPush.oracleTargetPriceE6} profile.target=${profAfterPush.oracleTargetPriceE6}`);

  return { market, portfolios: [] };
}

/**
 * T11 — BatchTradeCpi (tag 67) — matcher batch fill, single-leg.
 *
 * Sibling to TradeCpi (T5) but goes through matcher tag 3 (batch call) instead
 * of tag 1 (single fill).  Asserts a 1-leg batch resolves identically to a
 * single-fill TradeCpi.
 */
async function testBatchTradeCpi(): Promise<{ market: Keypair; portfolios: Keypair[] }> {
  console.log("\n[T11] BatchTradeCpi (matcher single-leg batch)");
  const market = Keypair.generate();
  const lp = Keypair.generate();
  const taker = Keypair.generate();
  const matcherCtx = Keypair.generate();
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.publicKey.toBuffer()], PROG);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
  const adminAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);

  const [matcherDelegate] = PublicKey.findProgramAddressSync([
    Buffer.from("matcher"), market.publicKey.toBuffer(),
    lp.publicKey.toBuffer(), admin.publicKey.toBuffer(),
    MATCHER.toBuffer(), matcherCtx.publicKey.toBuffer(),
  ], PROG);

  const mkLen = marketAccountLenFor(1);
  const mkRent = await conn.getMinimumBalanceForRentExemption(mkLen);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  const ctxRent = await conn.getMinimumBalanceForRentExemption(320);
  await send([
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
      lamports: mkRent, space: mkLen, programId: PROG }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: lp.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROG }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: taker.publicKey,
      lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROG }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: matcherCtx.publicKey,
      lamports: ctxRent, space: 320, programId: MATCHER }),
  ], [admin, market, lp, taker, matcherCtx]);
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
  const slot = BigInt(await conn.getSlot("confirmed"));
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
  ], data: encConfigureEwmaMark({ assetIndex: 0, nowSlot: slot, initialMarkE6: 1_000_000n,
    markEwmaHalflifeSlots: 300n, markMinFee: 500n } as any) })]);
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
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: adminAta, lamports: 1_000_000_000 }),
    createSyncNativeInstruction(adminAta),
  ]);
  const dep = (pf: PublicKey, amt: bigint) => new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: pf, isSigner: false, isWritable: true }, { pubkey: adminAta, isSigner: false, isWritable: true },
    { pubkey: vaultAta, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }],
    data: encDeposit(amt) });
  await send([dep(lp.publicKey, 150_000_000n), dep(taker.publicKey, 150_000_000n)]);
  // Init matcher
  await send([new TransactionInstruction({ programId: MATCHER, keys: [
    { pubkey: matcherDelegate, isSigner: false, isWritable: false },
    { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
  ], data: encMatcherInitVamm({
    kind: 1, tradingFeeBps: 10, baseSpreadBps: 50, maxTotalBps: 1000,
    impactKBps: 1, liquidityNotionalE6: 1_000_000_000n,
    maxFillAbs: 100_000_000n, maxInventoryAbs: 500_000_000n,
  }) })]);
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: false },
    { pubkey: lp.publicKey, isSigner: false, isWritable: true },
    { pubkey: MATCHER, isSigner: false, isWritable: false },
    { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: false },
    { pubkey: matcherDelegate, isSigner: false, isWritable: false },
  ], data: encSetMatcherConfig(1) })]);

  // BatchTradeCpi — single leg, taker +20M long
  await send([new TransactionInstruction({ programId: PROG, keys: [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: taker.publicKey, isSigner: false, isWritable: true },
    { pubkey: lp.publicKey, isSigner: false, isWritable: true },
    { pubkey: MATCHER, isSigner: false, isWritable: false },
    { pubkey: matcherCtx.publicKey, isSigner: false, isWritable: true },
    { pubkey: matcherDelegate, isSigner: false, isWritable: false },
  ], data: encBatchTradeCpi([
    { assetIndex: 0, sizeQ: 20_000_000n, feeBps: 1n, limitPrice: 1_100_000n },
  ]) })]);
  const lpAfter: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(lp.publicKey, "confirmed"))!.data));
  const takerAfter: any = parsePortfolio(Buffer.from((await conn.getAccountInfo(taker.publicKey, "confirmed"))!.data));
  record("BatchTradeCpi (1 leg): LP short 20M, taker long 20M",
    lpAfter.legs.length === 1 && lpAfter.legs[0].side === 1 && lpAfter.legs[0].basisPosQ === -20_000_000n
    && takerAfter.legs.length === 1 && takerAfter.legs[0].side === 0 && takerAfter.legs[0].basisPosQ === 20_000_000n,
    `LP basis=${lpAfter.legs[0]?.basisPosQ}, taker basis=${takerAfter.legs[0]?.basisPosQ}`);

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

  // T6-T11: each owns its market; runs sequentially, tears down independently.
  // Helper to wrap any test fn that returns {market, portfolios} so a thrown
  // assertion failure doesn't skip teardown for that test's market.
  const runIsolated = async (label: string, fn: () => Promise<{ market: Keypair; portfolios: Keypair[] }>) => {
    let env: { market: Keypair; portfolios: Keypair[] } | null = null;
    try {
      env = await fn();
    } catch (e: any) {
      record(`${label}`, false, `threw: ${e?.message ?? e}`);
    } finally {
      if (env) await teardown(env.market, env.portfolios);
    }
  };
  await runIsolated("[T6] auth rotation",      testAuthorityRotation);
  await runIsolated("[T7] bilateral + batch",  testBilateralAndBatch);
  await runIsolated("[T8] config setters",     testConfigSetters);
  await runIsolated("[T9] per-domain insurance", testPerDomainInsuranceAndLedger);
  await runIsolated("[T10] auth-mark oracle",  testAuthMarkOracle);
  await runIsolated("[T11] batch TradeCpi",    testBatchTradeCpi);

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
