/**
 * v16 BOUNTY-5 KEEPER — one-time setup + cron-line generator.
 *
 * Prepares everything the per-minute keeper tick needs, WITHOUT mutating the
 * crontab (that's a system change the user should approve):
 *
 *   1. Generate the dedicated keeper keypair at ~/.config/solana/bounty5-keeper.json
 *      if missing, print its pubkey, and instruct the user to fund it. The keeper
 *      pays crank + Pyth-push fees; it is NOT funded from admin here.
 *
 *   2. BOOTSTRAP a possibly-stale/frozen market: if the market is OracleStale,
 *      the ADMIN (id.json) re-freshens by re-running ConfigureHybridOracle for
 *      each of the 3 assets (allowed only while NO positions exist). This sets
 *      last_good_oracle_slot = current. The Pyth legs are pushed first so the
 *      re-freshen reads live prices. Args match deploy-bounty5-v16.ts exactly.
 *
 *   3. Create the keeper's own portfolio (InitPortfolio; admin pays rent) and
 *      write its pubkey into the manifest as `keeperPortfolio` so the tick can
 *      crank with it.
 *
 *   4. Print the exact cron line + the `crontab` command, and write the line to
 *      scripts/.bounty5-v16-cron.txt. The crontab is NOT modified.
 *
 * Usage:
 *   NETWORK=mainnet tsx scripts/mainnet-bounty5-v16-cron-install.ts          (default)
 *   NETWORK=devnet  tsx scripts/mainnet-bounty5-v16-cron-install.ts
 *   ... --skip-push   skip the Pyth push (e.g. when feeds are already fresh)
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { spawnSync } from "child_process";
import * as fs from "fs";
import {
  encConfigureHybridOracle, encInitPortfolio,
  PORTFOLIO_ACCOUNT_LEN,
  MARKET_GROUP_OFF, MG, ASSET_SLOT_LEN, ASSET_ORACLE_WRAPPER_LEN,
  ORACLE_LEG_FLAG_DIVIDE_LEG2, ORACLE_LEG_FLAG_DIVIDE_LEG3,
} from "../src/v16/index.js";

// ============================================================================
// Config / environment
// ============================================================================
const HOME = process.env.HOME!;
const NETWORK = (process.env.NETWORK ?? "mainnet").toLowerCase();
const SKIP_PUSH = process.argv.includes("--skip-push");
const PUSHER_DIR = `${HOME}/pyth-pusher`;
const CLI_DIR = `${HOME}/percolator-cli`;
const KEEPER_KEYPAIR_PATH = `${HOME}/.config/solana/bounty5-keeper.json`;

function mainnetRpc(): string {
  const key = fs.readFileSync(`${HOME}/.helius`, "utf8").trim();
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}
function devnetRpc(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  try {
    const line = fs.readFileSync(`${CLI_DIR}/.env`, "utf8").trim();
    const idx = line.indexOf("=");
    if (idx > 0) return line.slice(idx + 1).trim();
  } catch { /* fall through */ }
  return "https://api.devnet.solana.com";
}

const RPC = NETWORK === "mainnet" ? mainnetRpc() : devnetRpc();
const MANIFEST_PATH = NETWORK === "mainnet"
  ? `${CLI_DIR}/mainnet-bounty5-v16-market.json`
  : `${CLI_DIR}/bounty5-v16-devnet.json`;
const M = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

const PROGRAM_ID = new PublicKey(M.programId);
const MARKET = new PublicKey(M.market);
const conn = new Connection(RPC, "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(`${HOME}/.config/solana/id.json`, "utf8"))));

// Pyth feed IDs (same as deployer/tick).
const FEED_SOL_USD   = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const FEED_STOXX_EUR = "dd08f0a40e21ce42178b25bdd9461a2beebccbaa2a781a6e02b323576c4072ab";
const FEED_EUR_USD   = "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b";
const FEED_BTC_USD   = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const PYTH_FEEDS = [FEED_SOL_USD, FEED_STOXX_EUR, FEED_EUR_USD, FEED_BTC_USD];

// Per-asset oracle accounts (mainnet == devnet PDAs).
const SOL = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const STOXX = new PublicKey("C2Cf16vF6LX8GrWJwfZga5z5tjVsax5VWnL2T7Q8CF91");
const EUR = new PublicKey("Fu76ChamBDjE8UuGLV6GP2AcPPSU6gjhkNhAyuoPm7ny");
const BTC = new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");
const ZERO = Buffer.alloc(32).toString("hex");

// ConfigureHybridOracle args per asset — EXACT match with deploy-bounty5-v16.ts.
const ORACLE_DEFAULTS = {
  maxStalenessSecs: 600n, hybridSoftStaleSlots: 1800n,
  markEwmaHalflifeSlots: 300n, markMinFee: 500n,
  unitScale: 0, confFilterBps: 200,
};
const ORACLES = [
  {
    assetIndex: 0, label: "USD/SOL", oracleLegCount: 1, oracleLegFlags: 0, invert: 1,
    legFeeds: [FEED_SOL_USD, ZERO, ZERO] as [string, string, string],
    accounts: [SOL],
  },
  {
    assetIndex: 1, label: "STOXX/SOL", oracleLegCount: 3, oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG3, invert: 1,
    legFeeds: [FEED_STOXX_EUR, FEED_EUR_USD, FEED_SOL_USD] as [string, string, string],
    accounts: [STOXX, EUR, SOL],
  },
  {
    assetIndex: 2, label: "BTC/SOL", oracleLegCount: 2, oracleLegFlags: ORACLE_LEG_FLAG_DIVIDE_LEG2, invert: 1,
    legFeeds: [FEED_BTC_USD, FEED_SOL_USD, ZERO] as [string, string, string],
    accounts: [BTC, SOL],
  },
];

const withCu = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];
const send = (ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...withCu(), ...ixs), signers,
    { commitment: "confirmed", skipPreflight });

function errCode(e: any): string {
  const logs = ((e?.transactionLogs ?? e?.logs) ?? []).join(" ");
  return logs.match(/custom program error: (0x[0-9a-f]+)/i)?.[1]
    ?? (e?.message ? String(e.message).slice(0, 120) : "unknown");
}

let pass = 0, fail = 0;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try { const r = await fn(); console.log(`  ✅  ${name}`); pass++; return r; }
  catch (e: any) { console.log(`  ❌  ${name}: ${errCode(e)}`); fail++; return null; }
}

// ============================================================================
// Helpers
// ============================================================================
function pushPythLegs() {
  if (SKIP_PUSH) { console.log("[push] skipped (--skip-push)"); return; }
  const pusher = NETWORK === "mainnet" ? `${PUSHER_DIR}/push.js` : `${PUSHER_DIR}/push-devnet.js`;
  console.log(`[push] ${NETWORK} legs via ${pusher} (fee-payer admin ${admin.publicKey.toBase58()})`);
  for (const feed of PYTH_FEEDS) {
    const r = spawnSync("node", [pusher, feed, "0", `${HOME}/.config/solana/id.json`], {
      cwd: PUSHER_DIR,
      env: { ...process.env, SOLANA_RPC_URL: RPC },
      encoding: "utf8",
      timeout: 25_000,
    });
    if (r.status === 0) console.log(`  ✅  push ${feed.slice(0, 12)}…`);
    else console.log(`  ❌  push ${feed.slice(0, 12)}…: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-1)[0]}`);
  }
}

// Read the oracle profile's last_good_oracle_slot for an asset and compare to
// the current slot to decide whether the market is stale.
async function assetLastGoodSlot(idx: number): Promise<bigint> {
  const { parseAssetOracleProfile } = await import("../src/v16/parsers.js");
  const info = await conn.getAccountInfo(MARKET, "confirmed");
  if (!info) throw new Error("market account missing");
  const buf = Buffer.from(info.data);
  const slotOff = MARKET_GROUP_OFF + MG.asset_slots + idx * ASSET_SLOT_LEN;
  return (parseAssetOracleProfile(buf, slotOff, idx) as any).lastGoodOracleSlot as bigint;
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log(`bounty5-v16 cron-install  network=${NETWORK}`);
  console.log(`  program=${PROGRAM_ID.toBase58()}  market=${MARKET.toBase58()}`);
  console.log(`  admin=${admin.publicKey.toBase58()}  rpc=${RPC.split("?")[0]}`);

  // ---- 1. keeper keypair ----
  let keeper: Keypair;
  if (fs.existsSync(KEEPER_KEYPAIR_PATH)) {
    keeper = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEEPER_KEYPAIR_PATH, "utf8"))));
    console.log(`\n[keeper] existing key ${keeper.publicKey.toBase58()}`);
  } else {
    keeper = Keypair.generate();
    fs.writeFileSync(KEEPER_KEYPAIR_PATH, JSON.stringify(Array.from(keeper.secretKey)));
    fs.chmodSync(KEEPER_KEYPAIR_PATH, 0o600);
    console.log(`\n[keeper] GENERATED ${KEEPER_KEYPAIR_PATH}`);
    console.log(`         pubkey ${keeper.publicKey.toBase58()}`);
  }
  const keeperBal = await conn.getBalance(keeper.publicKey, "confirmed").catch(() => 0);
  console.log(`         balance ${(keeperBal / 1e9).toFixed(4)} SOL`);
  console.log(`  >>> FUND THE KEEPER: send ~0.5 SOL (covers crank + Pyth-push fees) to`);
  console.log(`      ${keeper.publicKey.toBase58()}`);
  console.log(`      (NOT funded from admin automatically.)`);

  // ---- 2. bootstrap (re-freshen) if stale ----
  console.log(`\n[bootstrap] checking oracle freshness`);
  pushPythLegs();
  const cur = BigInt(await conn.getSlot("confirmed"));
  let stale = false;
  for (const o of ORACLES) {
    try {
      const lg = await assetLastGoodSlot(o.assetIndex);
      const age = lg === 0n ? -1n : cur - lg;
      const isStale = lg === 0n || age > BigInt(M.permissionlessResolveStaleSlots ?? 100);
      console.log(`  m${o.assetIndex} ${o.label.padEnd(10)} last_good=${lg} age=${age} ${isStale ? "STALE" : "fresh"}`);
      if (isStale) stale = true;
    } catch (e: any) {
      console.log(`  m${o.assetIndex} read error: ${errCode(e)} → assuming stale`);
      stale = true;
    }
  }

  if (stale) {
    console.log(`\n[bootstrap] market is stale → admin re-freshens via ConfigureHybridOracle (no positions allowed)`);
    for (const o of ORACLES) {
      await step(`ConfigureHybridOracle m${o.assetIndex} (${o.label})`, async () => {
        const slot = BigInt(await conn.getSlot("confirmed"));
        return send([new TransactionInstruction({
          programId: PROGRAM_ID,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: MARKET, isSigner: false, isWritable: true },
            ...o.accounts.map((a) => ({ pubkey: a, isSigner: false, isWritable: false })),
          ],
          data: encConfigureHybridOracle({
            assetIndex: o.assetIndex,
            nowSlot: slot, nowUnixTs: BigInt(Math.floor(Date.now() / 1000)),
            oracleLegCount: o.oracleLegCount, oracleLegFlags: o.oracleLegFlags,
            maxStalenessSecs: ORACLE_DEFAULTS.maxStalenessSecs,
            hybridSoftStaleSlots: ORACLE_DEFAULTS.hybridSoftStaleSlots,
            markEwmaHalflifeSlots: ORACLE_DEFAULTS.markEwmaHalflifeSlots,
            markMinFee: ORACLE_DEFAULTS.markMinFee,
            invert: o.invert, unitScale: ORACLE_DEFAULTS.unitScale,
            confFilterBps: ORACLE_DEFAULTS.confFilterBps,
            oracleLegFeeds: o.legFeeds,
          }),
        })], [admin], true);
      });
    }
  } else {
    console.log(`\n[bootstrap] market fresh → no re-freshen needed`);
  }

  // ---- 3. keeper portfolio ----
  console.log(`\n[portfolio] keeper portfolio`);
  let keeperPortfolio: PublicKey;
  if (M.keeperPortfolio) {
    keeperPortfolio = new PublicKey(M.keeperPortfolio);
    const exists = await conn.getAccountInfo(keeperPortfolio, "confirmed").catch(() => null);
    if (exists) {
      console.log(`  existing ${keeperPortfolio.toBase58()} (from manifest)`);
    } else {
      console.log(`  manifest keeperPortfolio ${keeperPortfolio.toBase58()} not on chain → creating fresh`);
      keeperPortfolio = await createKeeperPortfolio();
    }
  } else {
    keeperPortfolio = await createKeeperPortfolio();
  }

  async function createKeeperPortfolio(): Promise<PublicKey> {
    const pf = Keypair.generate();
    const pfRent = await conn.getMinimumBalanceForRentExemption(PORTFOLIO_ACCOUNT_LEN);
    await step(`create keeper portfolio account ${pf.publicKey.toBase58()}`, () =>
      send([SystemProgram.createAccount({
        fromPubkey: admin.publicKey, newAccountPubkey: pf.publicKey,
        lamports: pfRent, space: PORTFOLIO_ACCOUNT_LEN, programId: PROGRAM_ID,
      })], [admin, pf]));
    await step("InitPortfolio (keeper)", () =>
      send([new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: MARKET, isSigner: false, isWritable: true },
          { pubkey: pf.publicKey, isSigner: false, isWritable: true },
        ],
        data: encInitPortfolio(),
      })], [admin]));
    return pf.publicKey;
  }

  // write keeperPortfolio into the manifest
  M.keeperPortfolio = keeperPortfolio.toBase58();
  M.keeper = keeper.publicKey.toBase58();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(M, null, 2));
  console.log(`  keeperPortfolio = ${keeperPortfolio.toBase58()}  (written to manifest)`);

  // ---- 4. cron line ----
  const tsxBin = `${CLI_DIR}/node_modules/.bin/tsx`;
  const logFile = "$HOME/.cache/percolator/bounty5-v16-cron.log";
  const cronLine =
    `* * * * * /usr/bin/timeout 58 sh -c 'cd ${CLI_DIR} && ` +
    `NETWORK=${NETWORK} KEEPER_KEYPAIR=$HOME/.config/solana/bounty5-keeper.json ` +
    `KEEPER_PORTFOLIO=${keeperPortfolio.toBase58()} ` +
    `${tsxBin} scripts/mainnet-bounty5-v16-tick.ts >> ${logFile} 2>&1' ` +
    `# percolator-bounty5-v16-tick`;

  const cronTxtPath = `${CLI_DIR}/scripts/.bounty5-v16-cron.txt`;
  fs.writeFileSync(cronTxtPath, cronLine + "\n");

  console.log("\n=================================");
  console.log(`setup: PASS ${pass}  FAIL ${fail}`);
  console.log("=================================");
  console.log("\nCron line (written to scripts/.bounty5-v16-cron.txt):\n");
  console.log("  " + cronLine);
  console.log("\nThe crontab was NOT modified. To install it yourself, run:\n");
  console.log("  mkdir -p $HOME/.cache/percolator");
  console.log(`  ( crontab -l 2>/dev/null | grep -v percolator-bounty5-v16-tick; cat ${cronTxtPath} ) | crontab -`);
  console.log("\nTo remove it later:\n");
  console.log("  crontab -l | grep -v percolator-bounty5-v16-tick | crontab -");
  console.log("\nReminder: FUND the keeper before enabling cron:");
  console.log(`  ${keeper.publicKey.toBase58()}  (~0.5 SOL)`);
}

main().catch((e: any) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
