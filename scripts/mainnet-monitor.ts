/**
 * Live monitor for the mainnet admin-free market. Reads current slab state,
 * decodes the Pyth oracle, and prints staleness / cap / burn-status snapshot.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import * as fs from "fs";
import { parseHeader, parseConfig, parseEngine, parseUsedIndices, fetchSlab } from "../src/solana/slab.js";

function u128LE(b: Buffer, off: number): bigint {
  return (b.readBigUInt64LE(off + 8) << 64n) | b.readBigUInt64LE(off);
}

async function main() {
  const m = JSON.parse(fs.readFileSync("mainnet-market.json", "utf-8"));
  const slab = new PublicKey(m.slab);
  const oracle = new PublicKey(m.oracle);
  const vault = new PublicKey(m.vault);
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

  const nowSec = Math.floor(Date.now() / 1000);
  const currentSlot = await conn.getSlot("confirmed");

  // ── Slab state ──
  const slabData = await fetchSlab(conn, slab);
  const h = parseHeader(slabData);
  const c = parseConfig(slabData);
  const e = parseEngine(slabData);
  const used = parseUsedIndices(slabData);

  // ── Pyth oracle liveness ──
  const oracleInfo = await conn.getAccountInfo(oracle);
  let pythPriceUsd = 0, pythAgeSec = -1;
  if (oracleInfo) {
    const d = Buffer.from(oracleInfo.data);
    const price = d.readBigInt64LE(41 + 32);
    const expo = d.readInt32LE(41 + 48);
    const publishTs = Number(d.readBigInt64LE(41 + 52));
    pythPriceUsd = Number(price) * Math.pow(10, expo);
    pythAgeSec = nowSec - publishTs;
  }

  // ── SPL vault ──
  const splBalance = (await getAccount(conn, vault)).amount;

  // ── Cluster slot used by market ──
  // v12.21: lastCrankSlot is gone. lastMarketSlot is the engine accrue
  // cursor; under MAX_ACCRUAL_DT_SLOTS=100 it is the only liveness signal.
  const slotsSinceMarketAccrue = Number(BigInt(currentSlot) - e.lastMarketSlot);
  const approxSecSinceAccrue = slotsSinceMarketAccrue * 0.4; // 400 ms/slot

  // ── Permissionless-resolve window ──
  const resolveDeadline = e.lastMarketSlot + c.permissionlessResolveStaleSlots;
  const slotsUntilPermResolve = Number(resolveDeadline - BigInt(currentSlot));
  const hoursUntilPermResolve = slotsUntilPermResolve * 0.4 / 3600;

  // ── TVL cap room ──
  const capCeiling = e.insuranceFund.balance * BigInt(c.tvlInsuranceCapMult);
  const capRoom = capCeiling - e.cTot;

  // ── Next cron fire time ──
  const nowDate = new Date(Date.now());
  const nextCron = new Date(nowDate);
  nextCron.setUTCMinutes(0, 0, 0);
  if (nextCron <= nowDate) nextCron.setUTCHours(nextCron.getUTCHours() + 1);
  const minsToCron = Math.round((nextCron.getTime() - nowDate.getTime()) / 60000);

  // ── Output ──
  const br = (n: bigint | number) => Number(n) / 1e9;
  const status = (pk: PublicKey) => pk.equals(PublicKey.default) ? "🔥" : pk.toBase58().slice(0, 12) + "…";
  const ok = (b: boolean) => b ? "✓" : "✗";
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log(`║ MAINNET MARKET MONITOR — ${nowDate.toISOString()}        ║`);
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log(`slab:    ${slab.toBase58()}`);
  console.log(`program: ${m.programId}`);
  console.log(`cluster slot: ${currentSlot}`);
  console.log();
  console.log("─── Market state ───");
  console.log(`  mode:             ${e.marketMode === 0 ? "Live" : "🚨 Resolved"}`);
  console.log(`  magic OK:         ${ok(h.magic === 0x504552434f4c4154n)}`);
  console.log(`  numUsed:          ${e.numUsedAccounts}  (active idx: ${used.join(",") || "none"})`);
  console.log(`  vault:            ${br(e.vault).toFixed(4)} SOL    (SPL: ${br(splBalance).toFixed(4)})`);
  console.log(`  c_tot:            ${br(e.cTot).toFixed(4)} SOL  (deposit cap ceiling: ${br(capCeiling).toFixed(2)} SOL, room: ${br(capRoom).toFixed(4)} SOL)`);
  console.log(`  insurance:        ${br(e.insuranceFund.balance).toFixed(4)} SOL`);
  console.log(`  conservation:     ${ok(e.vault === splBalance)} vault==SPL   ${ok(e.vault >= e.cTot + e.insuranceFund.balance)} vault≥c_tot+ins`);
  console.log();
  console.log("─── Oracle (Pyth SOL/USD sponsor) ───");
  console.log(`  account:          ${oracle.toBase58()}`);
  console.log(`  price:            $${pythPriceUsd.toFixed(4)}     (posted ${pythAgeSec}s ago, maxStaleness ${c.maxStalenessSecs}s: ${ok(pythAgeSec <= Number(c.maxStalenessSecs))})`);
  console.log(`  last engine read: ${e.lastOraclePrice}  (engine-space, inverted)`);
  console.log();
  console.log("─── Accrue health (v12.21: lastCrankSlot removed) ───");
  console.log(`  last_market_slot:   ${e.lastMarketSlot}`);
  console.log(`  slots since accrue: ${slotsSinceMarketAccrue}  (~${(approxSecSinceAccrue / 60).toFixed(1)} min)`);
  console.log(`  rr_cursor:          ${e.rrCursorPosition}  (sweep_gen=${e.sweepGeneration})`);
  console.log(`  max_staleness:      ${c.maxStalenessSecs}s`);
  console.log();
  console.log("─── Permissionless-resolve guard ───");
  const hrsStr = hoursUntilPermResolve >= 0 ? `${hoursUntilPermResolve.toFixed(2)}h remaining` : `🚨 EXPIRED ${Math.abs(hoursUntilPermResolve).toFixed(2)}h ago`;
  console.log(`  deadline (slot):     ${resolveDeadline}`);
  console.log(`  ${hrsStr}  (stale-slots window: ${c.permissionlessResolveStaleSlots}, ~48 h)`);
  console.log();
  console.log("─── Authority status ───");
  console.log(`  admin:                ${status(h.admin)}`);
  console.log(`  insurance_authority:  ${status(h.insuranceAuthority)}`);
  console.log(`  insurance_operator:   ${status(h.insuranceOperator)}`);
  console.log(`  hyperp_authority:     ${status(c.hyperpAuthority)}`);
  console.log();
  console.log("─── Next scheduled crank (local cron) ───");
  console.log(`  next:  ${nextCron.toISOString()}  (T-${minsToCron} min)`);
  const logFile = "/home/anatoly/percolator-cli/mainnet-crank.log";
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n").slice(-3);
    console.log("  last log lines:");
    lines.forEach(l => console.log(`    ${l}`));
  } else {
    console.log("  (no cron log yet — first crank fires at the next top-of-hour)");
  }
}

main().catch(e => { console.error("FATAL:", e.message ?? e); process.exit(1); });
