import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import {
  LEAN_MAINNET, LegOff, MAGIC, MARKET_SIZE, MktOff, PflOff, PORTFOLIO_SIZE, SIDE, STATUS,
  liquidate, realizeFlatLegs, refreshLeg, withdrawCollateral, withLegRefresh,
} from "../../src/lean/index.js";

const program = LEAN_MAINNET.percolator;
const key = (value: number) => new PublicKey(Buffer.alloc(32, value));
const dex = key(1);
const market = key(2);
const otherMarket = key(3);
const victim = key(4);
const takeover = key(5);
const owner = key(6);
const liquidatorToken = key(7);
const vault = { dex, mint: key(8), vault: key(9) };

function portfolioData(legs: { market: PublicKey; side: number; posPnl?: bigint }[]): Buffer {
  const data = Buffer.alloc(PORTFOLIO_SIZE);
  data.writeUInt32LE(MAGIC.PORTFOLIO);
  dex.toBuffer().copy(data, PflOff.dex);
  data.writeUInt8(legs.length, PflOff.legCount);
  for (const [i, leg] of legs.entries()) {
    const base = PflOff.headerSize + i * PflOff.legStride;
    leg.market.toBuffer().copy(data, base + LegOff.market);
    data.writeUInt8(1, base + LegOff.active);
    data.writeUInt8(leg.side, base + LegOff.side);
    data.writeBigUInt64LE(leg.posPnl ?? 0n, base + LegOff.posPnl);
  }
  return data;
}

function mockConnection(accounts: [PublicKey, Buffer][], programOwner = program) {
  const lookups: PublicKey[][] = [];
  const getAccount = (address: PublicKey): AccountInfo<Buffer> | null => {
    const pair = accounts.find(([key]) => key.equals(address));
    return pair ? { owner: programOwner, data: pair[1], lamports: 1, executable: false } : null;
  };
  const conn = {
    async getAccountInfo(address: PublicKey) { return getAccount(address); },
    async getMultipleAccountsInfo(addresses: PublicKey[]) {
      lookups.push(addresses);
      return addresses.map(getAccount);
    },
  } as unknown as Connection;
  return { conn, lookups };
}

const victimLegs = [{ market, side: SIDE.LONG }, { market: otherMarket, side: SIDE.SHORT }];

test("ordinary liquidation leaves victim legs to the caller and does not fetch the portfolio", async () => {
  const { conn, lookups } = mockConnection([[victim, portfolioData(victimLegs)]]);
  const legacy = liquidate(program, vault, { market, portfolio: victim, liquidatorToken });
  const extended = liquidate(program, vault, { market, portfolio: victim, liquidatorToken, mode: 0, reqQty: 1n });

  assert.deepEqual(await withLegRefresh(conn, [legacy, extended]), { added: 0, instructions: [legacy, extended] });
  assert.deepEqual(lookups, []);
});

test("takeover refreshes only the liquidator's other legs and preserves explicit victim refreshes", async () => {
  const { conn, lookups } = mockConnection([
    [victim, portfolioData(victimLegs)],
    [takeover, portfolioData([...victimLegs, { market: key(10), side: SIDE.FLAT, posPnl: 1n }])],
  ]);
  const explicit = refreshLeg(program, { dex, market: otherMarket, portfolio: victim });
  const takeOver = liquidate(program, vault, {
    market, portfolio: victim, liquidatorToken, mode: 1, liqPortfolio: takeover, liqOwner: owner,
  });

  assert.deepEqual(await withLegRefresh(conn, [explicit, takeOver]), {
    added: 1,
    instructions: [explicit, refreshLeg(program, { dex, market: otherMarket, portfolio: takeover }), takeOver],
  });
  assert.deepEqual(lookups, [[takeover]]);
});

test("withdrawal still refreshes every open leg and deduplicates explicit refreshes", async () => {
  const { conn } = mockConnection([[victim, portfolioData(victimLegs)]]);
  const explicit = refreshLeg(program, { dex, market, portfolio: victim });
  const withdraw = withdrawCollateral(program, vault, { portfolio: victim, owner, destToken: key(11), amount: 1n });

  assert.deepEqual(await withLegRefresh(conn, [explicit, withdraw]), {
    added: 1,
    instructions: [explicit, refreshLeg(program, { dex, market: otherMarket, portfolio: victim }), withdraw],
  });
});

test("realizing flat legs infers mainnet and requires an explicit owner for custom deployments", async () => {
  const marketData = Buffer.alloc(MARKET_SIZE);
  marketData.writeUInt32LE(MAGIC.MARKET);
  marketData.writeUInt8(STATUS.ACTIVE, MktOff.status);
  const accounts: [PublicKey, Buffer][] = [
    [victim, portfolioData([{ market, side: SIDE.FLAT, posPnl: 1n }])],
    [market, marketData],
  ];
  const { conn } = mockConnection(accounts);

  assert.deepEqual(await realizeFlatLegs(conn, victim), [refreshLeg(program, { dex, market, portfolio: victim })]);

  const custom = key(12);
  const { conn: customConn } = mockConnection(accounts, custom);
  await assert.rejects(realizeFlatLegs(customConn, victim), /unexpected program owner/);
  assert.deepEqual(await realizeFlatLegs(customConn, victim, { percolator: custom }), [
    refreshLeg(custom, { dex, market, portfolio: victim }),
  ]);
});
