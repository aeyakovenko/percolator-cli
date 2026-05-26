/**
 * One-shot health check of the live mainnet bounty-5 v16 market + keeper.
 * Prints a compact status line + ALERTs. Used by the monitoring loop.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { parseMarketGroup, parseAsset } from "../src/v16/parsers.js";
import { discoverPortfolios } from "../src/v16/discover.js";
import { MARKET_GROUP_OFF, MG, ASSET_SLOT_LEN, ASSET_ORACLE_WRAPPER_LEN } from "../src/v16/constants.js";

const RPC = `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim()}`;
const conn = new Connection(RPC, "confirmed");
// Follow the manifest so the monitor tracks the live market across re-launches.
const M = JSON.parse(fs.readFileSync(`${process.env.HOME}/percolator-cli/mainnet-bounty5-v16-market.json`, "utf8"));
const PROGRAM = new PublicKey(M.programId);
const MARKET = new PublicKey(M.market);
const KEEPER = new PublicKey(M.keeper ?? "9WiMAQtdx8zXMovePuaZ7v472UsFgZ7vkL7rr7APuxBQ");
const INSURANCE_BASELINE = Number(process.env.INSURANCE_BASELINE ?? 2.0); // SOL seeded; a drop = bounty hit
// Idle strategy is DORMANT: with no positions the keeper lets the market drift
// stale on purpose, so a large dt is EXPECTED, not a problem. Only alert when the
// drift is nearing the ~30-day hard-stale, or when stale WHILE positions are open.
const HARD_STALE = 6_480_000;     // permissionless_resolve_stale_slots
const NEAR_HARD_STALE = 5_500_000;
const POS_STALE_ALERT = 500;      // if positions exist, the keeper should keep dt low

(async () => {
  const ts = new Date().toISOString().slice(11, 19);
  const buf = Buffer.from((await conn.getAccountInfo(MARKET, "confirmed"))!.data);
  const slot = await conn.getSlot("confirmed");
  const mg: any = parseMarketGroup(buf);
  const ins = Number(mg.insurance) / 1e9;
  const cTot = Number(mg.cTot) / 1e9;
  const keeperSol = (await conn.getBalance(KEEPER)) / 1e9;
  const dts: number[] = [];
  for (const ai of [0, 1, 2]) {
    const off = MARKET_GROUP_OFF + MG.asset_slots + ai * ASSET_SLOT_LEN + ASSET_ORACLE_WRAPPER_LEN;
    dts.push(slot - Number((parseAsset(buf, off, ai) as any).slotLast));
  }
  let ports = 0, withPos = 0;
  try {
    const rows = await discoverPortfolios(conn, PROGRAM);
    ports = rows.length;
    withPos = rows.filter((r: any) => r.data.legs?.some((l: any) => l.basisPosQ !== 0n)).length;
  } catch { /* parser/RPC hiccup */ }

  const cronLog = `${process.env.HOME}/.cache/percolator/bounty5-v16-cron.log`;
  let cronAge = "n/a";
  try { cronAge = `${Math.round((Date.now() - fs.statSync(cronLog).mtimeMs) / 1000)}s`; } catch { /* */ }

  console.log(`[${ts}] mode=${mg.mode} ins=${ins.toFixed(4)}SOL cTot=${cTot.toFixed(4)} dt=[${dts.join(",")}]slots ports=${ports}(pos:${withPos}) keeper=${keeperSol.toFixed(3)}SOL cronLog=${cronAge} ago`);

  const alerts: string[] = [];
  const maxDt = Math.max(...dts);
  if (ins < INSURANCE_BASELINE - 1e-6) alerts.push(`🚨 INSURANCE DROPPED ${INSURANCE_BASELINE}→${ins.toFixed(4)} SOL (BOUNTY HIT?)`);
  if (mg.mode !== 0) alerts.push(`🚨 market mode=${mg.mode} (not Live)`);
  if (maxDt > NEAR_HARD_STALE) alerts.push(`🚨 nearing hard-stale: max dt=${maxDt}/${HARD_STALE} — heartbeat must crank`);
  if (withPos > 0 && maxDt > POS_STALE_ALERT) alerts.push(`⚠️  positions open but stale (dt=${maxDt}) — keeper should be cranking`);
  if (keeperSol < 1) alerts.push(`⚠️  keeper low: ${keeperSol.toFixed(3)} SOL — fund it`);
  if (withPos > 0) alerts.push(`ℹ️  ${withPos} portfolio(s) hold positions — watch for liquidations`);
  if (alerts.length) alerts.forEach((a) => console.log("   " + a));
  else console.log("   ✅ healthy");
})().catch((e) => { console.error("MONITOR ERROR:", e.message); process.exit(1); });
