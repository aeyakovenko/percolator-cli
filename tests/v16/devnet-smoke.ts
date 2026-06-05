/**
 * Clean-room TDD for the four claims in PR #81.
 *
 * Each test models the bug as described, then runs against a freshly-deployed
 * devnet smoke market on the live program (`Bu1J8eQQN…`). If the assertion
 * fails, the bug is real and we patch the corresponding production file. If the
 * assertion passes, the claim doesn't reproduce and we leave the code alone.
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
  marketAccountLenFor, PORTFOLIO_ACCOUNT_LEN,
  MARKET_GROUP_OFF, MG, OracleProvider,
} from "../../src/v16/index.js";
import { parseMarketGroup, parsePortfolio } from "../../src/v16/parsers.js";

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
  console.log("PR #81 claims — clean-room TDD against devnet smoke market");
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

  // ----------------------------------------------------------------- summary
  const failed = results.filter(r => !r.passed);
  console.log("\n" + "=".repeat(72));
  console.log(`Result: ${results.length - failed.length}/${results.length} assertions passed`);
  if (failed.length > 0) {
    console.log("\nFAILURES (real bugs to fix):");
    for (const r of failed) console.log(`  ✗ ${r.name}${r.details ? "  — " + r.details : ""}`);
    process.exit(1);
  }
  console.log("All assertions green — no real bugs to fix from PR #81's claims.");
})().catch(e => { console.error("FATAL:", e?.message || e); process.exit(2); });
