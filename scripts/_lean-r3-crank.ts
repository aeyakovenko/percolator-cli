/** Lazy BTC oracle keeper for the mainnet round-3 bounty. Reads Coinbase BTC/USD and pushes it to
 *  the market's pushed oracle via UpdateOracle — ONLY when the oracle is within 1/3 of its staleness
 *  window of expiring (minimal SOL). Clamped by `m.maxMoveBps` (halved on `dt == 1` per 71d38f0).
 *  `lazy` arg = skip if fresh. */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { updateOracle, parseMarket, BPS_DEN, MAX_PRICE } from "../src/lean/index.js";
import { sendIdempotent, isDirectEntrypoint } from "./_lean-r3-reward-bid.js";

const u = (n: bigint) => (Number(n) / 1e6).toFixed(2);

/**
 * Clamp `target` within on-chain `handleUpdateOracle` bounds (percolator-lean `71d38f0`):
 * - Empty markets (`!hasOpenState`: `OI == 0 && rawBasis == 0`) fast-snap directly to `target`
 *   (clamped only to valid on-chain price bounds `[1, MAX_PRICE]`) with zero funding.
 * - Loaded markets (`hasOpenState`): consecutive-slot updates (`slotGap <= 1`) use half-step
 *   pacing (`maxMoveBps >> 1`); `slotGap >= 2` uses full `maxMoveBps`.
 */
export function computeClampedPush(
  markPrice: bigint,
  target: bigint,
  maxMoveBps: bigint,
  opts: { slotGap?: bigint; hasOpenState?: boolean } = {},
): bigint {
  const hasOpenState = opts.hasOpenState ?? true;
  if (!hasOpenState) {
    if (target < 1n) return 1n;
    return target > MAX_PRICE ? MAX_PRICE : target;
  }
  const slotGap = opts.slotGap ?? 2n;
  const effBps = slotGap <= 1n && maxMoveBps > 1n ? maxMoveBps >> 1n : maxMoveBps;
  const maxAllowed = (markPrice * effBps) / BPS_DEN;
  const maxUp = markPrice + maxAllowed;
  const maxDn = markPrice > maxAllowed ? markPrice - maxAllowed : 1n;
  if (target > maxUp) return maxUp;
  if (target < maxDn) return maxDn;
  return target > 0n ? target : 1n;
}

async function btc(): Promise<bigint> {
  const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  if (!r.ok) throw new Error(`coinbase BTC/USD HTTP ${r.status}`);
  const j: any = await r.json();
  const px = parseFloat(j?.data?.amount);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`invalid BTC/USD price: ${j?.data?.amount}`);
  return BigInt(Math.round(px * 1e6));
}

export async function crankOracleOnce(
  conn: Connection,
  p: {
    percolator: PublicKey;
    market: PublicKey;
    funder: Keypair;
    oracle: Keypair;
    lazy: boolean;
    fetchPrice?: () => Promise<bigint>;
    retryDelayMs?: number;
  },
): Promise<{ status: "skipped" | "pushed"; markPrice?: bigint; push?: bigint; target?: bigint; age?: bigint; sig?: string | null }> {
  const fetchPrice = p.fetchPrice ?? btc;
  const readMarket = async () => {
    const res = await conn.getAccountInfoAndContext(p.market, "confirmed");
    if (!res.value) throw new Error(`market ${p.market.toBase58()} not found`);
    const m = parseMarket(Buffer.from(res.value.data));
    const slot = BigInt(res.context.slot);
    const age = slot >= m.lastOracleSlot ? slot - m.lastOracleSlot : 0n;
    return { m, slot, age };
  };

  const initial = await readMarket();
  if (initial.m.statusName !== "Active") {
    console.log(`market ${initial.m.statusName}; skip`);
    return { status: "skipped" };
  }
  if (p.lazy && initial.age < initial.m.maxStaleness / 3n) {
    console.log(`fresh: age=${initial.age}/${initial.m.maxStaleness} (< ${initial.m.maxStaleness / 3n}); skip`);
    return { status: "skipped", age: initial.age };
  }

  let curMark = initial.m.markPrice;
  let curAge = initial.age;
  let curTarget = await fetchPrice();
  const buildPushIx = (m: typeof initial.m, age: bigint, target: bigint) => {
    const hasOpenState = m.oiLong > 0n || m.oiShort > 0n || m.rawBasisLong > 0n || m.rawBasisShort > 0n;
    const push = computeClampedPush(m.markPrice, target, m.maxMoveBps, { slotGap: age, hasOpenState });
    return { push, ix: updateOracle(p.percolator, { market: p.market, oracleAuth: p.oracle.publicKey, price: push }) };
  };
  let built = buildPushIx(initial.m, initial.age, curTarget);

  const sig = await sendIdempotent(
    conn,
    [built.ix],
    [p.funder, p.oracle],
    {
      alreadyLanded: async () => {
        const info = await conn.getAccountInfo(p.market, "confirmed");
        return !!info && parseMarket(Buffer.from(info.data)).lastOracleSlot > initial.m.lastOracleSlot;
      },
      // Only invoked AFTER the previous signed tx's blockhash expires without landing:
      // re-read live market + slot + spot price instead of re-signing a stale observation.
      refreshIxs: async () => {
        const latest = await readMarket();
        if (latest.m.statusName !== "Active" || latest.m.lastOracleSlot > initial.m.lastOracleSlot) return null;
        if (p.lazy && latest.age < latest.m.maxStaleness / 3n) return null;
        curMark = latest.m.markPrice;
        curAge = latest.age;
        curTarget = await fetchPrice();
        built = buildPushIx(latest.m, latest.age, curTarget);
        return [built.ix];
      },
      retryDelayMs: p.retryDelayMs ?? 1500,
    },
  );
  console.log(`cranked BTC: mark $${u(curMark)} -> $${u(built.push)} (target $${u(curTarget)}, age ${curAge}) ${(sig ?? "already-landed").slice(0, 12)}…`);
  return { status: "pushed", markPrice: curMark, push: built.push, target: curTarget, age: curAge, sig };
}

async function main() {
  const mani = JSON.parse(fs.readFileSync(`${process.env.HOME}/percolator-cli/lean-mainnet-r3.json`, "utf8"));
  const key = fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").trim();
  const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, "confirmed");
  const P = new PublicKey(mani.percolator);
  const MARKET = new PublicKey(mani.market);
  const oracle = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/lean-mainnet-r3-oracle.json`, "utf8"))));
  const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
  await crankOracleOnce(conn, {
    percolator: P,
    market: MARKET,
    funder,
    oracle,
    lazy: process.argv.includes("lazy"),
  });
}

if (isDirectEntrypoint(import.meta.url)) {
  main().catch(e => { console.error(String(e).slice(0, 200)); process.exit(1); });
}
