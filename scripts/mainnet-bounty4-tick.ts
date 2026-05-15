/**
 * Bounty 4 cron tick — same architecture as bounty3-tick.ts but reads
 * mainnet-bounty4-market.json (multi-leg composite, hybrid hours-fee mode).
 * 4-second inner loop + adaptive CU + priority backoff. Manifest-driven for
 * the 3 oracle leg accounts.
 *
 * NOTE: This is intentionally a near-clone of mainnet-bounty3-tick.ts to keep
 * the per-bounty cron files self-contained and independently auditable.
 */

import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { encodeKeeperCrank } from "../src/abi/instructions.js";
import { ACCOUNTS_KEEPER_CRANK, buildAccountMetas, WELL_KNOWN } from "../src/abi/accounts.js";
import { buildIx } from "../src/runtime/tx.js";
import { fetchSlab, parseHeader, parseConfig, parseEngine, parseUsedIndices } from "../src/solana/slab.js";

type Snapshot = {
  iso: string; slot: number;
  marketSlot: bigint; marketSlotLag: number;
  numUsed: number; vault: bigint; cTot: bigint; insurance: bigint; spl: bigint;
  lastOraclePrice: bigint; sideModeLong: number; sideModeShort: number;
  rrCursor: bigint; sweepGen: bigint; priceMoveConsumed: bigint;
  conservationOk: boolean; accountingOk: boolean;
};

async function snap(conn: Connection, slab: PublicKey, vault: PublicKey): Promise<Snapshot> {
  const slot = await conn.getSlot("confirmed");
  const buf = await fetchSlab(conn, slab);
  const e = parseEngine(buf);
  const splBal = (await getAccount(conn, vault)).amount;
  return {
    iso: new Date().toISOString(),
    slot,
    marketSlot: e.lastMarketSlot,
    marketSlotLag: slot - Number(e.lastMarketSlot),
    numUsed: parseUsedIndices(buf).length,
    vault: e.vault, cTot: e.cTot, insurance: e.insuranceFund.balance,
    spl: BigInt(splBal),
    lastOraclePrice: e.lastOraclePrice,
    sideModeLong: e.sideModeLong, sideModeShort: e.sideModeShort,
    rrCursor: (e as any).rrCursorPosition ?? 0n,
    sweepGen: (e as any).sweepGeneration ?? 0n,
    priceMoveConsumed: (e as any).priceMoveConsumedBpsThisGeneration ?? 0n,
    conservationOk: e.vault === BigInt(splBal),
    accountingOk: e.vault >= e.cTot + e.insuranceFund.balance,
  };
}

function diff(a: Snapshot, b: Snapshot): { flags: string[]; deltas: any } {
  const flags: string[] = [];
  const deltas: any = {};
  if (b.insurance < a.insurance) flags.push("INSURANCE_DROP");
  if (!b.conservationOk) flags.push("CONSERVATION_BROKEN");
  if (!b.accountingOk) flags.push("ACCOUNTING_BROKEN");
  if (b.marketSlotLag > 600) flags.push(`ACCRUE_LAG(${b.marketSlotLag}sl)`);
  if (b.sideModeLong !== 0 || b.sideModeShort !== 0) flags.push(`SIDE_MODE_NON_NORMAL(L=${b.sideModeLong},S=${b.sideModeShort})`);
  if (b.priceMoveConsumed > 8000n) flags.push(`PRICE_MOVE_SAT(consumed=${b.priceMoveConsumed})`);
  if (b.numUsed > a.numUsed) flags.push(`ACCOUNT_OPENED(+${b.numUsed - a.numUsed})`);
  if (b.numUsed < a.numUsed) flags.push(`ACCOUNT_CLOSED(${a.numUsed - b.numUsed})`);
  if (b.insurance !== a.insurance) deltas.insurance = `${a.insurance > b.insurance ? "-" : "+"}${(a.insurance > b.insurance ? a.insurance - b.insurance : b.insurance - a.insurance)}`;
  if (b.vault !== a.vault) deltas.vault = `${a.vault} → ${b.vault}`;
  if (b.cTot !== a.cTot) deltas.cTot = `${a.cTot} → ${b.cTot}`;
  if (b.lastOraclePrice !== a.lastOraclePrice) deltas.lastOraclePrice = `${a.lastOraclePrice} → ${b.lastOraclePrice}`;
  if (b.sweepGen !== a.sweepGen) deltas.sweep = `cursor:${a.rrCursor}→${b.rrCursor} gen:${a.sweepGen}→${b.sweepGen}`;
  return { flags, deltas };
}

function pickRpc(): Array<{ rpc: string; label: string }> {
  const out: Array<{ rpc: string; label: string }> = [];
  const heliusKey = (() => {
    try { return fs.readFileSync(`${os.homedir()}/.helius`, "utf8").trim(); }
    catch { return null; }
  })();
  if (heliusKey) out.push({ rpc: `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, label: "helius" });
  out.push({ rpc: "https://api.mainnet-beta.solana.com", label: "public" });
  if (process.env.SOLANA_RPC_URL) {
    if (process.env.SOLANA_RPC_URL.includes("devnet")) {
      throw new Error(`refusing devnet RPC for mainnet tick: ${process.env.SOLANA_RPC_URL}`);
    }
    return [{ rpc: process.env.SOLANA_RPC_URL, label: "env" }];
  }
  return out;
}

async function main() {
  const cwd = process.env.PERCOLATOR_DIR ?? path.dirname(new URL(import.meta.url).pathname);
  process.chdir(cwd);
  const m = JSON.parse(fs.readFileSync("mainnet-bounty4-market.json", "utf-8"));
  const programId = new PublicKey(m.programId);
  const slab = new PublicKey(m.slab);
  const vault = new PublicKey(m.vault);
  const oracle = new PublicKey(m.oracle);
  const oracleLegs: PublicKey[] = [oracle];
  if (m.oracleLeg2) oracleLegs.push(new PublicKey(m.oracleLeg2));
  if (m.oracleLeg3) oracleLegs.push(new PublicKey(m.oracleLeg3));

  const rpcs = pickRpc();
  let conn: Connection | null = null;
  let rpcLabel = "";
  for (const r of rpcs) {
    try {
      const c = new Connection(r.rpc, "confirmed");
      await c.getLatestBlockhash("processed");
      conn = c; rpcLabel = r.label;
      break;
    } catch (_) { /* try next */ }
  }
  if (!conn) throw new Error(`all RPCs failed: ${rpcs.map(r => r.label).join(",")}`);

  const payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
    fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8")
  )));

  const logDir = path.join(os.homedir(), ".cache", "percolator");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "bounty4-tick.log");
  const log = (obj: any) => fs.appendFileSync(logPath, JSON.stringify(obj) + "\n");

  let pre: Snapshot | undefined;
  try {
    pre = await snap(conn, slab, vault);
  } catch (e: any) {
    log({ iso: new Date().toISOString(), event: "PRE_SNAP_ERR", err: String(e).slice(0, 200) });
    return;
  }

  const LOOP_DEADLINE_MS = 48_000;
  const ROUND_INTERVAL_MS = 4_000;
  const N_HARD_CAP = 9;
  const CU_CEILING = 1_400_000;
  const PRIORITY_FLOOR = 1;
  const PRIORITY_CEIL = 100_000;

  function estimateCu(n: number, marketMode: number, oiAny: boolean, lag: number, oracleLegCount: number = 1): number {
    if (n < 1) n = 1;
    const BASE = 60_000;
    let perCrankCost: number[];
    if (marketMode === 1) perCrankCost = Array(n).fill(15_000);
    else if (!oiAny || lag <= 10) perCrankCost = Array(n).fill(95_000 + 60_000 * (oracleLegCount - 1));
    else {
      perCrankCost = [];
      for (let k = 0; k < n; k++) {
        if (k === 0) perCrankCost.push(460_000);
        else if (k === 1) perCrankCost.push(420_000);
        else perCrankCost.push(95_000);
      }
    }
    const sum = perCrankCost.reduce((a, b) => a + b, 0);
    return Math.min(CU_CEILING, Math.max(20_000, Math.ceil((BASE + sum) * 1.15)));
  }

  const cuStatePath = path.join(os.homedir(), ".cache", "percolator", "bounty4-cu.json");
  let nMax = N_HARD_CAP;
  let priorityMicroLamports = PRIORITY_FLOOR;
  let lastTickLag = pre.marketSlotLag;
  try {
    const s = JSON.parse(fs.readFileSync(cuStatePath, "utf8"));
    if (typeof s.nMax === "number") nMax = Math.max(1, Math.min(N_HARD_CAP, s.nMax));
    if (typeof s.priorityMicroLamports === "number") {
      priorityMicroLamports = Math.max(PRIORITY_FLOOR, Math.min(PRIORITY_CEIL, s.priorityMicroLamports));
    }
    if (typeof s.lastTickLag === "number") lastTickLag = s.lastTickLag;
  } catch { /* first run */ }

  if (pre.marketSlotLag > lastTickLag + 50) {
    priorityMicroLamports = Math.min(PRIORITY_CEIL, priorityMicroLamports * 2);
  } else if (pre.marketSlotLag <= lastTickLag) {
    priorityMicroLamports = Math.max(PRIORITY_FLOOR, Math.floor(priorityMicroLamports / 2));
  }

  type RoundResult = {
    iso: string; lagBefore: number; n: number; cuLimit: number;
    sig: string | null; err: string | null; cuConsumed: number | null; oom: boolean;
  };
  const rounds: RoundResult[] = [];

  const buildCrankTx = (n: number, cuLimit: number, prio: number) => {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }))
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: prio }));
    const baseKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      payer.publicKey, slab, WELL_KNOWN.clock, oracleLegs[0],
    ]);
    const extra = oracleLegs.slice(1).map(pk => ({ pubkey: pk, isSigner: false, isWritable: false }));
    const keys = [...baseKeys, ...extra];
    for (let k = 0; k < n; k++) {
      tx.add(buildIx({ programId, keys, data: encodeKeeperCrank({ callerIdx: 65535, candidates: [] }) }));
    }
    return tx;
  };

  const start = Date.now();
  let firstLag = pre.marketSlotLag;
  let lastLag = pre.marketSlotLag;

  while (Date.now() - start < LOOP_DEADLINE_MS) {
    const roundStart = Date.now();
    let lagNow = lastLag;
    let marketMode = 0;
    let oiAny = true;
    try {
      const slot = await conn.getSlot("processed");
      const buf = await fetchSlab(conn, slab);
      const eNow = parseEngine(buf);
      lagNow = slot - Number(eNow.lastMarketSlot);
      lastLag = lagNow;
      marketMode = eNow.marketMode;
      const oiL = (eNow as any).oiEffLongQ ?? 0n;
      const oiS = (eNow as any).oiEffShortQ ?? 0n;
      oiAny = (typeof oiL === "bigint" ? oiL : BigInt(oiL)) !== 0n
           || (typeof oiS === "bigint" ? oiS : BigInt(oiS)) !== 0n;
    } catch (_) { /* keep last */ }

    const segmentsNeeded = Math.max(1, Math.ceil(lagNow / 10));
    const n = Math.max(1, Math.min(nMax, segmentsNeeded));
    const cuLimit = estimateCu(n, marketMode, oiAny, lagNow, oracleLegs.length);

    let sig: string | null = null;
    let err: string | null = null;
    let oom = false;

    try {
      const tx = buildCrankTx(n, cuLimit, priorityMicroLamports);
      const { blockhash } = await conn.getLatestBlockhash("processed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer);
      sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: true, preflightCommitment: "processed",
      });
    } catch (e: any) {
      err = (e.message || String(e)).split("\n")[0].slice(0, 200);
    }

    rounds.push({
      iso: new Date().toISOString(), lagBefore: lagNow, n, cuLimit,
      sig, err: err ? err.slice(0, 120) : null, cuConsumed: null, oom,
    });

    const elapsed = Date.now() - roundStart;
    const sleepMs = ROUND_INTERVAL_MS - elapsed;
    if (sleepMs > 0 && Date.now() - start + sleepMs < LOOP_DEADLINE_MS) {
      await new Promise(r => setTimeout(r, sleepMs));
    }
  }

  // End-of-tick OOM sampling
  const sigsToCheck = rounds.filter(r => r.sig).map(r => r.sig!);
  let oomCount = 0;
  if (sigsToCheck.length > 0) {
    try {
      const sample = sigsToCheck.slice(-4);
      const full = await conn.getSignatureStatuses(sample, { searchTransactionHistory: false });
      for (let i = 0; i < sample.length; i++) {
        const s = full.value[i];
        if (s?.err) {
          try {
            const info = await conn.getTransaction(sample[i], { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
            const logs = info?.meta?.logMessages?.slice(-3).join("|") ?? "";
            if (logs.includes("exceeded CUs")) { oomCount++; rounds[rounds.length - sample.length + i]!.oom = true; }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }
  let nextNMax = nMax;
  if (oomCount > 0) nextNMax = Math.max(1, nMax - 3);
  try {
    fs.writeFileSync(cuStatePath, JSON.stringify({
      nMax: nextNMax, priorityMicroLamports, lastTickLag: lastLag,
      lastTickIso: new Date().toISOString(),
    }));
  } catch {}

  let post: Snapshot | undefined;
  try {
    post = await snap(conn, slab, vault);
  } catch (e: any) {
    log({ iso: new Date().toISOString(), event: "POST_SNAP_ERR", rounds: rounds.length, err: String(e).slice(0, 200) });
    return;
  }

  const { flags, deltas } = diff(pre, post);
  const failed = rounds.filter(r => r.err).length;
  log({
    iso: post.iso, slot: post.slot, rpc: rpcLabel,
    marketSlotLag: post.marketSlotLag, lagBefore: firstLag,
    rounds: rounds.length, crankOk: rounds.length - failed, crankFail: failed,
    cuSpentLamports: rounds.reduce((s, r) =>
      s + Math.ceil(r.cuLimit * priorityMicroLamports / 1_000_000) + 5_000, 0),
    priorityMicroLamports,
    lastCrank: rounds[rounds.length - 1]?.sig?.slice(0, 16) ?? null,
    lastErr: rounds.findLast?.(r => r.err)?.err ?? null,
    nMax: nextNMax,
    flags, deltas,
    state: {
      numUsed: post.numUsed, vault: post.vault.toString(), cTot: post.cTot.toString(),
      insurance: post.insurance.toString(), lastOraclePrice: post.lastOraclePrice.toString(),
    },
  });
}

main().catch(e => {
  const logDir = path.join(os.homedir(), ".cache", "percolator");
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  try {
    fs.appendFileSync(path.join(logDir, "bounty4-tick.log"),
      JSON.stringify({ iso: new Date().toISOString(), event: "FATAL", err: String(e).slice(0, 300) }) + "\n");
  } catch {}
  process.exit(0);
});
