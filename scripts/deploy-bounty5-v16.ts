/**
 * v16 BOUNTY-5 market-group deployer + validator.
 *
 * Deploys a 3-asset v16 percolator market group (wSOL collateral, unit_scale=0,
 * every asset INVERTED so SOL is the base unit) at 20× leverage, seeds per-domain
 * insurance, sets the permissionless market-init + maintenance fee policies, then
 * runs a self-contained open→refresh→close TradeNoCpi validation against two
 * throwaway portfolios before tearing only the portfolios down.
 *
 *   m0 = USD/SOL    — 1-leg Pyth SOL/USD, inverted
 *   m1 = STOXX/SOL  — 3-leg composite STOXX50·EUR × EUR/USD ÷ SOL/USD, inverted
 *   m2 = BTC/SOL    — 1-leg BTC/USD (Pyth on devnet, Switchboard on mainnet), inverted
 *
 * The market group PERSISTS at the end (it's the live bounty market). Only the
 * two test portfolios are closed + withdrawn. A manifest JSON is written.
 *
 * Usage:
 *   NETWORK=devnet  tsx scripts/deploy-bounty5-v16.ts            (default)
 *   NETWORK=devnet  tsx scripts/deploy-bounty5-v16.ts --dry      (plan only)
 *   NETWORK=mainnet V16_PROGRAM_ID=<id> M0_ORACLE=<pyth> M2_ORACLE=<sb> \
 *                   tsx scripts/deploy-bounty5-v16.ts
 *
 * Env overrides:
 *   SOLANA_RPC_URL        — devnet RPC (else reads ~/percolator-cli/.env or Helius default)
 *   V16_PROGRAM_ID        — required on mainnet
 *   M0_ORACLE             — Pyth SOL/USD PriceUpdateV2 account (mainnet: required; devnet: defaults)
 *   M1_ORACLE_STOXX       — Pyth STOXX50·EUR account (else scans/uses devnet default)
 *   M1_ORACLE_EUR         — Pyth EUR/USD account
 *   M1_ORACLE_SOL         — Pyth SOL/USD account (defaults to M0_ORACLE)
 *   M2_ORACLE             — BTC/USD feed account (Pyth on devnet, Switchboard on mainnet)
 *   SMOKE_CHAINLINK_FEED  — Chainlink BTC/USD substitute for m2 on devnet (last resort)
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import bs58 from "bs58";
import {
  encInitMarket, encConfigureHybridOracle, encConfigurePermissionlessResolve,
  encUpdateMarketInitFeePolicy, encUpdateFeeRedirectPolicy, encTopUpInsuranceDomain,
  encInitPortfolio, encDeposit, encWithdraw, encTradeNoCpi,
  encPermissionlessCrank, encClosePortfolio,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN,
  PORTFOLIO_STATE_OFF, PA,
  ORACLE_LEG_FLAG_DIVIDE_LEG2, ORACLE_LEG_FLAG_DIVIDE_LEG3, OracleProvider,
} from "../src/v16/index.js";

// ============================================================================
// Config / environment
// ============================================================================
const NETWORK = (process.env.NETWORK ?? "devnet").toLowerCase();
const DRY = process.argv.includes("--dry");
const HOME = process.env.HOME!;

function devnetRpc(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  // ~/percolator-cli/.env is `SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=<key>`
  try {
    const line = fs.readFileSync(`${HOME}/percolator-cli/.env`, "utf8").trim();
    const idx = line.indexOf("=");
    if (idx > 0) return line.slice(idx + 1).trim();
  } catch { /* fall through */ }
  return "https://api.devnet.solana.com";
}
function mainnetRpc(): string {
  const key = fs.readFileSync(`${HOME}/.helius`, "utf8").trim();
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

const RPC = NETWORK === "mainnet" ? mainnetRpc() : devnetRpc();
const PROGRAM_ID = NETWORK === "mainnet"
  ? new PublicKey((() => {
      const id = process.env.V16_PROGRAM_ID;
      if (!id) throw new Error("V16_PROGRAM_ID env is required on mainnet");
      return id;
    })())
  : new PublicKey(process.env.V16_PROGRAM_ID ?? "Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");

const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));

// Pyth feed IDs (32-byte hex, no 0x prefix).
const FEED_SOL_USD   = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const FEED_STOXX_EUR = "dd08f0a40e21ce42178b25bdd9461a2beebccbaa2a781a6e02b323576c4072ab";
const FEED_EUR_USD   = "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b";
const FEED_BTC_USD   = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

// Devnet Pyth SOL/USD PriceUpdateV2 (live, pushed on demand).
const DEVNET_PYTH_SOL = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";

// NOTE: the spec called the divide-by-SOL/USD flag "0x04", but the authoritative
// constant is ORACLE_LEG_FLAG_DIVIDE_LEG3 = 1<<1 = 0x02 (verified against
// percolator-prog/src/v16_program.rs). We use the named constant, which divides
// the composite by leg3 (SOL/USD) — turning STOXX·EUR×(EUR/USD)/(SOL/USD) into
// STOXX(USD)/SOL.

// InitMarket params (20× leverage, max risk) — shared with the smokes.
const INIT_MARKET = {
  maxPortfolioAssets: 3,                // exactly the 3 launch markets; permissionless
                                        // creation grows capacity beyond this later.
                                        // (Must equal the number of configured assets —
                                        // an auto-active-but-unconfigured tail slot locks trades.)
  hMin: 0n, hMax: 6_480_000n, initialPrice: 1_000_000n,
  minNonzeroMmReq: 500n, minNonzeroImReq: 600n,
  maintenanceMarginBps: 500n, initialMarginBps: 500n,
  maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n,
  liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n,
  minLiquidationAbs: 0n,
  maxPriceMoveBpsPerSlot: 24n, maxAccrualDtSlots: 20n,
  maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n,
  maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n,
  maxBankruptCloseLifetimeSlots: 10_000_000n,
  publicBChunkAtoms: 1_000_000n,
};

const ORACLE_DEFAULTS = {
  maxStalenessSecs: 600n, hybridSoftStaleSlots: 1800n,
  markEwmaHalflifeSlots: 300n, markMinFee: 500n,
  unitScale: 0, confFilterBps: 200,
};

const SLOTS_PER_DAY = 216_000n;            // ~0.4 s/slot
const FORCE_CLOSE_DELAY = 216_000n;        // ~24h auto-wind-down
const PERM_RESOLVE_STALE = 6_480_000n;      // ~30d grace (MAX) — at 100 the market hard-freezes
                                            // (0x1b OracleStale) after just ~40s un-cranked. The
                                            // keeper keeps it fresh; this is the keeper-downtime cushion.
const INSURANCE_PER_MARKET = 500_000_000n; // 0.5 SOL per domain (1.5 SOL total)
const FEE_REDIRECT_TO_M0_BPS = 2000;       // 20% of non-zero-market trade fees + backing yield → market 0
const TRADE_SIZE = 1_000_000n;   // = POS_SCALE (1 unit), matching the litesvm reference test
const VALIDATE_DEPOSIT = 300_000_000n;

// ============================================================================
// Helpers
// ============================================================================
function deriveVaultAuthority(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID);
}
const withCu = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];

let passed = 0, failed = 0;
const failures: string[] = [];

async function extractCode(e: any): Promise<string | null> {
  let logs = ((e.transactionLogs ?? e.logs) ?? []).join("\n");
  if (!logs && e.message) {
    const m = (e.message as string).match(/Transaction (\w{32,})/);
    if (m) {
      const tx = await conn.getTransaction(m[1], { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      logs = (tx?.meta?.logMessages ?? []).join(" | ");
    }
  }
  return logs.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? null;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn();
    console.log(`  ✅  ${name}`);
    passed++;
    return r;
  } catch (e: any) {
    const code = await extractCode(e);
    const msg = code ? code : (e.message || "").slice(0, 140);
    console.log(`  ❌  ${name}: ${msg}`);
    failed++;
    failures.push(`${name} → ${msg}`);
    return null;
  }
}

// Read a Pyth PriceUpdateV2 account and return the price scaled to e6 (×1e6),
// matching read_pyth_price_e6 in v16_program.rs. The PriceFeedMessage is
// Borsh-packed starting at OFF_PRICE_FEED_MESSAGE=41:
//   feed_id [u8;32] @41 | price i64 @73 | conf u64 @81 | exponent i32 @89 | publish_time i64 @93
function parsePythPriceE6(data: Buffer): bigint {
  if (data.length < 134) throw new Error(`pyth account too small: ${data.length}`);
  const price = data.readBigInt64LE(73);
  const exponent = data.readInt32LE(89);
  if (price <= 0n) throw new Error("pyth price <= 0");
  const scale = exponent + 6;
  if (scale >= 0) return price * (10n ** BigInt(scale));
  return price / (10n ** BigInt(-scale));
}

// Live USD/SOL price (e6). On both networks we read the Pyth SOL/USD feed
// account; SOL_USD_PRICE_E6 env can force a value (useful for --dry offline).
async function readSolUsdE6(solOracle: PublicKey): Promise<bigint> {
  if (process.env.SOL_USD_PRICE_E6) return BigInt(process.env.SOL_USD_PRICE_E6);
  const info = await conn.getAccountInfo(solOracle, "confirmed");
  if (!info) throw new Error(`SOL/USD oracle ${solOracle.toBase58()} not found`);
  return parsePythPriceE6(Buffer.from(info.data));
}

// ============================================================================
// Oracle account resolution
// ============================================================================
interface OracleConfig {
  label: string;
  assetIndex: number;
  oracleLegCount: number;
  oracleLegFlags: number;
  invert: number;
  legFeeds: [string, string, string];   // 32-byte hex each
  accounts: PublicKey[];                 // tail accounts for ConfigureHybridOracle / crank
}

async function resolveOracles(): Promise<{ m0: OracleConfig; m1: OracleConfig; m2: OracleConfig; solOracle: PublicKey }> {
  const zero = Buffer.alloc(32).toString("hex");

  // ---- m0: USD/SOL — Pyth SOL/USD, inverted ----
  const m0Oracle = new PublicKey(
    NETWORK === "mainnet"
      ? (process.env.M0_ORACLE ?? (() => { throw new Error("M0_ORACLE env required on mainnet"); })())
      : (process.env.M0_ORACLE ?? DEVNET_PYTH_SOL),
  );
  const m0: OracleConfig = {
    label: "USD/SOL", assetIndex: 0, oracleLegCount: 1, oracleLegFlags: 0, invert: 1,
    legFeeds: [FEED_SOL_USD, zero, zero],
    accounts: [m0Oracle],
  };

  // ---- m1: STOXX/SOL — 3-leg composite, divide by leg3 (SOL/USD), inverted ----
  const stoxxAcct = new PublicKey(process.env.M1_ORACLE_STOXX ?? m0Oracle.toBase58() /* placeholder if unset */);
  const eurAcct   = new PublicKey(process.env.M1_ORACLE_EUR   ?? m0Oracle.toBase58());
  const solAcct   = new PublicKey(process.env.M1_ORACLE_SOL   ?? m0Oracle.toBase58());
  if (!process.env.M1_ORACLE_STOXX || !process.env.M1_ORACLE_EUR) {
    console.log("  ⚠️  m1 (STOXX) leg accounts not fully set via M1_ORACLE_STOXX / M1_ORACLE_EUR;");
    console.log("      ConfigureHybridOracle will store the feed ids, but a crank refresh");
    console.log("      needs the three real PriceUpdateV2 accounts in the tail.");
  }
  const m1: OracleConfig = {
    label: "STOXX/SOL", assetIndex: 1, oracleLegCount: 3,
    oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG3, invert: 1,
    legFeeds: [FEED_STOXX_EUR, FEED_EUR_USD, FEED_SOL_USD],
    accounts: [stoxxAcct, eurAcct, solAcct],
  };

  // ---- m2: BTC/SOL — 2-leg Pyth BTC/USD ÷ SOL/USD so BTC is priced in SOL, inverted ----
  // (user chose Pyth over Switchboard: same config on devnet + mainnet, fully validated.)
  // A single inverted BTC/USD would be USD/BTC and ignore SOL entirely — wrong for a
  // SOL-collateralised market, so we divide by SOL/USD (DIVIDE_LEG2).
  const btcAcct = new PublicKey(
    NETWORK === "mainnet"
      ? (process.env.M2_ORACLE ?? (() => { throw new Error("M2_ORACLE (Pyth BTC/USD PriceUpdateV2) env required on mainnet"); })())
      : (process.env.M2_ORACLE ?? "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"),
  );
  const m2: OracleConfig = {
    label: "BTC/SOL (Pyth÷Pyth)", assetIndex: 2, oracleLegCount: 2,
    oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG2, invert: 1,
    legFeeds: [FEED_BTC_USD, FEED_SOL_USD, zero],
    accounts: [btcAcct, m0Oracle],
  };

  return { m0, m1, m2, solOracle: m0Oracle };
}

// devnet Pyth feed discovery (used as a BTC fallback for m2).
async function scanPythFeed(): Promise<{ addr: PublicKey; feedId: Buffer } | null> {
  const disc = Buffer.from([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]);
  try {
    const accs = await conn.getProgramAccounts(new PublicKey(OracleProvider.PYTH_RECEIVER), {
      commitment: "confirmed",
      filters: [{ dataSize: 134 }, { memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
    });
    if (accs.length === 0) return null;
    const a = accs[0]!;
    return { addr: a.pubkey, feedId: Buffer.from(a.account.data).subarray(41, 73) };
  } catch { return null; }
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log("v16 bounty-5 deployer + validator");
  console.log("  network :", NETWORK);
  console.log("  program :", PROGRAM_ID.toBase58());
  console.log("  admin   :", admin.publicKey.toBase58());
  console.log("  rpc     :", RPC.split("?")[0]);
  console.log("  mode    :", DRY ? "DRY RUN (no transactions)" : "LIVE");

  const oracles = await resolveOracles();

  // ---- live SOL price → fee computation ----
  let solUsdE6: bigint;
  try {
    solUsdE6 = await readSolUsdE6(oracles.solOracle);
  } catch (e: any) {
    console.log(`  ⚠️  could not read live SOL/USD (${e.message}); set SOL_USD_PRICE_E6 to override`);
    throw e;
  }
  const solUsd = Number(solUsdE6) / 1e6;
  // $0.50/day hold cost → lamports/day → per-slot fee.
  const lamportsPerDay = Math.round((0.50 / solUsd) * 1e9);
  const maintenanceFeePerSlot = BigInt(Math.round(lamportsPerDay / Number(SLOTS_PER_DAY)));
  // ~$0.50 permissionless market-create fee, in lamports.
  const minInitFee = BigInt(Math.round((0.50 / solUsd) * 1e9));

  console.log("\n=== plan ===");
  console.log(`  SOL/USD (live)            : $${solUsd.toFixed(4)}  (${solUsdE6} e6)`);
  console.log(`  leverage                  : 20× (maintenanceMarginBps=${INIT_MARKET.maintenanceMarginBps})`);
  console.log(`  maxPortfolioAssets        : ${INIT_MARKET.maxPortfolioAssets}`);
  console.log(`  maintenanceFeePerSlot     : ${maintenanceFeePerSlot} lamports  (~$0.50/day)`);
  console.log(`  market-init fee (minInit) : ${minInitFee} lamports  (~$0.50)`);
  console.log(`  insurance / domain        : ${INSURANCE_PER_MARKET} lamports (0.5 SOL) × 3 = 1.5 SOL`);
  console.log(`  forceCloseDelaySlots      : ${FORCE_CLOSE_DELAY}  (~24h)`);
  console.log(`  permResolveStaleSlots     : ${PERM_RESOLVE_STALE}`);
  for (const m of [oracles.m0, oracles.m1, oracles.m2]) {
    console.log(`  m${m.assetIndex} ${m.label.padEnd(20)} legs=${m.oracleLegCount} flags=0x${m.oracleLegFlags.toString(16)} invert=${m.invert}`);
    m.accounts.forEach((a, i) => console.log(`        leg${i} acct: ${a.toBase58()}  feed=${m.legFeeds[i].slice(0, 16)}…`));
  }

  if (DRY) {
    console.log("\n[--dry] plan printed; no transactions sent. Exiting.");
    return;
  }

  // Domains for per-asset insurance: assetIndex*2 → 0, 2, 4.
  const markets = [oracles.m0, oracles.m1, oracles.m2];

  const market = Keypair.generate();
  const portA = Keypair.generate();
  const portB = Keypair.generate();
  const [vaultAuth] = deriveVaultAuthority(market.publicKey);
  const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);

  console.log("\n=== Stage 1: create market + 2 portfolios + InitMarket ===");
  const mkRent = await conn.getMinimumBalanceForRentExemption(MARKET_ACCOUNT_LEN);
  const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
  console.log(`  market: ${market.publicKey.toBase58()}`);
  console.log(`  rent: market=${(mkRent / 1e9).toFixed(3)} SOL  portfolio=${(pfRent / 1e9).toFixed(3)} SOL`);

  await step("create market + portfolios", () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu())
      .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: market.publicKey,
        lamports: mkRent, space: MARKET_ACCOUNT_LEN, programId: PROGRAM_ID }))
      .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portA.publicKey,
        lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID }))
      .add(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: portB.publicKey,
        lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID })),
      [admin, market, portA, portB], { commitment: "confirmed" }));

  await step(`InitMarket (max_portfolio_assets=${INIT_MARKET.maxPortfolioAssets})`, () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu())
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
        ],
        data: encInitMarket({ ...INIT_MARKET, maintenanceFeePerSlot }),
      })),
      [admin], { commitment: "confirmed" }));

  console.log("\n=== Stage 2: ConfigureHybridOracle per asset ===");
  for (const m of markets) {
    await step(`ConfigureHybridOracle m${m.assetIndex} (${m.label})`, async () => {
      const slot = BigInt(await conn.getSlot("confirmed"));
      return sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu())
        .add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            ...m.accounts.map((a) => ({ pubkey: a, isSigner: false, isWritable: false })),
          ],
          data: encConfigureHybridOracle({
            assetIndex: m.assetIndex,
            nowSlot: slot, nowUnixTs: BigInt(Math.floor(Date.now() / 1000)),
            oracleLegCount: m.oracleLegCount, oracleLegFlags: m.oracleLegFlags,
            maxStalenessSecs: ORACLE_DEFAULTS.maxStalenessSecs,
            hybridSoftStaleSlots: ORACLE_DEFAULTS.hybridSoftStaleSlots,
            markEwmaHalflifeSlots: ORACLE_DEFAULTS.markEwmaHalflifeSlots,
            markMinFee: ORACLE_DEFAULTS.markMinFee,
            invert: m.invert, unitScale: ORACLE_DEFAULTS.unitScale,
            confFilterBps: ORACLE_DEFAULTS.confFilterBps,
            oracleLegFeeds: m.legFeeds,
          }),
        })),
        [admin], { commitment: "confirmed", skipPreflight: true });
    });
  }

  console.log("\n=== Stage 3: fee + resolve policies ===");
  await step(`UpdateMarketInitFeePolicy(${minInitFee})`, () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu())
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ],
        data: encUpdateMarketInitFeePolicy(minInitFee),
      })),
      [admin], { commitment: "confirmed" }));

  await step(`UpdateFeeRedirectPolicy(${FEE_REDIRECT_TO_M0_BPS} bps → market 0)`, () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu())
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ],
        data: encUpdateFeeRedirectPolicy(FEE_REDIRECT_TO_M0_BPS),
      })),
      [admin], { commitment: "confirmed" }));

  await step(`ConfigurePermissionlessResolve(stale=${PERM_RESOLVE_STALE}, delay=${FORCE_CLOSE_DELAY})`, () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu())
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market.publicKey, isSigner: false, isWritable: true },
        ],
        data: encConfigurePermissionlessResolve({ staleSlots: PERM_RESOLVE_STALE, forceCloseDelaySlots: FORCE_CLOSE_DELAY }),
      })),
      [admin], { commitment: "confirmed" }));

  console.log("\n=== Stage 4: wrap SOL + seed per-domain insurance (1.5 SOL) ===");
  await getOrCreateAssociatedTokenAccount(conn, admin, NATIVE_MINT, admin.publicKey);
  // Wrap enough for insurance (1.5 SOL) + validation deposits (0.6 SOL) + slack.
  const wrapTotal = INSURANCE_PER_MARKET * BigInt(markets.length) + VALIDATE_DEPOSIT * 2n + 50_000_000n;
  await step(`create vault ATA + wrap ${(Number(wrapTotal) / 1e9).toFixed(2)} SOL`, () =>
    sendAndConfirmTransaction(conn, new Transaction()
      .add(...withCu())
      .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, vaultAta, vaultAuth, NATIVE_MINT))
      .add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sourceAta, lamports: Number(wrapTotal) }))
      .add({ keys: [{ pubkey: sourceAta, isSigner: false, isWritable: true }],
             programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) }),
      [admin], { commitment: "confirmed" }));

  for (const m of markets) {
    const domain = m.assetIndex * 2;       // 0, 2, 4
    await step(`TopUpInsuranceDomain(domain=${domain}, 0.5 SOL) [m${m.assetIndex}]`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu())
        .add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: encTopUpInsuranceDomain({ domain, amount: INSURANCE_PER_MARKET }),
        })),
        [admin], { commitment: "confirmed" }));
  }

  console.log("\n=== Stage 5: init + deposit validation portfolios ===");
  for (const [n, p] of [["A", portA], ["B", portB]] as const) {
    await step(`InitPortfolio ${n}`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu())
        .add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
          ],
          data: encInitPortfolio(),
        })),
        [admin], { commitment: "confirmed" }));
    await step(`Deposit ${VALIDATE_DEPOSIT} → ${n}`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu())
        .add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: encDeposit(VALIDATE_DEPOSIT),
        })),
        [admin], { commitment: "confirmed" }));
  }

  console.log("\n=== Stage 6: per-asset trade validation (SEPARATE crank tx → trade tx) ===");
  // The litesvm reference test (v16_bpf_hybrid_fresh_oracle_trade_opens_and_closes)
  // proves the working sequence is TWO transactions: PermissionlessCrank refreshes the
  // mark to the live oracle, then a SEPARATE TradeNoCpi executes at exec_price = the
  // post-crank engine mark. (Atomic crank+trade in one tx fails 0x15.) We re-crank
  // before close so each trade stays within max_accrual_dt of its refresh.
  const tradeKeys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },   // signer A
    { pubkey: admin.publicKey, isSigner: true, isWritable: false },   // signer B
    { pubkey: market.publicKey, isSigner: false, isWritable: true },
    { pubkey: portA.publicKey, isSigner: false, isWritable: true },
    { pubkey: portB.publicKey, isSigner: false, isWritable: true },
  ];
  const validation: Record<string, string> = {};

  for (const m of markets) {
    console.log(`\n--- m${m.assetIndex} (${m.label}) ---`);
    // Crank repeatedly to CATCH UP a stale asset: each accrual step advances at
    // most max_accrual_dt slots, so after a long config→trade gap (≫ max_accrual_dt)
    // a single crank leaves the asset stale and the first trade fails 0x15. Crank a
    // few times (each ≤ max_accrual_dt) until slot_last reaches the current slot.
    // Crank several times to catch up a stale asset (each accrual step advances
    // ≤ max_accrual_dt slots). 8 steps ≈ 160 slots of catch-up, ample for the deploy gap.
    const crankRefresh = async (times = 8) => {
      for (let i = 0; i < times; i++) {
        const slot = BigInt(await conn.getSlot("confirmed"));
        await sendAndConfirmTransaction(conn, new Transaction().add(...withCu())
          .add(new TransactionInstruction({
            programId: PROGRAM_ID,
            keys: [
              { pubkey: admin.publicKey, isSigner: true, isWritable: false },
              { pubkey: market.publicKey, isSigner: false, isWritable: true },
              { pubkey: portA.publicKey, isSigner: false, isWritable: true },
              ...m.accounts.map((a) => ({ pubkey: a, isSigner: false, isWritable: false })),
            ],
            data: encPermissionlessCrank({
              action: 0, assetIndex: m.assetIndex, nowSlot: slot,
              fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0,
            }),
          })), [admin], { commitment: "confirmed", skipPreflight: true });
      }
      return readMarkE6(market.publicKey, m.assetIndex);   // post-crank engine mark
    };
    const tradeAt = (size: bigint, price: bigint) =>
      sendAndConfirmTransaction(conn, new Transaction().add(...withCu())
        .add(new TransactionInstruction({
          programId: PROGRAM_ID, keys: tradeKeys,
          data: encTradeNoCpi({ assetIndex: m.assetIndex, sizeQ: size, execPrice: price, feeBps: 0n }),
        })), [admin], { commitment: "confirmed", skipPreflight: true });

    let ok = true;
    const opened = await step(`crank → OPEN m${m.assetIndex} +${TRADE_SIZE}`, async () => {
      const mark = await crankRefresh();
      console.log(`      open @ fresh mark = ${mark}`);
      return tradeAt(TRADE_SIZE, mark);
    });
    if (!opened) ok = false;

    const closed = await step(`crank → CLOSE m${m.assetIndex} -${TRADE_SIZE}`, async () => {
      const mark = await crankRefresh();
      console.log(`      close @ fresh mark = ${mark}`);
      return tradeAt(-TRADE_SIZE, mark);
    });
    if (!closed) ok = false;

    validation[`m${m.assetIndex}`] = ok ? "PASS" : "FAIL";
    console.log(`  >>> m${m.assetIndex} (${m.label}): ${ok ? "✅ PASS" : "❌ FAIL"}`);
  }

  console.log("\n=== Stage 7: tear down test portfolios (withdraw + close) ===");
  // ClosePortfolio accrues, and on the internal-funding build (f01b77f+) a stale
  // market locks the close with 0x15 EngineLockActive — same catch-up rule as trades.
  // Crank every asset up to the current slot first (Stage 6 does this per-trade).
  for (const m of markets) {
    for (let i = 0; i < 8; i++) {
      const slot = BigInt(await conn.getSlot("confirmed"));
      await sendAndConfirmTransaction(conn, new Transaction().add(...withCu())
        .add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: portA.publicKey, isSigner: false, isWritable: true },
            ...m.accounts.map((a) => ({ pubkey: a, isSigner: false, isWritable: false })),
          ],
          data: encPermissionlessCrank({ action: 0, assetIndex: m.assetIndex, nowSlot: slot, fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }),
        })), [admin], { commitment: "confirmed", skipPreflight: true });
    }
  }
  for (const [n, p] of [["A", portA], ["B", portB]] as const) {
    await step(`Withdraw all from ${n}`, async () => {
      const cap = await readCapital(p.publicKey);
      if (cap === 0n) return null;
      return sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu())
        .add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: vaultAuth, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: encWithdraw(cap),
        })),
        [admin], { commitment: "confirmed" });
    });
    await step(`ClosePortfolio ${n}`, () =>
      sendAndConfirmTransaction(conn, new Transaction()
        .add(...withCu())
        .add(new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: market.publicKey, isSigner: false, isWritable: true },
            { pubkey: p.publicKey, isSigner: false, isWritable: true },
          ],
          data: encClosePortfolio(),
        })),
        [admin], { commitment: "confirmed" }));
  }

  // ---- manifest ----
  const usd = (lamports: bigint | number) => (Number(lamports) / 1e9 * solUsd);
  const manifest = {
    network: NETWORK,
    programId: PROGRAM_ID.toBase58(),
    market: market.publicKey.toBase58(),
    vault: vaultAta.toBase58(),
    vaultPda: vaultAuth.toBase58(),
    admin: admin.publicKey.toBase58(),
    collateralMint: NATIVE_MINT.toBase58(),
    unitScale: 0,
    inverted: true,
    leverage: 20,
    maintenanceMarginBps: Number(INIT_MARKET.maintenanceMarginBps),
    forceCloseDelaySlots: Number(FORCE_CLOSE_DELAY),
    permissionlessResolveStaleSlots: Number(PERM_RESOLVE_STALE),
    solUsdPriceE6: solUsdE6.toString(),
    fees: {
      newAccount: { note: "see InitMarket; no per-account fee configured for bounty-5" },
      maintenancePerSlot: { lamports: maintenanceFeePerSlot.toString(), usdPerDay: usd(maintenanceFeePerSlot * SLOTS_PER_DAY).toFixed(4) },
      marketInit: { lamports: minInitFee.toString(), usd: usd(minInitFee).toFixed(4) },
      feeRedirectToMarket0Bps: FEE_REDIRECT_TO_M0_BPS,
    },
    insurancePerDomain: markets.map((m) => ({
      market: `m${m.assetIndex}`, domain: m.assetIndex * 2,
      lamports: INSURANCE_PER_MARKET.toString(), sol: Number(INSURANCE_PER_MARKET) / 1e9,
    })),
    markets: markets.map((m) => ({
      asset: `m${m.assetIndex}`,
      label: m.label,
      assetIndex: m.assetIndex,
      invert: m.invert,
      oracleLegCount: m.oracleLegCount,
      oracleLegFlags: `0x${m.oracleLegFlags.toString(16)}`,
      legFeedIds: m.legFeeds.slice(0, m.oracleLegCount),
      oracleAccounts: m.accounts.map((a) => a.toBase58()),
      validation: validation[`m${m.assetIndex}`] ?? "UNKNOWN",
    })),
  };

  const manifestPath = NETWORK === "mainnet"
    ? `${HOME}/percolator-cli/mainnet-bounty5-v16-market.json`
    : `${HOME}/percolator-cli/bounty5-v16-devnet.json`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // CLI #72/#77 post-write guard: the just-written manifest MUST agree with the
  // single source of truth on every safety-critical immutable, else fail loudly so
  // a stale value (e.g. the legacy 100-slot perm-resolve cap) can never ship.
  {
    const { BOUNTY5_PARAMS, MANIFEST_SAFETY_FIELDS } = await import("./bounty5-params.js");
    const written = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const drift = MANIFEST_SAFETY_FIELDS
      .filter((f) => Number(written[f]) !== Number((BOUNTY5_PARAMS as any)[f]))
      .map((f) => `${f}=${written[f]} (expected ${(BOUNTY5_PARAMS as any)[f]})`);
    if (drift.length) throw new Error(`manifest safety-field drift — refusing to ship: ${drift.join(", ")}`);
    console.log("  ✅  manifest matches bounty5-params (perm-resolve / force-close / mm / leverage)");
  }

  console.log("\n=================================");
  console.log(`PASS: ${passed}  FAIL: ${failed}`);
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log("  •", f));
  }
  console.log("\nValidation per market:");
  for (const m of markets) console.log(`  m${m.assetIndex} ${m.label.padEnd(20)} ${validation[`m${m.assetIndex}`] ?? "UNKNOWN"}`);
  console.log("=================================");
  console.log(`market group : ${market.publicKey.toBase58()}  (PERSISTS)`);
  console.log(`manifest     : ${manifestPath}`);
}

// Read the stored mark / oracle target price (e6) for an asset slot.
async function readMarkE6(market: PublicKey, assetIndex: number): Promise<bigint> {
  const { parseAsset } = await import("../src/v16/parsers.js");
  const { MARKET_GROUP_OFF, MG, ASSET_SLOT_LEN, ASSET_ORACLE_WRAPPER_LEN } = await import("../src/v16/constants.js");
  const info = await conn.getAccountInfo(market, "confirmed");
  if (!info) throw new Error("market missing");
  const buf = Buffer.from(info.data);
  // The engine AssetState (with effective_price) lives at slot_off + 512, after
  // the oracle-wrapper storage. effective_price is set at ConfigureHybridOracle
  // time (to the live oracle px) and refreshed by every crank — valid for asset 0
  // too (asset-0 oracle config lives in WrapperConfig, but effective_price is per-asset).
  const engOff = MARKET_GROUP_OFF + MG.asset_slots + assetIndex * ASSET_SLOT_LEN + ASSET_ORACLE_WRAPPER_LEN;
  const a: any = parseAsset(buf, engOff, assetIndex);
  if (a.effectivePrice && a.effectivePrice !== 0n) return a.effectivePrice;
  if (a.rawOracleTargetPrice && a.rawOracleTargetPrice !== 0n) return a.rawOracleTargetPrice;
  return 1_000_000n;
}

async function readCapital(port: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(port, "confirmed");
  if (!info) return 0n;
  const off = PORTFOLIO_STATE_OFF + PA.capital;
  return info.data.readBigUInt64LE(off) | (info.data.readBigUInt64LE(off + 8) << 64n);
}

main().catch((e: any) => {
  console.error("FATAL:", e);
  if (e.logs) console.error("LOGS:", e.logs.join("\n"));
  process.exit(1);
});
