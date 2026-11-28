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
 * `TradeWithMatcher` (op 23): the LP portfolio's legs are refreshed too, so a taker can trade against a
 * multi-market PropAMM LP without knowing the LP's current inventory. In addition the Market account of
 * every refreshed leg that is not one of the traded markets is appended to the instruction as a trailing
 * read-only account. The deployed 887ba02 program does not need them (proven harmless on devnet: the first
 * is just forwarded to the matcher as its ignored `extraAcc`), but the next program revision (uncommitted
 * percolator-lean working tree at the time of writing: `verifyLegMktFresh`) looks every open leg's Market
 * up among the instruction's accounts and rejects with stalePortfolioLeg (122) when it is missing.
 *
 * Only legs that are active AND non-flat are refreshed — exactly what the program
 * checks. Flat legs that still carry posPnl (e.g. on a resolved market) are left
 * alone; refreshing those could fail and take the whole transaction down.
 */
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { IX, MATCHER_IX, LEAN_DEVNET, LEAN_MAINNET, SIDE, STATUS } from "./constants.js";
import { accountKind, parsePortfolio, parseMarket, openLegs } from "./parsers.js";
import { refreshLeg, tradeWithMatcher } from "./instructions.js";

export interface RefreshOptions {
  percolator?: PublicKey;
  matcher?: PublicKey;
}

function needsFreshLegs(ix: TransactionInstruction, perc: PublicKey, matcher: PublicKey): boolean {
  const op = ix.data[0];
  if (ix.programId.equals(perc)) {
    return op === IX.Trade || op === IX.WithdrawCollateral || op === IX.Liquidate || op === IX.TradeWithMatcher;
  }
  if (ix.programId.equals(matcher)) return op === MATCHER_IX.Fill || op === MATCHER_IX.WithdrawLp;
  return false;
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

export async function withLegRefresh(
  conn: Connection, ixs: TransactionInstruction[], opts: RefreshOptions = {},
): Promise<{ instructions: TransactionInstruction[]; added: number }> {
  const { perc, matcher } = inferPrograms(ixs, opts);

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
  for (const ixIn of ixs) {
    let ix = ixIn;
    if (ix.programId.equals(perc) && ix.data[0] === IX.RefreshLeg && ix.keys.length >= 3) {
      seen.add(`${ix.keys[1].pubkey.toBase58()}:${ix.keys[2].pubkey.toBase58()}`);
    }
    if (needsFreshLegs(ix, perc, matcher)) {
      const isLiquidate = ix.programId.equals(perc) && ix.data[0] === IX.Liquidate;
      if (isLiquidate) {
        // Never auto-refresh the liquidated victim portfolio: `handleLiquidate` settles the
        // target leg itself (with `allowBankrupt = true`), and calling `RefreshLeg` on a bankrupt
        // leg rejects with `insufficientMargin` (107). Callers may supply explicit `RefreshLeg`
        // instructions beforehand for other legs of a solvent multi-leg victim.
        // For mode=1 takeovers (`keys[7]` = liqPortfolio), refresh only the liquidator's OTHER
        // open legs (excluding the target market `keys[1]`, which `handleLiquidate` settles).
        const isTakeover = ix.data.length >= 2 && ix.data[1] === 1 && ix.keys.length >= 8;
        const targetMkt = ix.keys[1]?.pubkey;
        if (isTakeover && targetMkt) {
          const liqPflKey = ix.keys[7].pubkey;
          const liqPfl = portfolios.get(liqPflKey.toBase58());
          if (liqPfl) {
            for (const leg of openLegs(liqPfl)) {
              if (leg.market.equals(targetMkt)) continue;
              const tag = `${leg.market.toBase58()}:${liqPflKey.toBase58()}`;
              if (seen.has(tag)) continue;
              seen.add(tag);
              out.push(refreshLeg(perc, { dex: liqPfl.dex, market: leg.market, portfolio: liqPflKey }));
              added++;
            }
          }
        }
      } else {
        // TradeWithMatcher: also carry every open leg's Market IN the instruction (forward-compat, see header).
        const isMatcherTrade = ix.programId.equals(perc) && ix.data[0] === IX.TradeWithMatcher;
        const present = new Set(ix.keys.map((k) => k.pubkey.toBase58()));
        const trailing: PublicKey[] = [];
        for (const k of ix.keys) {
          const p = portfolios.get(k.pubkey.toBase58());
          if (!p) continue;
          for (const leg of openLegs(p)) {
            if (isMatcherTrade && !present.has(leg.market.toBase58())) {
              present.add(leg.market.toBase58());
              trailing.push(leg.market);
            }
            const tag = `${leg.market.toBase58()}:${k.pubkey.toBase58()}`;
            if (seen.has(tag)) continue;
            seen.add(tag);
            out.push(refreshLeg(perc, { dex: p.dex, market: leg.market, portfolio: k.pubkey }));
            added++;
          }
        }
        if (trailing.length) {
          ix = new TransactionInstruction({
            programId: ix.programId, data: ix.data,
            keys: [...ix.keys, ...trailing.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))],
          });
        }
      }
    }
    out.push(ix);
  }
  return { instructions: out, added };
}

/**
 * ONE-CALL builder for a taker trade against a matcher-bound LP portfolio (e.g. the PropAMM passive vault):
 * returns `[RefreshLeg..., TradeWithMatcher]` ready to put in a single transaction signed by the taker only.
 * It reads the taker and LP portfolios and prepends a RefreshLeg for every open leg of BOTH (the program rejects
 * with stalePortfolioLeg 122 if any other open leg of either was not refreshed in the same slot — the LP almost
 * always holds inventory from earlier fills). Build it right before sending: the leg set is a snapshot, and if
 * another fill changes the LP's legs in between, rebuild and retry.
 * NOT covered here: the market's oracle must be fresh (age <= maxStaleness, else oracleStale 106) — push/crank the
 * oracle first — and the PropAMM refuses to quote for 150 slots after a saturated oracle ramp tick (200).
 */
export async function tradeWithMatcherFresh(
  conn: Connection, percolator: PublicKey, args: Parameters<typeof tradeWithMatcher>[1],
): Promise<TransactionInstruction[]> {
  const { instructions } = await withLegRefresh(conn, [tradeWithMatcher(percolator, args)], { percolator, matcher: args.matcherProgram });
  return instructions;
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
  const info = await conn.getAccountInfo(portfolio, "confirmed");
  if (!info) throw new Error(`portfolio ${portfolio.toBase58()} not found`);
  const perc = opts.percolator ?? info.owner;
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
