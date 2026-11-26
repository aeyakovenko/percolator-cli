/** Poll the live mainnet bounty market; print a line whenever OI or the insurance prize changes. */
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { parseMarket } from "../src/lean/index.js";

const key = fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim();
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed");
const MARKET = new PublicKey("BhYaG2JYRHGrLpWs85TroedmkcG7toX1Ly5YbG1FDZHH");
const VAULT = new PublicKey("6k2H4GiRDGa7o9X8Ai99sGkPQGAvrAW7gVbKkAKuH2Fk");
const u = (n: bigint) => (Number(n) / 1e6).toString();
const t = () => new Date().toISOString().slice(11, 19);

let last = "";
async function tick() {
  try {
    const info = await conn.getAccountInfo(MARKET, "confirmed");
    if (!info) { console.log(`${t()} market account not found`); return; }
    const m = parseMarket(Buffer.from(info.data));
    const vault = (await conn.getTokenAccountBalance(VAULT, "confirmed")).value.uiAmountString;
    // Change key excludes mark (cranks drift it harmlessly) and rounds OI to 0.01-unit
    // (funding settlement drifts OI by ~1e-6 each crank) — alert only on real position/insurance/vault/status moves.
    const rOI = (x: bigint) => (x / 10000n).toString();
    // insurance coarsened to whole-USDC in the key (sustained grind in progress) — vault stays
    // EXACT so any real withdrawal (realized drain) fires immediately.
    const key = `${rOI(m.oiLong)}|${rOI(m.oiShort)}|${m.insurance / 5_000_000n}|${vault}|${m.statusName}`;
    const snap = `OI long=${u(m.oiLong)} short=${u(m.oiShort)} | insurance=${u(m.insurance)} | vault=${vault} USDC | mark=$${u(m.markPrice)} | status=${m.statusName}`;
    if (key !== last) { console.log(`${t()} ${last === "" ? "[baseline] " : "[CHANGE] "}${snap}`); last = key; }
  } catch (e) { console.log(`${t()} poll error: ${String((e as Error).message ?? e).slice(0, 80)}`); }
}
(async () => { for (;;) { await tick(); await new Promise(r => setTimeout(r, 30_000)); } })();
