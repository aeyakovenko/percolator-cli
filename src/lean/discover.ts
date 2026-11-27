/**
 * percolator-lean account discovery via getProgramAccounts (magic + dataSize filters).
 */
import { Connection, PublicKey, GetProgramAccountsFilter } from "@solana/web3.js";
import bs58 from "bs58";
import {
  MAGIC, DEX_SIZE, MARKET_SIZE, PORTFOLIO_SIZE, INS_RECEIPT_SIZE, PflOff, MktOff, InsOff,
} from "./constants.js";
import { parseDex, parseMarket, parsePortfolio, parseInsReceipt, Dex, Market, Portfolio, InsReceipt } from "./parsers.js";

export interface Row<T> { address: PublicKey; lamports: number; data: T }

const magicFilter = (magic: number): GetProgramAccountsFilter => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(magic, 0);
  return { memcmp: { offset: 0, bytes: bs58.encode(b) } };
};
const keyFilter = (offset: number, key: PublicKey): GetProgramAccountsFilter =>
  ({ memcmp: { offset, bytes: key.toBase58() } });

async function scan<T>(
  conn: Connection, programId: PublicKey, size: number, magic: number,
  extra: GetProgramAccountsFilter[], parse: (b: Buffer) => T,
): Promise<Row<T>[]> {
  const res = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: size }, magicFilter(magic), ...extra],
  });
  const rows: Row<T>[] = [];
  for (const { pubkey, account } of res) {
    try {
      rows.push({ address: pubkey, lamports: account.lamports, data: parse(Buffer.from(account.data)) });
    } catch (e) {
      console.warn(`skip ${pubkey.toBase58()}: ${(e as Error).message}`);
    }
  }
  return rows;
}

export const discoverDexes = (conn: Connection, programId: PublicKey) =>
  scan<Dex>(conn, programId, DEX_SIZE, MAGIC.DEX, [], parseDex);

export const discoverMarkets = (conn: Connection, programId: PublicKey, opts: { dex?: PublicKey } = {}) =>
  scan<Market>(conn, programId, MARKET_SIZE, MAGIC.MARKET, opts.dex ? [keyFilter(MktOff.dex, opts.dex)] : [], parseMarket);

export const discoverPortfolios = (conn: Connection, programId: PublicKey, opts: { dex?: PublicKey; owner?: PublicKey } = {}) =>
  scan<Portfolio>(conn, programId, PORTFOLIO_SIZE, MAGIC.PORTFOLIO, [
    ...(opts.dex ? [keyFilter(PflOff.dex, opts.dex)] : []),
    ...(opts.owner ? [keyFilter(PflOff.owner, opts.owner)] : []),
  ], parsePortfolio);

export async function discoverInsReceipts(
  conn: Connection, programId: PublicKey, opts: { market?: PublicKey; owner?: PublicKey } = {},
): Promise<Row<InsReceipt>[]> {
  const extra: GetProgramAccountsFilter[] = [
    ...(opts.market ? [keyFilter(InsOff.market, opts.market)] : []),
    ...(opts.owner ? [keyFilter(InsOff.owner, opts.owner)] : []),
  ];
  // Scan by magic (without hiding wrong-sized INSR accounts) and strictly parse exact 88B receipts.
  const res = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [magicFilter(MAGIC.INSURANCE), ...extra],
  });
  const rows: Row<InsReceipt>[] = [];
  for (const { pubkey, account } of res) {
    try {
      rows.push({ address: pubkey, lamports: account.lamports, data: parseInsReceipt(Buffer.from(account.data)) });
    } catch (e) {
      console.warn(`bad INSR account ${pubkey.toBase58()} (${account.data.length}B): ${(e as Error).message}`);
    }
  }
  return rows;
}

/** Every market, portfolio, and insurance receipt of one DEX, plus its vault token balance — the inputs to checkDexInvariants. */
export async function snapshotDex(conn: Connection, programId: PublicKey, dexAddress: PublicKey) {
  const info = await conn.getAccountInfo(dexAddress, "confirmed");
  if (!info) throw new Error(`dex ${dexAddress.toBase58()} not found`);
  const dex = parseDex(Buffer.from(info.data));
  const [markets, portfolios, allReceipts, vaultBal] = await Promise.all([
    discoverMarkets(conn, programId, { dex: dexAddress }),
    discoverPortfolios(conn, programId, { dex: dexAddress }),
    discoverInsReceipts(conn, programId),
    conn.getTokenAccountBalance(dex.vault, "confirmed"),
  ]);
  const marketSet = new Set(markets.map((m) => m.address.toBase58()));
  const receipts = allReceipts.filter((r) => marketSet.has(r.data.market.toBase58()));
  return { dex, markets, portfolios, receipts, vaultTokenBalance: BigInt(vaultBal.value.amount) };
}
