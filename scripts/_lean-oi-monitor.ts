/** Poll the live mainnet bounty market; print a line whenever OI, prize totals (incl. lockedMm), or DEX conservation changes. */
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  LEAN_MAINNET, deriveDexVault, accountKind, parseDex, parseMarket, parsePortfolio,
} from "../src/lean/index.js";

const DEX = new PublicKey("Ef9p9J2dRBb5aGzPiBG2cxqTCvT3DvcDUYNULBUPTiHh");
const DEX_VAULT = deriveDexVault(LEAN_MAINNET.percolator, DEX)[0];
const MARKET = new PublicKey("9JWceeR4k9mworx5QqvvjxSc7xF7PRYjQE3Ng4QYs5Ej");
// The 3 prize surfaces — watch these, NOT the DEX-vault total (hunters cycle their own collateral,
// which is noise). Theft = a prize actually shrinking or DEX conservation breaking.
const VAULT_PFL = new PublicKey("2YYTS9t2mV2ZSfmXxqNZV6TLQEHwqsHSSSPqJQNrHw4t"); // prize 2 (loose collateral)
const USER_LONG = new PublicKey("DtNXawKjnbmAB57qoo2fzamBnQqhuRgmTPmFDZy8ewMj"); // prize 3 (long position)
const u = (n: bigint) => (Number(n) / 1e6).toString();
const t = () => new Date().toISOString().slice(11, 19);

/** Total collateral backing a portfolio (`freeCapital + totalLockedMm`), or `-1n` if closed/invalid. */
export function portfolioTotalCollateral(data: Buffer): bigint {
  if (accountKind(data) !== "portfolio") return -1n;
  const p = parsePortfolio(data);
  return p.capital + p.totalLockedMm;
}

/**
 * Fetch DEX, SPL vault, market, and both prize portfolios in ONE atomic `getMultipleAccountsInfo`
 * snapshot so deposits/withdrawals cannot race between the DEX and vault balance reads.
 */
export async function fetchMonitorSnapshot(
  conn: Connection,
  addrs = { dex: DEX, vault: DEX_VAULT, market: MARKET, vaultPfl: VAULT_PFL, userLong: USER_LONG },
) {
  const [dexInfo, vaultInfo, mktInfo, vPflInfo, uPflInfo] = await conn.getMultipleAccountsInfo(
    [addrs.dex, addrs.vault, addrs.market, addrs.vaultPfl, addrs.userLong],
    "confirmed",
  );
  if (!dexInfo || !vaultInfo || !mktInfo) return null;
  const d = parseDex(Buffer.from(dexInfo.data));
  if (!d.vault.equals(addrs.vault)) {
    throw new Error(`dex vault mismatch: expected ${d.vault.toBase58()}, fetched ${addrs.vault.toBase58()}`);
  }
  const vBuf = Buffer.from(vaultInfo.data);
  if (vBuf.length < 165) throw new Error(`invalid SPL vault token account size (${vBuf.length})`);
  const spl = vBuf.readBigUInt64LE(64);
  const m = parseMarket(Buffer.from(mktInfo.data));
  const readPflCollateral = (info: typeof vPflInfo): bigint => {
    if (!info || !info.owner.equals(dexInfo.owner)) return -1n;
    const buf = Buffer.from(info.data);
    if (accountKind(buf) !== "portfolio") return -1n;
    return portfolioTotalCollateral(buf);
  };
  const vCap = readPflCollateral(vPflInfo);
  const uCap = readPflCollateral(uPflInfo);
  const buckets = d.totalCapital + d.totalInsurance + d.totalResidual + d.totalSurplus + d.totalRewards;
  const consOk = buckets === d.vaultBalance && spl >= d.vaultBalance;
  const consTag = !consOk ? "BROKEN" : spl === d.vaultBalance ? "OK" : `SURPLUS+${spl - d.vaultBalance}`;
  return { d, m, spl, vCap, uCap, consOk, consTag };
}

async function main() {
  const key = fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim();
  const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed");

  let last = ""; let errStreak = 0;
  async function tick() {
    try {
      const snapData = await fetchMonitorSnapshot(conn);
      if (!snapData) { console.log(`${t()} dex/vault/market account not found`); return; }
      const { m, vCap, uCap, consTag } = snapData;
      errStreak = 0;
      const c = (x: bigint) => (x < 0n ? -1n : x / 10_000n).toString(); // round to 0.01 USDC — ignore sub-cent dust
      const key = `${c(m.insurance)}|${c(vCap)}|${c(uCap)}|${m.statusName}|${consTag}`;
      const snap =
        `insurance=$${u(m.insurance)} | vaultPfl=$${vCap < 0n ? "CLOSED" : u(vCap)} | ` +
        `userLong(cap+locked)=$${uCap < 0n ? "CLOSED" : u(uCap)} | status=${m.statusName} | ` +
        `mark=$${u(m.markPrice)} | cons=${consTag}`;
      if (key !== last) { console.log(`${t()} ${last === "" ? "[baseline] " : "[CHANGE] "}${snap}`); last = key; }
    } catch (e) { errStreak++; if (errStreak >= 4) console.log(`${t()} poll error x${errStreak} (persistent): ${String((e as Error).message ?? e).slice(0, 70)}`); } // ignore transient single hiccups
  }

  for (;;) { await tick(); await new Promise(r => setTimeout(r, 30_000)); }
}

function isDirectEntrypoint(metaUrl: string, argv1 = process.argv[1]): boolean {
  if (!argv1) return false;
  const selfPath = fileURLToPath(metaUrl);
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(selfPath);
  } catch {
    return path.resolve(argv1) === path.resolve(selfPath);
  }
}

if (isDirectEntrypoint(import.meta.url)) {
  main().catch(e => { console.error(String(e).slice(0, 200)); process.exit(1); });
}
