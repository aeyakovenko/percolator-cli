/**
 * Continuous anomaly watcher for the mainnet admin-free market.
 * Polls every 60s and prints a compact status line; flags anything
 * that would indicate a successful attack or a drift from the
 * committed configuration.
 *
 * Designed to run with `run_in_background: true` and be tail-able.
 * Every line is self-describing so the log stays greppable.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import * as fs from "fs";
import { parseHeader, parseConfig, parseEngine, parseUsedIndices, fetchSlab, SLAB_LEN } from "../src/solana/slab.js";

const POLL_INTERVAL_MS = 60_000;

type Snapshot = {
  iso: string;
  slot: number;
  mode: number;
  numUsed: number;
  vault: bigint;
  spl: bigint;
  cTot: bigint;
  insurance: bigint;
  capCeiling: bigint;
  lastOraclePrice: bigint;
  lastMarketSlot: bigint;
  pythPriceUsd: number;
  pythAgeSec: number;
  adminBurned: boolean;
  insuranceAuthBurned: boolean;
  insuranceOperBurned: boolean;
  hyperpAuthBurned: boolean;
  magicOk: boolean;
  dataLen: number;
};

async function sample(conn: Connection, slab: PublicKey, oracle: PublicKey, vault: PublicKey): Promise<Snapshot> {
  const slot = await conn.getSlot("confirmed");
  const slabData = await fetchSlab(conn, slab);
  const h = parseHeader(slabData);
  const c = parseConfig(slabData);
  const e = parseEngine(slabData);
  const used = parseUsedIndices(slabData);
  const splBal = (await getAccount(conn, vault)).amount;
  const oracleInfo = await conn.getAccountInfo(oracle);
  let pythPriceUsd = 0, pythAgeSec = -1;
  if (oracleInfo) {
    const d = Buffer.from(oracleInfo.data);
    const price = d.readBigInt64LE(41 + 32);
    const expo = d.readInt32LE(41 + 48);
    const pubTs = Number(d.readBigInt64LE(41 + 52));
    pythPriceUsd = Number(price) * Math.pow(10, expo);
    pythAgeSec = Math.floor(Date.now() / 1000) - pubTs;
  }
  return {
    iso: new Date().toISOString(),
    slot,
    mode: e.marketMode,
    numUsed: used.length,
    vault: e.vault,
    spl: splBal,
    cTot: e.cTot,
    insurance: e.insuranceFund.balance,
    capCeiling: e.insuranceFund.balance * BigInt(c.tvlInsuranceCapMult),
    lastOraclePrice: e.lastOraclePrice,
    lastMarketSlot: e.lastMarketSlot,
    pythPriceUsd,
    pythAgeSec,
    adminBurned: h.admin.equals(PublicKey.default),
    insuranceAuthBurned: h.insuranceAuthority.equals(PublicKey.default),
    insuranceOperBurned: h.insuranceOperator.equals(PublicKey.default),
    hyperpAuthBurned: c.hyperpAuthority.equals(PublicKey.default),
    magicOk: h.magic === 0x504552434f4c4154n,
    dataLen: slabData.length,
  };
}

function checkAnomalies(s: Snapshot, permResolveWindow: bigint): string[] {
  const a: string[] = [];
  if (!s.magicOk) a.push(`MAGIC_BROKEN`);
  if (s.dataLen !== SLAB_LEN) a.push(`DATA_LEN_WRONG=${s.dataLen}`);
  if (s.mode !== 0) a.push(`MODE=Resolved`);
  // Real solvency break: engine thinks it has more tokens than actually exist.
  // (SPL > vault is harmless excess — anyone can transfer wSOL INTO the vault
  // ATA, which is unrecoverable "phantom liquidity" but never drains anything.)
  if (s.vault > s.spl) a.push(`VAULT_UNDERCOLLATERALIZED vault=${s.vault} spl=${s.spl} diff=${s.vault - s.spl}`);
  if (s.vault < s.cTot + s.insurance) a.push(`SOLVENCY_BROKEN vault=${s.vault} cTot+ins=${s.cTot + s.insurance}`);
  if (s.cTot > s.capCeiling) a.push(`TVL_CAP_BYPASSED cTot=${s.cTot} ceiling=${s.capCeiling}`);
  if (!s.adminBurned) a.push(`ADMIN_UNBURNED`);
  if (!s.insuranceAuthBurned) a.push(`INSURANCE_AUTH_UNBURNED`);
  if (!s.insuranceOperBurned) a.push(`INSURANCE_OPER_UNBURNED`);
  if (!s.hyperpAuthBurned) a.push(`HYPERP_AUTH_UNBURNED`);
  if (s.pythAgeSec > 60) a.push(`PYTH_STALE age=${s.pythAgeSec}s`);
  const slotsSinceCrank = BigInt(s.slot) - s.lastMarketSlot;
  if (slotsSinceCrank > permResolveWindow - 10000n) {
    a.push(`PERM_RESOLVE_CLOSE slots_since_accrue=${slotsSinceCrank} window=${permResolveWindow}`);
  }
  return a;
}

async function main() {
  const m = JSON.parse(fs.readFileSync("mainnet-market.json", "utf-8"));
  const slab = new PublicKey(m.slab);
  const oracle = new PublicKey(m.oracle);
  const vault = new PublicKey(m.vault);
  const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

  // Read permissionless-resolve window once (it's immutable).
  const initial = await fetchSlab(conn, slab);
  const cfg = parseConfig(initial);
  const permResolveWindow = cfg.permissionlessResolveStaleSlots;

  console.log(`[${new Date().toISOString()}] START  slab=${slab.toBase58()} poll=${POLL_INTERVAL_MS}ms permResolveWindow=${permResolveWindow}`);

  // Keep a rolling tally of activity
  let lastNumUsed = -1, lastCTot = -1n, lastInsurance = -1n, lastMarketSlot = -1n;
  let iter = 0;

  while (true) {
    iter++;
    try {
      const s = await sample(conn, slab, oracle, vault);
      const anomalies = checkAnomalies(s, permResolveWindow);
      const sol = (x: bigint) => (Number(x) / 1e9).toFixed(4);

      // Activity markers
      const deltas: string[] = [];
      if (lastNumUsed !== -1 && s.numUsed !== lastNumUsed) deltas.push(`numUsed:${lastNumUsed}→${s.numUsed}`);
      if (lastCTot !== -1n && s.cTot !== lastCTot) deltas.push(`cTot:${sol(lastCTot)}→${sol(s.cTot)}`);
      if (lastInsurance !== -1n && s.insurance !== lastInsurance) deltas.push(`insurance:${sol(lastInsurance)}→${sol(s.insurance)}`);
      if (lastMarketSlot !== -1n && s.lastMarketSlot !== lastMarketSlot) deltas.push(`marketSlot:${lastMarketSlot}→${s.lastMarketSlot}`);
      lastNumUsed = s.numUsed; lastCTot = s.cTot; lastInsurance = s.insurance; lastMarketSlot = s.lastMarketSlot;

      const tag = anomalies.length > 0 ? "ALERT" : (deltas.length > 0 ? "ACTIVE" : "ok");
      const deltaStr = deltas.length > 0 ? ` Δ=[${deltas.join(" ")}]` : "";
      const anomalyStr = anomalies.length > 0 ? ` ANOMALY=[${anomalies.join(" ")}]` : "";

      console.log(
        `[${s.iso}] ${tag.padEnd(6)} slot=${s.slot} mode=${s.mode === 0 ? "Live" : "Resolved"} ` +
        `nUsed=${s.numUsed} vault=${sol(s.vault)} cTot=${sol(s.cTot)} ins=${sol(s.insurance)} ` +
        `pyth=$${s.pythPriceUsd.toFixed(2)}/${s.pythAgeSec}s mktAge=${s.slot - Number(s.lastMarketSlot)}sl` +
        deltaStr + anomalyStr
      );
    } catch (e: any) {
      console.log(`[${new Date().toISOString()}] ERROR  ${e.message ?? e}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
