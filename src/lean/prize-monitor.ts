/**
 * Pure decode/validate/key logic for the prize monitor (scripts/_lean-oi-monitor.ts).
 * Input = the three accounts of ONE getMultipleAccountsInfo snapshot: [market, vaultPortfolio, userLong].
 *
 * A prize portfolio's value is free `capital` + `totalLockedMm`: opening/closing a position only moves
 * collateral between the two, so the sum is what a thief would have to shrink.
 * Every account is validated (owner == percolator program, exact size, magic); a mismatch is surfaced
 * as an explicit problem (and is part of the change key) instead of decoding garbage.
 */
import { PublicKey } from "@solana/web3.js";
import { MAGIC, MARKET_SIZE, PORTFOLIO_SIZE, MktOff, PflOff } from "./constants.js";

export interface RawAccount { owner: PublicKey; data: Uint8Array }
export interface PrizePortfolio { state: "ok" | "closed" | "invalid"; capital: bigint; lockedMm: bigint; value: bigint }
export interface PrizeSnapshot {
  marketOk: boolean; insurance: bigint; status: string; mark: bigint;
  vaultPfl: PrizePortfolio; userLong: PrizePortfolio;
  /** validation failures (empty = healthy) */
  problems: string[];
  /** change-detection key: prizes rounded to 0.01 USDC + status + problems */
  key: string;
  /** `insurance=$.. | vaultPfl=$.. | userLong=$.. | status=.. | mark=$..` (+ ` | ALERT=..` when problems) */
  line: string;
}

const STATUS_NAMES = ["Active", "WindDown", "Resolved", "Tombstoned"];
const usd = (n: bigint) => (Number(n) / 1e6).toString();
const cents = (n: bigint) => (n / 10_000n).toString(); // round to 0.01 USDC — ignore sub-cent dust
const buf = (a: RawAccount) => Buffer.from(a.data.buffer, a.data.byteOffset, a.data.length);

/** null if `a` is a well-formed account of `programId` with the given size + magic, else the reason. */
export function validateAccount(a: RawAccount, programId: PublicKey, size: number, magic: number): string | null {
  if (!a.owner.equals(programId)) return `owner ${a.owner.toBase58()} != program ${programId.toBase58()}`;
  if (a.data.length !== size) return `size ${a.data.length} != ${size}`;
  const m = buf(a).readUInt32LE(0);
  if (m !== magic) return `magic 0x${m.toString(16)} != 0x${magic.toString(16)}`;
  return null;
}

function portfolio(name: string, a: RawAccount | null, programId: PublicKey, problems: string[]): PrizePortfolio {
  if (!a) return { state: "closed", capital: 0n, lockedMm: 0n, value: 0n };
  const bad = validateAccount(a, programId, PORTFOLIO_SIZE, MAGIC.PORTFOLIO);
  if (bad) { problems.push(`${name}: ${bad}`); return { state: "invalid", capital: 0n, lockedMm: 0n, value: 0n }; }
  const b = buf(a);
  const capital = b.readBigUInt64LE(PflOff.capital), lockedMm = b.readBigUInt64LE(PflOff.totalLockedMm);
  return { state: "ok", capital, lockedMm, value: capital + lockedMm };
}

/**
 * @param accounts   [market, vaultPortfolio, userLong] from one getMultipleAccountsInfo call
 * @param marketSize expected Market account size (default MARKET_SIZE = 416, 9b45ad1). The fields read
 *                   here (status@4, mark@112, insurance@224) sit at the same offsets in the 400-byte
 *                   round-3 layout, so pass 400 to watch a round-3 market.
 */
export function decodePrizeSnapshot(
  programId: PublicKey, accounts: readonly (RawAccount | null)[], marketSize: number = MARKET_SIZE,
): PrizeSnapshot {
  if (accounts.length !== 3) throw new Error(`decodePrizeSnapshot: expected 3 accounts, got ${accounts.length}`);
  const [mkt, vp, ul] = accounts;
  const problems: string[] = [];
  let marketOk = false, insurance = 0n, status = "MISSING", mark = 0n;
  if (!mkt) problems.push("market: account not found");
  else {
    const bad = validateAccount(mkt, programId, marketSize, MAGIC.MARKET);
    if (bad) { problems.push(`market: ${bad}`); status = "INVALID"; }
    else {
      const b = buf(mkt);
      marketOk = true;
      insurance = b.readBigUInt64LE(MktOff.insurance);
      mark = b.readBigUInt64LE(MktOff.markPrice);
      status = STATUS_NAMES[b.readUInt8(MktOff.status)] ?? `?${b.readUInt8(MktOff.status)}`;
    }
  }
  const vaultPfl = portfolio("vaultPfl", vp, programId, problems);
  const userLong = portfolio("userLong", ul, programId, problems);
  const pKey = (p: PrizePortfolio) => (p.state === "ok" ? cents(p.value) : p.state);
  const pShow = (p: PrizePortfolio) => (p.state === "ok" ? usd(p.value) : p.state.toUpperCase());
  const key = `${marketOk ? cents(insurance) : status}|${pKey(vaultPfl)}|${pKey(userLong)}|${status}|${problems.join(";")}`;
  const line = `insurance=$${marketOk ? usd(insurance) : status} | vaultPfl=$${pShow(vaultPfl)} | userLong=$${pShow(userLong)} | status=${status} | mark=$${marketOk ? usd(mark) : status}`
    + (problems.length ? ` | ALERT=${problems.join("; ")}` : "");
  return { marketOk, insurance, status, mark, vaultPfl, userLong, problems, key, line };
}
