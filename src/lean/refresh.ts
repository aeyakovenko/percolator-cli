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
import { IX, MATCHER_IX, LEAN_DEVNET, LEAN_MAINNET, SIDE, STATUS } from "./constants.js";
import { accountKind, parsePortfolio, parseMarket, openLegs } from "./parsers.js";
import { refreshLeg } from "./instructions.js";

export interface RefreshOptions {
  percolator?: PublicKey;
  matcher?: PublicKey;
}

function refreshTargets(ix: TransactionInstruction, perc: PublicKey, matcher: PublicKey): {
  portfolios: PublicKey[]; settledMarket?: PublicKey;
} {
  const op = ix.data[0];
  const isCore = ix.programId.equals(perc);
  if (isCore && op === IX.Liquidate) {
    const takeoverPortfolio = ix.data[1] === 1 ? ix.keys[7]?.pubkey : undefined;
    return {
      portfolios: takeoverPortfolio ? [takeoverPortfolio] : [],
      settledMarket: ix.keys[1]?.pubkey,
    };
  }
  if ((isCore && (op === IX.Trade || op === IX.WithdrawCollateral || op === IX.TradeWithMatcher)) ||
      (ix.programId.equals(matcher) && (op === MATCHER_IX.Fill || op === MATCHER_IX.WithdrawLp))) {
    return { portfolios: ix.keys.map((key) => key.pubkey) };
  }
  return { portfolios: [] };
}

function inferPrograms(ixs: TransactionInstruction[], opts: RefreshOptions): { perc: PublicKey; matcher: PublicKey } {
  if (opts.percolator && opts.matcher) return { perc: opts.percolator, matcher: opts.matcher };
  const hasMain = ixs.some((ix) => ix.programId.equals(LEAN_MAINNET.percolator) || ix.programId.equals(LEAN_MAINNET.matcher));
  const hasDev = ixs.some((ix) => ix.programId.equals(LEAN_DEVNET.percolator) || ix.programId.equals(LEAN_DEVNET.matcher));
  if (!opts.percolator && hasMain && hasDev) {
    throw new Error("withLegRefresh: ambiguous cluster (both mainnet and devnet program IDs present); pass opts.percolator explicitly");
  }
  const defaults = hasMain && !hasDev ? LEAN_MAINNET : LEAN_DEVNET;
  return {
    perc: opts.percolator ?? defaults.percolator,
    matcher: opts.matcher ?? defaults.matcher,
  };
}

/**
 * Liquidate settles the target market inline for both portfolios. Automatically
 * prepending victim refreshes can abort a bankrupt liquidation, so callers handling
 * a solvent victim should explicitly supply RefreshLeg for its other open legs.
 * Takeovers automatically refresh the liquidator's other open legs.
 */
export async function withLegRefresh(
  conn: Connection, ixs: TransactionInstruction[], opts: RefreshOptions = {},
): Promise<{ instructions: TransactionInstruction[]; added: number }> {
  const { perc, matcher } = inferPrograms(ixs, opts);

  const targets = ixs.map((ix) => refreshTargets(ix, perc, matcher));
  const candidates = new Map<string, PublicKey>();
  for (const { portfolios } of targets) {
    for (const portfolio of portfolios) candidates.set(portfolio.toBase58(), portfolio);
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
  for (const [i, ix] of ixs.entries()) {
    if (ix.programId.equals(perc) && ix.data[0] === IX.RefreshLeg && ix.keys.length >= 3) {
      seen.add(`${ix.keys[1].pubkey.toBase58()}:${ix.keys[2].pubkey.toBase58()}`);
    }
    const { portfolios: portfolioKeys, settledMarket } = targets[i];
    for (const portfolio of portfolioKeys) {
      const p = portfolios.get(portfolio.toBase58());
      if (!p) continue;
      for (const leg of openLegs(p)) {
        if (settledMarket?.equals(leg.market)) continue;
        const tag = `${leg.market.toBase58()}:${portfolio.toBase58()}`;
        if (seen.has(tag)) continue;
        seen.add(tag);
        out.push(refreshLeg(perc, { dex: p.dex, market: leg.market, portfolio }));
        added++;
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
 * Pass opts.percolator for deployments other than the known mainnet and devnet programs.
 */
export async function realizeFlatLegs(
  conn: Connection, portfolio: PublicKey, opts: RefreshOptions = {},
): Promise<TransactionInstruction[]> {
  const info = await conn.getAccountInfo(portfolio, "confirmed");
  if (!info) throw new Error(`portfolio ${portfolio.toBase58()} not found`);
  const perc = opts.percolator ?? [LEAN_MAINNET.percolator, LEAN_DEVNET.percolator].find((p) => p.equals(info.owner));
  if (!perc || !info.owner.equals(perc)) {
    throw new Error(`portfolio ${portfolio.toBase58()} has an unexpected program owner ${info.owner.toBase58()}`);
  }
  const p = parsePortfolio(Buffer.from(info.data));
  const flat = p.legs.filter((l) => l.side === SIDE.FLAT && l.posPnl > 0n);
  if (!flat.length) return [];
  const mkts = await conn.getMultipleAccountsInfo(flat.map((l) => l.market), "confirmed");
  const out: TransactionInstruction[] = [];
  flat.forEach((leg, i) => {
    const m = mkts[i];
    if (!m || !m.owner.equals(perc)) return;
    const status = parseMarket(Buffer.from(m.data)).status;
    if (status === STATUS.ACTIVE || status === STATUS.WINDDOWN) {
      out.push(refreshLeg(perc, { dex: p.dex, market: leg.market, portfolio }));
    }
  });
  return out;
}
