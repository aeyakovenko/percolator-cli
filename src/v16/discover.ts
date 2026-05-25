/**
 * v16 portfolio discovery via getProgramAccounts.
 * Returns every portfolio account on chain for a given program ID.
 */
import { Connection, PublicKey, GetProgramAccountsConfig } from "@solana/web3.js";
import bs58 from "bs58";
import {
  PORTFOLIO_ACCOUNT_LEN, MARKET_ACCOUNT_LEN,
  KIND_MARKET, KIND_PORTFOLIO,
} from "./constants.js";
import { parsePortfolio, parseMarketGroup, parseWrapperConfig, Portfolio, MarketGroup, WrapperConfig } from "./parsers.js";

// On-chain header serialisation (matches state::write_header):
//   8 B   MAGIC (u64 LE)         = 0x5045_5243_5631_3600
//   2 B   VERSION (u16 LE)       = 16
//   1 B   KIND
//   5 B   zero padding to HEADER_LEN=16
//
// MAGIC bytes (LE): 00 36 31 56 43 52 45 50
//                   ^ this is "\0" + "61VCREP" — "PERCV16\0" backwards.
function headerBytes(kind: number): Buffer {
  const buf = Buffer.alloc(11);
  buf.writeBigUInt64LE(0x5045_5243_5631_3600n, 0);
  buf.writeUInt16LE(16, 8);
  buf.writeUInt8(kind, 10);
  return buf;
}

export interface PortfolioRow {
  address: PublicKey;
  data: Portfolio;
  lamports: number;
  rawDataLen: number;
}

export async function discoverPortfolios(
  conn: Connection,
  programId: PublicKey,
): Promise<PortfolioRow[]> {
  const filterBytes = bs58.encode(headerBytes(KIND_PORTFOLIO));
  const cfg: GetProgramAccountsConfig = {
    commitment: "confirmed",
    dataSlice: undefined,
    filters: [
      { dataSize: PORTFOLIO_ACCOUNT_LEN },
      { memcmp: { offset: 0, bytes: filterBytes } },
    ],
  };
  const results = await conn.getProgramAccounts(programId, cfg);
  const rows: PortfolioRow[] = [];
  for (const { pubkey, account } of results) {
    try {
      rows.push({
        address: pubkey,
        data: parsePortfolio(Buffer.from(account.data)),
        lamports: account.lamports,
        rawDataLen: account.data.length,
      });
    } catch (e) {
      console.warn(`Failed to parse portfolio ${pubkey.toBase58()}:`, e);
    }
  }
  return rows;
}

export interface MarketRow {
  address: PublicKey;
  config: WrapperConfig;
  group: MarketGroup;
  lamports: number;
}

export async function discoverMarkets(
  conn: Connection,
  programId: PublicKey,
): Promise<MarketRow[]> {
  const filterBytes = bs58.encode(headerBytes(KIND_MARKET));
  const cfg: GetProgramAccountsConfig = {
    commitment: "confirmed",
    filters: [
      { dataSize: MARKET_ACCOUNT_LEN },
      { memcmp: { offset: 0, bytes: filterBytes } },
    ],
  };
  const results = await conn.getProgramAccounts(programId, cfg);
  const rows: MarketRow[] = [];
  for (const { pubkey, account } of results) {
    try {
      const buf = Buffer.from(account.data);
      rows.push({
        address: pubkey,
        config: parseWrapperConfig(buf),
        group: parseMarketGroup(buf),
        lamports: account.lamports,
      });
    } catch (e) {
      console.warn(`Failed to parse market ${pubkey.toBase58()}:`, e);
    }
  }
  return rows;
}
