/**
 * ROUND-5 vault ADAPTER — the ONE place every round-5 script touches the AMM matcher.
 *
 * The next program version (percolator-lean 8774e86) replaces the PropAMM matcher with an always-on
 * `OracleAmmMatcher` (Avellaneda-Stoikov quoting off the live feed + confidence, reads the LP's live
 * inventory, hard leverage cap) deployed to SEPARATE devnet program ids. Its taker also passes the LP
 * portfolio and the markets of the taker's other legs as trailing accounts. To let a second pass swap
 * PropAMM -> OracleAmmMatcher WITHOUT rewriting the setup / normal-ops / attack catalogue, every
 * AMM-specific detail lives behind the `VaultAdapter` interface here:
 *   (a) ctx creation + init,   (b) binding the ctx to the LP portfolio,
 *   (c) quote PREDICTION,      (d) which accounts/instructions a taker fill carries.
 * The scripts call the adapter; swapping vaults is a one-line `const vault = oracleAmmVault(...)`.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  PROP_CTX_SIZE, TRADE_MODE, MAX_LEGS,
  propAmmInit, propAmmUpdate, setPortfolioMatcher, tradeWithMatcher, propAmmQuote, propAmmQuoteIx, parsePropAmmCtx,
  withLegRefresh,
} from "../src/lean/index.js";

export interface VaultParams { halfSpreadBps: bigint; impactBps: bigint; maxFillQty: bigint; paused?: boolean }
/** One market leg of a taker request (superset of what every matcher needs to quote + settle). */
export interface VaultLeg {
  market: PublicKey; marketId: bigint; mode: number; takerIsLong: boolean; maxQty: bigint; limitPrice?: bigint;
  markPrice: bigint; maxMoveBps: bigint; isRamping?: boolean;
}
export interface QuotePrediction { isBuy: boolean; execPrice: bigint; fillQty: bigint; effBps: bigint }
/** Live ctx state the prediction needs (whatever shape the concrete matcher stores). */
export interface VaultCtxView { halfSpreadBps: bigint; impactBps: bigint; maxFillQty: bigint; paused: boolean; allowedMarkets: bigint[]; seq: bigint }

export interface VaultAdapter {
  readonly name: string;
  readonly matcherProgram: PublicKey;
  readonly ctxSize: number;
  /** create (System, paid by `payer`) + init the ctx in ONE tx (init is first-come on a fresh ctx). Caller sends it. */
  initCtxIxs(a: { ctx: PublicKey; owner: PublicKey; payer: PublicKey; rentLamports: bigint; params: VaultParams; allowedMarketIds: bigint[] }): TransactionInstruction[];
  /** owner-gated param update (paused/spread/impact/maxFill). */
  updateCtxIx(a: { ctx: PublicKey; owner: PublicKey; params: VaultParams }): TransactionInstruction;
  /** bind the ctx to the LP portfolio (percolator op). */
  bindIx(a: { percolator: PublicKey; portfolio: PublicKey; owner: PublicKey; ctx: PublicKey }): TransactionInstruction;
  /** read the live ctx params for prediction. */
  readCtx(conn: Connection, ctx: PublicKey): Promise<VaultCtxView>;
  /** off-chain prediction of exec price / fill qty per leg (must match what the fill settles at). */
  predict(ctx: VaultCtxView, legs: VaultLeg[]): QuotePrediction[];
  /** on-chain quote via simulation (0-signer entrypoint): returns the exec price the matcher writes, or null. `payer` only pays sim fees. */
  simulateQuote(conn: Connection, ctx: PublicKey, view: VaultCtxView, legs: VaultLeg[], payer: Keypair): Promise<bigint | null>;
  /** a ready-to-send (leg-refreshed) single-signer taker fill against the LP portfolio. */
  takerFill(conn: Connection, a: { percolator: PublicKey; dex: PublicKey; taker: PublicKey; takerPortfolio: PublicKey; lpPortfolio: PublicKey; ctx: PublicKey; legs: VaultLeg[] }): Promise<TransactionInstruction[]>;
  /** the raw (un-refreshed) taker fill instruction — for attacks that deliberately omit refresh / substitute accounts. */
  rawTakerFill(a: { percolator: PublicKey; dex: PublicKey; taker: PublicKey; takerPortfolio: PublicKey; lpPortfolio: PublicKey; ctx: PublicKey; legs: VaultLeg[]; matcherProgram?: PublicKey; matcherCtx?: PublicKey }): TransactionInstruction;
}

/** PropAMM (percolator-lean 887ba02) implementation of the vault adapter. */
export function propAmmVault(matcherProgram: PublicKey): VaultAdapter {
  const legOf = (l: VaultLeg) => ({ market: l.market, mode: l.mode, takerIsLong: l.takerIsLong, maxQty: l.maxQty, limitPrice: l.limitPrice });
  return {
    name: "PropAMM(887ba02)",
    matcherProgram,
    ctxSize: PROP_CTX_SIZE,
    initCtxIxs(a) {
      return [
        SystemProgram.createAccount({ fromPubkey: a.payer, newAccountPubkey: a.ctx, lamports: Number(a.rentLamports), space: PROP_CTX_SIZE, programId: matcherProgram }),
        propAmmInit(matcherProgram, { ctx: a.ctx, owner: a.owner, halfSpreadBps: a.params.halfSpreadBps, impactBps: a.params.impactBps, maxFillQty: a.params.maxFillQty, paused: a.params.paused, allowedMarketIds: a.allowedMarketIds }),
      ];
    },
    updateCtxIx(a) {
      return propAmmUpdate(matcherProgram, { ctx: a.ctx, owner: a.owner, halfSpreadBps: a.params.halfSpreadBps, impactBps: a.params.impactBps, maxFillQty: a.params.maxFillQty, paused: a.params.paused });
    },
    bindIx(a) {
      return setPortfolioMatcher(a.percolator, { portfolio: a.portfolio, owner: a.owner, matcherCtx: a.ctx });
    },
    async readCtx(conn, ctx) {
      const c = parsePropAmmCtx(Buffer.from((await conn.getAccountInfo(ctx, "confirmed"))!.data));
      return { halfSpreadBps: c.halfSpreadBps, impactBps: c.impactBps, maxFillQty: c.maxFillQty, paused: c.paused, allowedMarkets: c.allowedMarkets, seq: c.seq };
    },
    predict(ctx, legs) {
      return propAmmQuote({ halfSpreadBps: ctx.halfSpreadBps, impactBps: ctx.impactBps, maxFillQty: ctx.maxFillQty, paused: ctx.paused, allowedMarkets: ctx.allowedMarkets },
        legs.map((l) => ({ marketId: l.marketId, mode: l.mode, takerIsLong: l.takerIsLong, maxQty: l.maxQty, markPrice: l.markPrice, maxMoveBps: l.maxMoveBps, isRamping: l.isRamping })))
        .map((q) => ({ isBuy: q.isBuy, execPrice: q.execPrice, fillQty: q.fillQty, effBps: q.effBps }));
    },
    async simulateQuote(conn, ctx, view, legs, payer) {
      const tx = new Transaction().add(propAmmQuoteIx(matcherProgram, { ctx, seq: view.seq + 1n, lpCapital: 0n, slot: 0n,
        offers: legs.map((l) => ({ mode: l.mode, takerIsLong: l.takerIsLong, marketId: l.marketId, maxQty: l.maxQty, limitPrice: l.limitPrice, markPrice: l.markPrice, maxMoveBps: l.maxMoveBps, isRamping: l.isRamping })) }));
      tx.feePayer = payer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; tx.sign(payer);
      const sim = await conn.simulateTransaction(tx, undefined, [ctx]);
      const acc = sim.value.accounts?.[0];
      if (!acc || sim.value.err) return null;
      const data = Array.isArray(acc.data) ? Buffer.from(acc.data[0], "base64") : Buffer.from(acc.data as unknown as string, "base64");
      return parsePropAmmCtx(data).quotes[0].execPrice;
    },
    async takerFill(conn, a) {
      const ix = tradeWithMatcher(a.percolator, { dex: a.dex, takerPortfolio: a.takerPortfolio, taker: a.taker, lpPortfolio: a.lpPortfolio, matcherProgram, matcherCtx: a.ctx, legs: a.legs.map(legOf) });
      return (await withLegRefresh(conn, [ix], { percolator: a.percolator, matcher: matcherProgram })).instructions;
    },
    rawTakerFill(a) {
      return tradeWithMatcher(a.percolator, { dex: a.dex, takerPortfolio: a.takerPortfolio, taker: a.taker, lpPortfolio: a.lpPortfolio,
        matcherProgram: a.matcherProgram ?? matcherProgram, matcherCtx: a.matcherCtx ?? a.ctx, legs: a.legs.map(legOf) });
    },
  };
}

export const TRADE = TRADE_MODE;
export const VAULT_MAX_LEGS = MAX_LEGS;
