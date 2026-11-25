/**
 * Same-slot leg freshness helper.
 *
 * percolator-lean `Trade` (open) and `WithdrawCollateral` — and the matcher's `Fill` /
 * `WithdrawLp`, which CPI into them — reject with `stalePortfolioLeg` (122) unless every
 * open leg of each portfolio involved was refreshed in the *current slot*. On a real
 * cluster that means bundling `RefreshLeg` for each open leg into the same transaction.
 *
 * `withLegRefresh` takes the instructions you want to send and returns them with the
 * required RefreshLeg instructions inserted immediately before each instruction that
 * needs them (skipping legs already refreshed earlier in the same list).
 *
 * Only legs that are active AND non-flat are refreshed — exactly what the program
 * checks. Flat legs that still carry posPnl (e.g. on a resolved market) are left
 * alone; refreshing those could fail and take the whole transaction down.
 */
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { IX, MATCHER_IX, LEAN_DEVNET, SIDE, STATUS } from "./constants.js";
import { accountKind, parsePortfolio, parseMarket, openLegs } from "./parsers.js";
import { refreshLeg } from "./instructions.js";

export interface RefreshOptions {
  percolator?: PublicKey;
  matcher?: PublicKey;
}

function needsFreshLegs(ix: TransactionInstruction, perc: PublicKey, matcher: PublicKey): boolean {
  const op = ix.data[0];
  if (ix.programId.equals(perc)) return op === IX.Trade || op === IX.WithdrawCollateral;
  if (ix.programId.equals(matcher)) return op === MATCHER_IX.Fill || op === MATCHER_IX.WithdrawLp;
  return false;
}

export async function withLegRefresh(
  conn: Connection, ixs: TransactionInstruction[], opts: RefreshOptions = {},
): Promise<{ instructions: TransactionInstruction[]; added: number }> {
  const perc = opts.percolator ?? LEAN_DEVNET.percolator;
  const matcher = opts.matcher ?? LEAN_DEVNET.matcher;

  const candidates = new Map<string, PublicKey>();
  for (const ix of ixs) {
    if (!needsFreshLegs(ix, perc, matcher)) continue;
    for (const k of ix.keys) candidates.set(k.pubkey.toBase58(), k.pubkey);
  }
  const keys = [...candidates.values()];
  const infos = keys.length ? await conn.getMultipleAccountsInfo(keys, "confirmed") : [];
  const portfolios = new Map<string, ReturnType<typeof parsePortfolio>>();
  infos.forEach((info, i) => {
    if (!info || !info.owner.equals(perc)) return;
    const b = Buffer.from(info.data);
    if (accountKind(b) === "portfolio") portfolios.set(keys[i].toBase58(), parsePortfolio(b));
  });

  const seen = new Set<string>(); // `${market}:${portfolio}`
  const out: TransactionInstruction[] = [];
  let added = 0;
  for (const ix of ixs) {
    if (ix.programId.equals(perc) && ix.data[0] === IX.RefreshLeg && ix.keys.length >= 3) {
      seen.add(`${ix.keys[1].pubkey.toBase58()}:${ix.keys[2].pubkey.toBase58()}`);
    }
    if (needsFreshLegs(ix, perc, matcher)) {
      for (const k of ix.keys) {
        const p = portfolios.get(k.pubkey.toBase58());
        if (!p) continue;
        for (const leg of openLegs(p)) {
          const tag = `${leg.market.toBase58()}:${k.pubkey.toBase58()}`;
          if (seen.has(tag)) continue;
          seen.add(tag);
          out.push(refreshLeg(perc, { dex: p.dex, market: leg.market, portfolio: k.pubkey }));
          added++;
        }
      }
    }
    out.push(ix);
  }
  return { instructions: out, added };
}

/**
 * Closing a position settles the long before the short, so the winner's profit can be
 * left as `posPnl` on a now-FLAT leg (the loser's loss hadn't reached R_m yet). That leg
 * stays active, keeps `legCount > 0`, and blocks CloseAccount until a RefreshLeg pays it
 * out. This returns RefreshLeg ixs for every flat leg with posPnl > 0 whose market is
 * still Active/WindDown (RefreshLeg rejects Resolved/Tombstoned — use ClaimResolved there).
 */
export async function realizeFlatLegs(
  conn: Connection, portfolio: PublicKey, opts: RefreshOptions = {},
): Promise<TransactionInstruction[]> {
  const perc = opts.percolator ?? LEAN_DEVNET.percolator;
  const info = await conn.getAccountInfo(portfolio, "confirmed");
  if (!info) throw new Error(`portfolio ${portfolio.toBase58()} not found`);
  const p = parsePortfolio(Buffer.from(info.data));
  const flat = p.legs.filter((l) => l.side === SIDE.FLAT && l.posPnl > 0n);
  if (!flat.length) return [];
  const mkts = await conn.getMultipleAccountsInfo(flat.map((l) => l.market), "confirmed");
  const out: TransactionInstruction[] = [];
  flat.forEach((leg, i) => {
    const m = mkts[i];
    if (!m) return;
    const status = parseMarket(Buffer.from(m.data)).status;
    if (status === STATUS.ACTIVE || status === STATUS.WINDDOWN) {
      out.push(refreshLeg(perc, { dex: p.dex, market: leg.market, portfolio }));
    }
  });
  return out;
}
