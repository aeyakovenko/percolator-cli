/**
 * v16 BOUNTY-5 KEEPER TICK — ONE cron invocation (~60 s of work).
 *
 * A single run of the dedicated keeper that keeps the live bounty-5 market
 * group fresh and liquidates any underwater portfolio. Designed to be launched
 * once per minute (under `timeout 58`) so the work fits inside one wall minute.
 *
 *   On start (once per run):
 *     - push the 4 Pyth legs (SOL/STOXX/EUR/BTC) with the KEEPER as fee-payer
 *       (Pyth accounts stay < max_staleness_secs=600 s for the whole minute, so
 *        a single push per cron run is enough; cranking is what must be frequent).
 *   Then 10 cycles, one every ~6 s (t = 0,6,12,…,54 s):
 *     (a) PermissionlessCrank action:0 (refresh/accrue) for each of the 3 assets.
 *         The FIRST cycle catches up a stale asset (crank repeatedly until its
 *         slot_last is within max_accrual_dt of the current slot); later cycles
 *         do a single crank.
 *     (b) Liquidation scan: enumerate every portfolio; for each one holding a
 *         non-zero position in an asset, attempt action:1 (liquidate) targeting
 *         that portfolio on that asset. 0x16 / 0x15 (healthy → not liquidatable)
 *         are caught and ignored; only real liquidations are logged.
 *
 * Every tx uses ComputeBudget (limit 600k, price 50k µ-lamports, 256 KB heap),
 * is wrapped in try/catch, and never throws out of the loop — a cron tick must
 * keep going. A one-line summary is printed at the end.
 *
 * Usage (what the cron line runs):
 *   NETWORK=mainnet KEEPER_KEYPAIR=$HOME/.config/solana/bounty5-keeper.json \
 *   KEEPER_PORTFOLIO=<pubkey> tsx scripts/mainnet-bounty5-v16-tick.ts
 *
 * Env:
 *   NETWORK            mainnet | devnet  (default mainnet)
 *   KEEPER_KEYPAIR     keeper signer json (default ~/.config/solana/bounty5-keeper.json)
 *   KEEPER_PORTFOLIO   the keeper's own portfolio pubkey (created by the installer)
 *   SOLANA_RPC_URL     devnet RPC override
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { spawnSync } from "child_process";
import * as fs from "fs";
import {
  encPermissionlessCrank,
  MARKET_GROUP_OFF, MG, ASSET_SLOT_LEN, ASSET_ORACLE_WRAPPER_LEN,
} from "../src/v16/index.js";
import { discoverPortfolios } from "../src/v16/discover.js";

// ============================================================================
// Config / environment
// ============================================================================
const HOME = process.env.HOME!;
const NETWORK = (process.env.NETWORK ?? "mainnet").toLowerCase();
const PUSHER_DIR = `${HOME}/pyth-pusher`;

function mainnetRpc(): string {
  const key = fs.readFileSync(`${HOME}/.helius`, "utf8").trim();
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}
function devnetRpc(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  try {
    const line = fs.readFileSync(`${HOME}/percolator-cli/.env`, "utf8").trim();
    const idx = line.indexOf("=");
    if (idx > 0) return line.slice(idx + 1).trim();
  } catch { /* fall through */ }
  return "https://api.devnet.solana.com";
}

const RPC = NETWORK === "mainnet" ? mainnetRpc() : devnetRpc();
const MANIFEST_PATH = NETWORK === "mainnet"
  ? `${HOME}/percolator-cli/mainnet-bounty5-v16-market.json`
  : `${HOME}/percolator-cli/bounty5-v16-devnet.json`;
const M = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

const PROGRAM_ID = new PublicKey(M.programId);
const MARKET = new PublicKey(M.market);
const conn = new Connection(RPC, "confirmed");

const KEEPER_KEYPAIR_PATH = process.env.KEEPER_KEYPAIR ?? `${HOME}/.config/solana/bounty5-keeper.json`;
const keeper = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(KEEPER_KEYPAIR_PATH, "utf8"))));

const KEEPER_PORTFOLIO = new PublicKey(
  process.env.KEEPER_PORTFOLIO ?? M.keeperPortfolio ?? (() => {
    throw new Error("KEEPER_PORTFOLIO env (or manifest.keeperPortfolio) is required");
  })());

// Pyth feed IDs (32-byte hex, no 0x prefix) — same as the deployer.
const FEED_SOL_USD   = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const FEED_STOXX_EUR = "dd08f0a40e21ce42178b25bdd9461a2beebccbaa2a781a6e02b323576c4072ab";
const FEED_EUR_USD   = "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b";
const FEED_BTC_USD   = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
// Only self-push the legs nobody else maintains. SOL/USD and BTC/USD shard-0 are
// kept fresh on mainnet by Pyth's sponsored cranks (verified: last 12 writes all
// external, on-chain age single-digit seconds), so m0/m2 need NO push from us.
// Only m1's equity (STOXX) + FX (EUR) legs are self-maintained, and only during
// their market hours — out of hours m1 uses the HYBRID_AFTER_HOURS EWMA fallback,
// so a push there is wasted (Hermes returns a stale, non-advancing price).
const PYTH_FEEDS = [FEED_STOXX_EUR, FEED_EUR_USD];

// Per-asset oracle accounts (mainnet == devnet PDAs — same as the smokes/deployer).
const SOL = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const STOXX = new PublicKey("C2Cf16vF6LX8GrWJwfZga5z5tjVsax5VWnL2T7Q8CF91");
const EUR = new PublicKey("Fu76ChamBDjE8UuGLV6GP2AcPPSU6gjhkNhAyuoPm7ny");
const BTC = new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");
const ASSETS = [
  { idx: 0, label: "USD/SOL",   accts: [SOL] },
  { idx: 1, label: "STOXX/SOL", accts: [STOXX, EUR, SOL] },
  { idx: 2, label: "BTC/SOL",   accts: [BTC, SOL] },
];

const MAX_ACCRUAL_DT = 20n;          // matches InitMarket maxAccrualDtSlots
const CYCLES = 10;                   // 10 × 6 s ≈ 60 s
const CYCLE_MS = 6_000;
const WSOL_REWARD_WRAP = 2_000_000n; // tiny wSOL so the cranker reward ATA exists

const withCu = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
];

const vaultAuth = PublicKey.findProgramAddressSync([Buffer.from("vault"), MARKET.toBuffer()], PROGRAM_ID)[0];
const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);
const keeperWsol = getAssociatedTokenAddressSync(NATIVE_MINT, keeper.publicKey);

const send = (ixs: TransactionInstruction[]) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...withCu(), ...ixs), [keeper],
    { commitment: "confirmed", skipPreflight: true });

// Extract a `custom program error: 0x..` code from a thrown send error.
function errCode(e: any): string {
  const logs = ((e?.transactionLogs ?? e?.logs) ?? []).join(" ");
  return logs.match(/custom program error: (0x[0-9a-f]+)/i)?.[1]
    ?? (e?.message ? String(e.message).slice(0, 90) : "unknown");
}

let cranksOk = 0, cranksFail = 0, liqDone = 0, liqAttempt = 0;

// ============================================================================
// Pyth push (once per run)
// ============================================================================
// feed → its on-chain PriceUpdateV2 account (to check freshness before pushing).
const FEED_ACCT: Record<string, PublicKey> = {
  [FEED_SOL_USD]: SOL, [FEED_STOXX_EUR]: STOXX, [FEED_EUR_USD]: EUR, [FEED_BTC_USD]: BTC,
};
// A Pyth VAA push costs ~0.016 SOL — keep the market "barely alive" at minimal cost.
// Push a leg only inside a narrow window: it's aging toward max_staleness_secs=600 s
// (so a fresh leg is skipped — re-push only when age > 550 s, landing ≤ ~610 s) AND it's
// not already deep after-hours. Past ~1700 s the leg's market is closed → Hermes returns a
// stale, non-advancing price and m1 uses the EWMA fallback anyway, so pushing is wasted.
const PUSH_IF_OLDER_SECS = 500;
const SKIP_IF_OLDER_SECS = 750;   // just past max_staleness — once a leg is this stale its
                                  // market is closed (Hermes won't advance it) → EWMA fallback,
                                  // so stop pushing (only ~1 wasted push at each close).
async function pushPythLegs() {
  const pusher = NETWORK === "mainnet" ? `${PUSHER_DIR}/push.js` : `${PUSHER_DIR}/push-devnet.js`;
  console.log(`[push] ${NETWORK} self-maintained legs via ${pusher} (fee-payer ${keeper.publicKey.toBase58()})`);
  const nowTs = Math.floor(Date.now() / 1000);
  for (const feed of PYTH_FEEDS) {
    try {
      const acct = FEED_ACCT[feed];
      const info = acct ? await conn.getAccountInfo(acct, "confirmed") : null;
      if (info && info.data.length >= 101) {
        const age = nowTs - Number(info.data.readBigInt64LE(93)); // PriceUpdateV2 publish_time @93
        if (age >= 0 && age < PUSH_IF_OLDER_SECS) { console.log(`  ·   fresh ${feed.slice(0, 12)}… (age ${age}s)`); continue; }
        if (age > SKIP_IF_OLDER_SECS) { console.log(`  ·   after-hours ${feed.slice(0, 12)}… (age ${age}s → EWMA fallback)`); continue; }
      }
      const r = spawnSync("node", [pusher, feed, "0", KEEPER_KEYPAIR_PATH], {
        cwd: PUSHER_DIR,
        env: { ...process.env, SOLANA_RPC_URL: RPC },
        encoding: "utf8",
        timeout: 25_000,
      });
      if (r.status === 0) console.log(`  ✅  push ${feed.slice(0, 12)}…`);
      else console.log(`  ❌  push ${feed.slice(0, 12)}…: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-1)[0]}`);
    } catch (e: any) {
      console.log(`  ❌  push ${feed.slice(0, 12)}…: ${e.message ?? e}`);
    }
  }
}

// ============================================================================
// Crank (action:0 refresh/accrue)
// ============================================================================
async function assetSlotLast(idx: number): Promise<bigint> {
  const { parseAsset } = await import("../src/v16/parsers.js");
  const info = await conn.getAccountInfo(MARKET, "confirmed");
  if (!info) throw new Error("market account missing");
  const buf = Buffer.from(info.data);
  const off = MARKET_GROUP_OFF + MG.asset_slots + idx * ASSET_SLOT_LEN + ASSET_ORACLE_WRAPPER_LEN;
  return (parseAsset(buf, off, idx) as any).slotLast as bigint;
}

function crankRefreshIx(idx: number, accts: PublicKey[], slot: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: KEEPER_PORTFOLIO, isSigner: false, isWritable: true },
      ...accts.map((a) => ({ pubkey: a, isSigner: false, isWritable: false })),
    ],
    data: encPermissionlessCrank({
      action: 0, assetIndex: idx, nowSlot: slot,
      fundingRateE9: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0,
    }),
  });
}

// Single refresh crank for an asset.
async function crankOnce(a: typeof ASSETS[number]) {
  const slot = BigInt(await conn.getSlot("confirmed"));
  try {
    await send([crankRefreshIx(a.idx, a.accts, slot)]);
    cranksOk++;
    console.log(`  ✅  crank m${a.idx} (${a.label}) @ ${slot}`);
  } catch (e: any) {
    cranksFail++;
    console.log(`  ❌  crank m${a.idx} (${a.label}): ${errCode(e)}`);
  }
}

// Catch-up crank: each accrual advances ≤ max_accrual_dt slots, so a long-idle
// asset needs several cranks to reach the current slot. Crank until slot_last is
// within max_accrual_dt of the current slot (bounded retries).
async function crankCatchUp(a: typeof ASSETS[number]) {
  // up to ~40 accrual steps/tick (≤800 slots ≈ 5 min of downtime) — a market past
  // max_accrual_dt is NOT dead; it catches up over repeated cranks (and across ticks).
  for (let i = 0; i < 40; i++) {
    let cur: bigint, slotLast: bigint;
    try {
      cur = BigInt(await conn.getSlot("confirmed"));
      slotLast = await assetSlotLast(a.idx);
    } catch (e: any) {
      console.log(`  ❌  catchup read m${a.idx}: ${errCode(e)}`);
      break;
    }
    if (slotLast > 0n && cur - slotLast <= MAX_ACCRUAL_DT) break;
    try {
      await send([crankRefreshIx(a.idx, a.accts, cur)]);
      cranksOk++;
    } catch (e: any) {
      cranksFail++;
      console.log(`  ❌  catchup crank m${a.idx}: ${errCode(e)}`);
      break;
    }
  }
  // one final fresh crank so the stored mark is current
  await crankOnce(a);
}

// ============================================================================
// Liquidation (action:1) — uses the STORED mark, so refresh the asset first.
// Account layout (from smoke-v16-bounty5 Stage 10):
//   [cranker(signer), market(w), TARGET_portfolio(w),
//    cranker_sourceAta(w), vaultAta(w), vaultAuth(ro), tokenProgram(ro)]
// ============================================================================
function liquidateIx(targetPortfolio: PublicKey, idx: number, slot: bigint, closeQ: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
      { pubkey: MARKET, isSigner: false, isWritable: true },
      { pubkey: targetPortfolio, isSigner: false, isWritable: true },
      { pubkey: keeperWsol, isSigner: false, isWritable: true },
      { pubkey: vaultAta, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: encPermissionlessCrank({
      action: 1, assetIndex: idx, nowSlot: slot,
      fundingRateE9: 0n, closeQ, feeBps: 0n, recoveryReason: 0,
    }),
  });
}

// Ensure the keeper's wSOL ATA exists (cranker reward sink). Idempotent; tiny wrap.
async function ensureKeeperWsol() {
  try {
    if (await conn.getAccountInfo(keeperWsol, "confirmed")) return;
    await send([
      createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, keeperWsol, keeper.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: keeperWsol, lamports: Number(WSOL_REWARD_WRAP) }),
      { keys: [{ pubkey: keeperWsol, isSigner: false, isWritable: true }], programId: TOKEN_PROGRAM_ID, data: Buffer.from([17]) },
    ]);
    console.log(`  ✅  keeper wSOL ATA ready ${keeperWsol.toBase58()}`);
  } catch (e: any) {
    console.log(`  ❌  keeper wSOL ATA: ${errCode(e)}`);
  }
}

// Scan all portfolios; attempt a liquidation on each non-zero leg.
async function liquidationScan() {
  let rows;
  try {
    rows = await discoverPortfolios(conn, PROGRAM_ID);
  } catch (e: any) {
    console.log(`  ❌  discoverPortfolios: ${errCode(e)}`);
    return;
  }
  for (const row of rows) {
    // Skip the keeper's own portfolio + portfolios from a different market group.
    if (row.address.equals(KEEPER_PORTFOLIO)) continue;
    if (!row.data.marketGroupId.equals(MARKET)) continue;

    for (const leg of row.data.legs) {
      const size = leg.basisPosQ < 0n ? -leg.basisPosQ : leg.basisPosQ;
      if (size === 0n) continue;
      const idx = leg.index;
      // The stored leg.market_id maps to an asset slot; for the 3-asset bounty
      // market the leg index IS the asset index (slots 0..2). Refresh that
      // asset (action:1 uses the stored mark) then attempt the liquidation.
      const asset = ASSETS.find((a) => a.idx === idx);
      if (!asset) continue;
      await crankOnce(asset);

      const slot = BigInt(await conn.getSlot("confirmed"));
      // Close the whole position (clamped large; engine caps at the real size).
      const closeQ = size > (1n << 120n) ? size : (1n << 120n);
      liqAttempt++;
      try {
        await send([liquidateIx(row.address, idx, slot, closeQ)]);
        liqDone++;
        console.log(`  💥  LIQUIDATED ${row.address.toBase58()} m${idx} size=${size}`);
      } catch (e: any) {
        const code = errCode(e);
        // 0x15 / 0x16 = healthy → not liquidatable. Silent (this is the norm).
        if (code === "0x15" || code === "0x16") continue;
        console.log(`  ⚠️   liq ${row.address.toBase58().slice(0, 8)}… m${idx}: ${code}`);
      }
    }
  }
}

// ============================================================================
// Main loop
// ============================================================================
async function main() {
  console.log(`bounty5-v16 tick  network=${NETWORK}  market=${MARKET.toBase58()}`);
  console.log(`  keeper=${keeper.publicKey.toBase58()}  portfolio=${KEEPER_PORTFOLIO.toBase58()}`);
  console.log(`  rpc=${RPC.split("?")[0]}`);

  await pushPythLegs();
  await ensureKeeperWsol();

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const t0 = Date.now();
    console.log(`\n--- cycle ${cycle + 1}/${CYCLES} (t≈${cycle * (CYCLE_MS / 1000)}s) ---`);

    // (a) refresh all 3 assets
    for (const a of ASSETS) {
      if (cycle === 0) await crankCatchUp(a);   // first cycle: catch up a stale market
      else await crankOnce(a);
    }

    // (b) liquidation scan
    await liquidationScan();

    // pace to ~CYCLE_MS, accounting for elapsed work; skip on the last cycle
    if (cycle < CYCLES - 1) {
      const elapsed = Date.now() - t0;
      const wait = CYCLE_MS - elapsed;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  console.log(`\n===== tick done: cranks ok=${cranksOk} fail=${cranksFail}  liquidations done=${liqDone}/${liqAttempt} =====`);
}

main().catch((e: any) => {
  // A cron tick must never crash hard — log and exit 0 so the next tick runs.
  console.error("tick error:", e?.message ?? e);
  process.exit(0);
});
