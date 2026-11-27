/** Poll the live mainnet bounty market; print a line whenever OI or the insurance prize changes. */
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
// NOTE: read raw offsets (not parseMarket) so this works on BOTH the old 352B mainnet market and
// the new 400B ee69211 layout — status@4/mark@112/insurance@224/OI@256,264 are identical in both.
const STATUS_NAMES = ["Active", "WindDown", "Resolved", "Tombstoned"];

const key = fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim();
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed");
const MARKET = new PublicKey("9JWceeR4k9mworx5QqvvjxSc7xF7PRYjQE3Ng4QYs5Ej");
// The 3 prize surfaces — watch these, NOT the DEX-vault total (hunters cycle their own collateral,
// which is noise). Theft = a prize actually shrinking: insurance, or either prize portfolio's capital.
const VAULT_PFL = new PublicKey("2YYTS9t2mV2ZSfmXxqNZV6TLQEHwqsHSSSPqJQNrHw4t"); // prize 2 (loose collateral)
const USER_LONG = new PublicKey("DtNXawKjnbmAB57qoo2fzamBnQqhuRgmTPmFDZy8ewMj"); // prize 3 (long position)
const u = (n: bigint) => (Number(n) / 1e6).toString();
const t = () => new Date().toISOString().slice(11, 19);
const cap = async (p: PublicKey) => { const i = await conn.getAccountInfo(p, "confirmed"); return i ? Buffer.from(i.data).readBigUInt64LE(88) : -1n; };

let last = "";
async function tick() {
  try {
    const info = await conn.getAccountInfo(MARKET, "confirmed");
    if (!info) { console.log(`${t()} market account not found`); return; }
    const b = Buffer.from(info.data);
    const insurance = b.readBigUInt64LE(224), status = STATUS_NAMES[b.readUInt8(4)] ?? `?${b.readUInt8(4)}`;
    const vCap = await cap(VAULT_PFL), uCap = await cap(USER_LONG);
    // key = the 3 prizes exactly (insurance + both prize portfolios' capital) + status. Fires only on a
    // real prize move; the hunter's own deposits/withdrawals/trades no longer generate noise.
    const c = (x: bigint) => (x < 0n ? -1n : x / 10_000n).toString(); // round to 0.01 USDC — ignore sub-cent dust
    const key = `${c(insurance)}|${c(vCap)}|${c(uCap)}|${status}`;
    const snap = `insurance=$${u(insurance)} | vaultPfl=$${vCap < 0n ? "CLOSED" : u(vCap)} | userLong=$${uCap < 0n ? "CLOSED" : u(uCap)} | status=${status} | mark=$${u(b.readBigUInt64LE(112))}`;
    if (key !== last) { console.log(`${t()} ${last === "" ? "[baseline] " : "[CHANGE] "}${snap}`); last = key; }
  } catch (e) { console.log(`${t()} poll error: ${String((e as Error).message ?? e).slice(0, 80)}`); }
}
(async () => { for (;;) { await tick(); await new Promise(r => setTimeout(r, 30_000)); } })();
