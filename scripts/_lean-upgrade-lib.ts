/** Shared helpers for the DEVNET in-place upgrade proof (percolator-lean 887ba02 -> 8774e86).
 *  DEVNET ONLY: refuses any other cluster, and refuses the shared LEAN_DEVNET program ids. */
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import {
  LEAN_DEVNET, LEAN_MAINNET, GENESIS, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, MAGIC, PflOff, MktOff, InsOff, POS_SCALE,
  parseDex, parseMarket, parsePortfolio, parseInsReceipt, checkDexInvariants, leanErrorName, refreshLeg, openLegs,
  type Market, type Portfolio, type InsReceipt, type Dex,
} from "../src/lean/index.js";
import bs58 from "bs58";

export const HOME = process.env.HOME!;
export const OUT_DIR = process.env.OUT_DIR ?? `${process.cwd()}/.upgrade-out`;
export const MANI_PATH = process.env.LEAN_MANIFEST ?? `${OUT_DIR}/manifest.json`;
export const RPC = `https://devnet.helius-rpc.com/?api-key=${fs.readFileSync(`${HOME}/.helius`, "utf8").replace(/\s/g, "")}`;
/** fetch with retries: devnet RPC has transient "fetch failed" / 429 hiccups that must not abort a long proof run. */
const retryFetch: typeof fetch = async (input: any, init?: any) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(input, init);
      if (r.status === 429 && i < 8) { await new Promise((res) => setTimeout(res, 600 * (i + 1))); continue; }
      return r;
    } catch (e) { if (i >= 8) throw e; await new Promise((res) => setTimeout(res, 600 * (i + 1))); }
  }
};
export const conn = new Connection(RPC, { commitment: "confirmed", fetch: retryFetch as any, disableRetryOnRateLimit: true });
export const mask = (s: string) => s.replace(/api-key=[^&"'\s]+/g, "api-key=***");
export const kpFile = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
export const funder = kpFile(`${HOME}/.config/solana/id.json`);
export const outKp = (name: string) => kpFile(`${OUT_DIR}/${name}-keypair.json`);
/** Load-or-create a named keypair under OUT_DIR (git-ignored by the *-keypair.json rule). */
export function namedKp(name: string): Keypair {
  const p = `${OUT_DIR}/${name}-keypair.json`;
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return kpFile(p);
}
export const PROG = {
  percolator: outKp("percolator").publicKey, matcher: outKp("matcher").publicKey,
  oracleAdapter: outKp("oracle_adapter").publicKey, rewardModule: outKp("reward_module").publicKey,
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const U = (x: bigint) => `${x < 0n ? "-" : ""}${(x < 0n ? -x : x) / POS_SCALE}.${((x < 0n ? -x : x) % POS_SCALE).toString().padStart(6, "0")}`;

export async function guard() {
  const g = await conn.getGenesisHash();
  if (g !== GENESIS.devnet) throw new Error("refusing: not devnet");
  for (const [k, v] of Object.entries(PROG)) {
    for (const set of [LEAN_DEVNET, LEAN_MAINNET]) for (const o of Object.values(set)) if (o.equals(v)) throw new Error(`refusing: ${k} is a shared/live program id`);
  }
}

// ------------------------------------------------------------------ results
export let pass = 0; export const fails: string[] = []; export const notes: string[] = [];
export const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  OK   ${m}`); } else { fails.push(m); console.log(`  FAIL ${m}`); } return c; };
export const note = (m: string) => { notes.push(m); console.log(`  NOTE ${m}`); };

// ------------------------------------------------------------------ tx
let nonce = 1 + (Date.now() % 100000);
const uniq = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: nonce++ });
export const CU = (units = 600_000) => ComputeBudgetProgram.setComputeUnitLimit({ units });
export let lastSig = "";
/** Send for real (funder = fee payer). Throws a masked error on failure. */
export async function send(ixs: TransactionInstruction[], signers: Keypair[] = []): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      const tx = new Transaction().add(uniq(), ...ixs);
      lastSig = await sendAndConfirmTransaction(conn, tx, [funder, ...signers.filter((s) => !s.publicKey.equals(funder.publicKey))], { commitment: "confirmed" });
      // RPC read lag: do not return before the node we read from has reached the slot this tx landed in
      for (let j = 0; j < 40; j++) {
        const st = await conn.getSignatureStatus(lastSig);
        if (st.value?.slot && (await conn.getSlot("confirmed")) > st.value.slot) break;
        await sleep(250);
      }
      return lastSig;
    } catch (e) {
      const m = String((e as Error).message ?? e);
      if (i < 6 && /429|Too Many|block height|Blockhash not found|timed out|fetch failed|ECONNRESET/i.test(m)) { await sleep(1500 * (i + 1)); continue; }
      throw new Error(mask(m));
    }
  }
}
export interface SimResult { ok: boolean; code: number | string | null; name: string; cu: number; ixIndex: number | null; logs: string[] }
/** Simulate WITHOUT signatures (sigVerify off, fresh blockhash): nothing lands. Returns custom code / error + CU. */
export async function sim(ixs: TransactionInstruction[]): Promise<SimResult> {
  for (let i = 0; ; i++) {
    try {
      const tx = new Transaction().add(CU(1_000_000), ...ixs);
      tx.feePayer = funder.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      const r = (await conn.simulateTransaction(tx)).value;
      const cu = r.unitsConsumed ?? 0;
      if (!r.err) return { ok: true, code: null, name: "ok", cu, ixIndex: null, logs: r.logs ?? [] };
      const ie = (r.err as any).InstructionError;
      if (ie && typeof ie[1] === "object" && "Custom" in ie[1]) {
        return { ok: false, code: ie[1].Custom, name: `${ie[1].Custom} ${leanErrorName(ie[1].Custom)}`, cu, ixIndex: ie[0] - 1, logs: r.logs ?? [] };
      }
      return { ok: false, code: JSON.stringify(r.err), name: JSON.stringify(r.err), cu, ixIndex: ie ? ie[0] - 1 : null, logs: r.logs ?? [] };
    } catch (e) {
      const m = String((e as Error).message ?? e);
      if (i < 6 && /429|Too Many|fetch failed|ECONNRESET|timed out/i.test(m)) { await sleep(1500 * (i + 1)); continue; }
      throw new Error(mask(m));
    }
  }
}
export async function cuOf(sig: string): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta) return t.meta.computeUnitsConsumed ?? 0;
    await sleep(500);
  }
  return 0;
}
export async function newAcc(space: number, owner: PublicKey, kp = Keypair.generate()) {
  const lam = await conn.getMinimumBalanceForRentExemption(space);
  await send([SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: kp.publicKey, lamports: lam, space, programId: owner })], [kp]);
  return kp.publicKey;
}
export const acct = async (k: PublicKey) => Buffer.from((await conn.getAccountInfo(k, "confirmed"))!.data);
export const pfl = async (k: PublicKey) => parsePortfolio(await acct(k));
export const mkt = async (k: PublicKey) => parseMarket(await acct(k));
export const tokBal = async (k: PublicKey) => Buffer.from((await conn.getAccountInfo(k, "confirmed"))!.data).readBigUInt64LE(64);

// ------------------------------------------------------------------ manifest
export function loadMani(): any { return JSON.parse(fs.readFileSync(MANI_PATH, "utf8")); }
export function saveMani(m: any) { fs.writeFileSync(MANI_PATH, JSON.stringify(m, null, 2) + "\n"); }

// ------------------------------------------------------------------ same-slot snapshot of the WHOLE dex
const magicFilter = (magic: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(magic, 0); return { memcmp: { offset: 0, bytes: bs58.encode(b) } }; };
export interface Snap {
  slot: number; dex: Dex; spl: bigint; markets: Map<string, Market>; portfolios: Map<string, Portfolio>; receipts: Map<string, InsReceipt>;
  sum: bigint; conserved: boolean; inv: { ok: boolean; problems: string[] };
}
/** Discover every Market / Portfolio / InsReceipt of the DEX (addresses only), then read DEX + SPL vault + all of
 *  them in ONE getMultipleAccountsInfo call (same slot), parse with the CURRENT client and run checkDexInvariants. */
export async function snapshot(P: PublicKey, dexKey: PublicKey, vault: PublicKey): Promise<Snap> {
  const addr = async (size: number, magic: number, off: number) =>
    (await conn.getProgramAccounts(P, { commitment: "confirmed", dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: size }, magicFilter(magic), ...(off >= 0 ? [{ memcmp: { offset: off, bytes: dexKey.toBase58() } }] : [])] })).map((a) => a.pubkey);
  const [mk, pf, rc] = await Promise.all([addr(MARKET_SIZE, MAGIC.MARKET, MktOff.dex), addr(PORTFOLIO_SIZE, MAGIC.PORTFOLIO, PflOff.dex), addr(INS_RECEIPT_SIZE, MAGIC.INSURANCE, -1)]);
  const keys = [dexKey, vault, ...mk, ...pf, ...rc];
  if (keys.length > 100) throw new Error("too many accounts for one getMultipleAccountsInfo");
  const r = await conn.getMultipleAccountsInfoAndContext(keys, "confirmed");
  const v = r.value.map((a) => (a ? Buffer.from(a.data) : null));
  const dex = parseDex(v[0]!); const spl = v[1]!.readBigUInt64LE(64);
  const markets = new Map<string, Market>(), portfolios = new Map<string, Portfolio>(), receipts = new Map<string, InsReceipt>();
  let i = 2;
  for (const k of mk) { const b = v[i++]; if (b && b.length === MARKET_SIZE && b.readUInt32LE(0) === MAGIC.MARKET) markets.set(k.toBase58(), parseMarket(b)); }
  for (const k of pf) { const b = v[i++]; if (b && b.length === PORTFOLIO_SIZE && b.readUInt32LE(0) === MAGIC.PORTFOLIO) portfolios.set(k.toBase58(), parsePortfolio(b)); }
  for (const k of rc) { const b = v[i++]; if (b && b.length === INS_RECEIPT_SIZE && b.readUInt32LE(0) === MAGIC.INSURANCE) { const x = parseInsReceipt(b); if (markets.has(x.market.toBase58())) receipts.set(k.toBase58(), x); } }
  const sum = dex.totalCapital + dex.totalInsurance + dex.totalResidual + dex.totalSurplus + dex.totalRewards;
  const inv = checkDexInvariants(dex, spl, [...markets.values()], [...portfolios.values()], [...receipts.values()]);
  return { slot: r.context.slot, dex, spl, markets, portfolios, receipts, sum, conserved: dex.vaultBalance === spl && spl === sum, inv };
}

/** "Published client" shape: RefreshLeg for every open leg of the given portfolios + the instruction UNCHANGED. */
export async function refreshOnly(P: PublicKey, dexKey: PublicKey, portfolios: PublicKey[], skipMarket?: PublicKey): Promise<TransactionInstruction[]> {
  const out: TransactionInstruction[] = [];
  for (const k of portfolios) for (const leg of openLegs(await pfl(k))) {
    if (skipMarket && leg.market.equals(skipMarket)) continue;
    out.push(refreshLeg(P, { dex: dexKey, market: leg.market, portfolio: k }));
  }
  return out;
}
/** Append read-only trailing accounts to an instruction (hand-rolled, independent of src/lean/refresh.ts). */
export function withTrailing(ix: TransactionInstruction, extra: PublicKey[]): TransactionInstruction {
  const have = new Set(ix.keys.map((k) => k.pubkey.toBase58()));
  const add = extra.filter((e) => !have.has(e.toBase58()) && have.add(e.toBase58()));
  return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: [...ix.keys, ...add.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))] });
}
export async function legMarkets(portfolios: PublicKey[]): Promise<PublicKey[]> {
  const out: PublicKey[] = [];
  for (const k of portfolios) for (const leg of openLegs(await pfl(k))) if (!out.some((o) => o.equals(leg.market))) out.push(leg.market);
  return out;
}
export async function coinbase(pair: string): Promise<bigint> {
  const r: any = await (await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`)).json();
  const px = Math.round(parseFloat(r.data.amount) * 1e6);
  if (!Number.isSafeInteger(px) || px <= 0) throw new Error("bad coinbase price");
  return BigInt(px);
}
