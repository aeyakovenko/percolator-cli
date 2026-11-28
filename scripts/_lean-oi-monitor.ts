/** Poll the live mainnet bounty market; print a line whenever one of the 3 prize surfaces or the status changes.
 *  Output (grepped by a watcher): `HH:MM:SS [baseline|CHANGE] insurance=$.. | vaultPfl=$.. | userLong=$.. | status=.. | mark=$..`
 *  - market + both prize portfolios are read in ONE getMultipleAccountsInfo call (same-slot snapshot);
 *  - a prize portfolio's value = free capital + totalLockedMm, so opening/closing the prize position
 *    (collateral moving between free and locked margin) is NOT a change;
 *  - every account is validated (owner == manifest percolator program, size, magic); a mismatch or a
 *    missing market prints a [CHANGE] line with ` | ALERT=<reason>` appended instead of decoding garbage.
 *  Env: LEAN_MANIFEST (default lean-mainnet-r4.json), LEAN_RPC_URL (default mainnet Helius),
 *  LEAN_MARKET_SIZE (default manifest.marketSize ?? 416; use 400 for the round-3 layout), LEAN_POLL_MS (30000). */
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { MARKET_SIZE } from "../src/lean/constants.js";
import { decodePrizeSnapshot } from "../src/lean/prize-monitor.js";

const rpc = process.env.LEAN_RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim()}`;
const conn = new Connection(rpc, "confirmed");
const MANI = JSON.parse(fs.readFileSync(process.env.LEAN_MANIFEST ?? `${process.env.HOME}/percolator-cli/lean-mainnet-r4.json`, "utf8"));
const PROGRAM = new PublicKey(MANI.percolator);
const MARKET = new PublicKey(MANI.market);
// The 3 prize surfaces — watch these, NOT the DEX-vault total (hunters cycle their own collateral,
// which is noise). Theft = a prize actually shrinking: insurance, or either prize portfolio's capital+lockedMm.
const VAULT_PFL = new PublicKey(MANI.prizes.vaultPortfolio); // prize 2 (loose collateral)
const USER_LONG = new PublicKey(MANI.prizes.userLong); // prize 3 (long position)
const MKT_SIZE = Number(process.env.LEAN_MARKET_SIZE ?? MANI.marketSize ?? MARKET_SIZE);
const POLL_MS = Number(process.env.LEAN_POLL_MS ?? 30_000);
const t = () => new Date().toISOString().slice(11, 19);

let last = ""; let errStreak = 0;
async function tick() {
  try {
    const infos = await conn.getMultipleAccountsInfo([MARKET, VAULT_PFL, USER_LONG], "confirmed");
    errStreak = 0;
    // key = the 3 prizes (insurance + both prize portfolios' capital+lockedMm, 0.01 USDC) + status + any
    // validation problem. Fires only on a real prize move or a broken/replaced account.
    const s = decodePrizeSnapshot(PROGRAM, infos, MKT_SIZE);
    if (s.key !== last) { console.log(`${t()} ${last === "" && s.problems.length === 0 ? "[baseline] " : "[CHANGE] "}${s.line}`); last = s.key; }
  } catch (e) { errStreak++; if (errStreak >= 4) console.log(`${t()} poll error x${errStreak} (persistent): ${String((e as Error).message ?? e).replace(/api-key=[^&\s"']+/g, "api-key=***").slice(0, 70)}`); } // ignore transient single hiccups
}
(async () => { for (;;) { await tick(); await new Promise(r => setTimeout(r, POLL_MS)); } })();
