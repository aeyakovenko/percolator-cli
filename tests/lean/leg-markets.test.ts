/** percolator-lean 8774e86 `verifyLegMktFresh`: every open leg's Market must be among the instruction's accounts.
 *  `withLegRefresh` appends the missing ones as trailing read-only accounts (devnet-proven against an in-place
 *  887ba02 -> 8774e86 upgrade: without them WithdrawCollateral / Trade / Liquidate reject with 122). */
import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { withdrawCollateral, trade, liquidate, tradeWithMatcher, refreshLeg, depositCollateral } from "../../src/lean/instructions.js";
import { withLegRefresh, appendLegMarkets } from "../../src/lean/refresh.js";
import { IX, MAGIC, PORTFOLIO_SIZE, PflOff, LegOff, SIDE, TRADE_MODE } from "../../src/lean/constants.js";

const pk = () => Keypair.generate().publicKey;
const P = pk(), M = pk(), dex = pk(), mint = pk(), vault = pk(), tok = pk();
const V = { dex, mint, vault };
const b58 = (k: PublicKey) => k.toBase58();

function pflBuf(legs: [PublicKey, number][]): Buffer {
  const b = Buffer.alloc(PORTFOLIO_SIZE);
  b.writeUInt32LE(MAGIC.PORTFOLIO, 0); b.writeUInt8(legs.length, PflOff.legCount); dex.toBuffer().copy(b, PflOff.dex);
  legs.forEach(([mkt, side], i) => {
    const o = PflOff.headerSize + i * PflOff.legStride;
    b.writeUInt8(1, o + LegOff.active); b.writeUInt8(side, o + LegOff.side); mkt.toBuffer().copy(b, o + LegOff.market);
    b.writeBigUInt64LE(side === SIDE.FLAT ? 0n : 1_000_000n, o + LegOff.rawBasis);
  });
  return b;
}
function mockConn(images: Map<string, Buffer>): Connection {
  return { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => { const d = images.get(b58(k)); return d ? { data: d, owner: P, lamports: 1, executable: false } : null; }) } as unknown as Connection;
}
const opts = { percolator: P, matcher: M };
const trailing = (ix: TransactionInstruction, fixed: number) => ix.keys.slice(fixed).map((k) => `${b58(k.pubkey)}:${k.isSigner ? "s" : "-"}${k.isWritable ? "w" : "-"}`);
const ro = (k: PublicKey) => `${b58(k)}:--`;
const refreshes = (ixs: TransactionInstruction[]) => ixs.filter((i) => i.data[0] === IX.RefreshLeg).map((i) => `${b58(i.keys[1].pubkey)}:${b58(i.keys[2].pubkey)}`).sort();

test("appendLegMarkets: read-only trailing, de-duplicated, identity when nothing to add", () => {
  const a = pk(), b = pk(), pfl = pk(), owner = pk();
  const ix = withdrawCollateral(P, V, { portfolio: pfl, owner, destToken: tok, amount: 1n });
  assert.equal(appendLegMarkets(ix, []), ix);
  assert.equal(appendLegMarkets(ix, [mint, vault]), ix, "keys already present are not duplicated");
  const out = appendLegMarkets(ix, [a, b, a, mint]);
  assert.deepEqual(trailing(out, 7), [ro(a), ro(b)]);
  assert.deepEqual(out.keys.slice(0, 7), ix.keys);
  assert.ok(out.data.equals(ix.data) && out.programId.equals(P));
  assert.equal(ix.keys.length, 7, "input instruction is not mutated");
});

test("withLegRefresh WithdrawCollateral: EVERY open leg's market trails (even single-leg); flat untouched", async () => {
  const mA = pk(), mB = pk(), mF = pk(), single = pk(), multi = pk(), flat = pk(), owner = pk();
  const conn = mockConn(new Map([[b58(single), pflBuf([[mA, SIDE.LONG]])], [b58(multi), pflBuf([[mA, SIDE.SHORT], [mF, SIDE.FLAT], [mB, SIDE.LONG]])], [b58(flat), pflBuf([[mF, SIDE.FLAT]])]]));
  const w = (portfolio: PublicKey) => withdrawCollateral(P, V, { portfolio, owner, destToken: tok, amount: 5n });

  const s = await withLegRefresh(conn, [w(single)], opts);
  assert.equal(s.added, 1);
  assert.deepEqual(refreshes(s.instructions), [`${b58(mA)}:${b58(single)}`]);
  assert.deepEqual(trailing(s.instructions[1], 7), [ro(mA)]);
  assert.deepEqual(s.instructions[1].keys.slice(0, 7), w(single).keys, "the 7 fixed accounts are unchanged");

  const mu = await withLegRefresh(conn, [w(multi)], opts);
  assert.equal(mu.added, 2);
  assert.deepEqual(trailing(mu.instructions[2], 7), [ro(mA), ro(mB)], "open legs only: the flat leg's market is not appended");

  const f = await withLegRefresh(conn, [w(flat)], opts);
  assert.equal(f.added, 0);
  assert.equal(f.instructions.length, 1);
  assert.equal(f.instructions[0].keys.length, 7);
});

test("withLegRefresh bilateral Trade: other-leg markets of BOTH portfolios trail once; traded market not duplicated", async () => {
  const mA = pk(), mB = pk(), mC = pk(), L = pk(), S = pk(), lo = pk(), so = pk();
  const conn = mockConn(new Map([[b58(L), pflBuf([[mA, SIDE.LONG], [mB, SIDE.LONG]])], [b58(S), pflBuf([[mA, SIDE.SHORT], [mB, SIDE.SHORT], [mC, SIDE.LONG]])]]));
  for (const mode of [TRADE_MODE.OPEN, TRADE_MODE.CLOSE, TRADE_MODE.NETTED]) {
    const t = trade(P, { dex, market: mA, longPortfolio: L, longOwner: lo, shortPortfolio: S, shortOwner: so, mode, qty: 1n });
    const r = await withLegRefresh(conn, [t], opts);
    assert.equal(r.added, 5);
    const out = r.instructions[r.instructions.length - 1];
    assert.deepEqual(out.keys.slice(0, 6), t.keys);
    assert.deepEqual(trailing(out, 6), [ro(mB), ro(mC)]);
    assert.equal(new Set(out.keys.map((k) => b58(k.pubkey))).size, out.keys.length, "no duplicate account");
  }
  // single-leg pair trading its own market: nothing to append
  const conn2 = mockConn(new Map([[b58(L), pflBuf([[mA, SIDE.LONG]])], [b58(S), pflBuf([[mA, SIDE.SHORT]])]]));
  const r2 = await withLegRefresh(conn2, [trade(P, { dex, market: mA, longPortfolio: L, longOwner: lo, shortPortfolio: S, shortOwner: so, mode: TRADE_MODE.OPEN, qty: 1n })], opts);
  assert.equal(r2.instructions[2].keys.length, 6);
});

test("withLegRefresh Liquidate: victim's other-leg markets trail (victim never auto-refreshed); takeover adds the liquidator's", async () => {
  const mA = pk(), mB = pk(), mC = pk(), victim = pk(), liqPfl = pk(), liqOwner = pk();
  const conn = mockConn(new Map([[b58(victim), pflBuf([[mA, SIDE.LONG], [mB, SIDE.SHORT]])], [b58(liqPfl), pflBuf([[mA, SIDE.SHORT], [mC, SIDE.LONG]])]]));
  const l0 = liquidate(P, V, { market: mA, portfolio: victim, liquidatorToken: tok });
  const r0 = await withLegRefresh(conn, [l0], opts);
  assert.equal(r0.added, 0, "the victim is never auto-refreshed");
  assert.deepEqual(trailing(r0.instructions[0], 7), [ro(mB)]);
  assert.ok(r0.instructions[0].data.equals(l0.data));

  // explicit caller-supplied refresh of the victim's other leg is kept as is
  const r0b = await withLegRefresh(conn, [refreshLeg(P, { dex, market: mB, portfolio: victim }), l0], opts);
  assert.equal(r0b.instructions.length, 2);
  assert.deepEqual(trailing(r0b.instructions[1], 7), [ro(mB)]);

  const l1 = liquidate(P, V, { market: mA, portfolio: victim, liquidatorToken: tok, mode: 1, reqQty: 0n, liqPortfolio: liqPfl, liqOwner });
  const r1 = await withLegRefresh(conn, [l1], opts);
  assert.deepEqual(refreshes(r1.instructions), [`${b58(mC)}:${b58(liqPfl)}`]);
  const out = r1.instructions[r1.instructions.length - 1];
  assert.deepEqual(out.keys.slice(0, 9), l1.keys, "the 9 takeover accounts keep their positions");
  assert.deepEqual(trailing(out, 9), [ro(mB), ro(mC)]);
});

test("withLegRefresh TradeWithMatcher still appends other-leg markets; non-freshness instructions are untouched", async () => {
  const mA = pk(), mD = pk(), taker = pk(), tp = pk(), lp = pk(), ctx = pk();
  const conn = mockConn(new Map([[b58(tp), pflBuf([[mD, SIDE.LONG]])], [b58(lp), pflBuf([[mA, SIDE.SHORT], [mD, SIDE.LONG]])]]));
  const t = tradeWithMatcher(P, { dex, takerPortfolio: tp, taker, lpPortfolio: lp, matcherProgram: M, matcherCtx: ctx, legs: [{ market: mA, mode: TRADE_MODE.NETTED, takerIsLong: true, maxQty: 1n }] });
  const dep = depositCollateral(P, V, { portfolio: tp, depositor: taker, sourceToken: tok, amount: 1n });
  const r = await withLegRefresh(conn, [dep, t], opts);
  assert.equal(r.instructions[0], dep);
  assert.deepEqual(trailing(r.instructions[r.instructions.length - 1], 7), [ro(mD)]);
});
