import { Command } from "commander";
import { Connection, PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseUsedIndices, parseAccount, AccountKind } from "../solana/slab.js";
import { parseChainlinkPrice } from "../solana/oracle.js";
import { validatePublicKey } from "../validation.js";

const BPS_DENOM = 10000n;

// Matcher context layout (see percolator-match/src/vamm.rs)
// First 64 bytes: matcher return data
// Context starts at byte 64:
const CTX_BASE = 64;
const PERCMATC_MAGIC = 0x5045_5243_4d41_5443n;

interface MatcherParams {
  kind: number;        // 0=Passive, 1=vAMM
  feeBps: number;
  spreadBps: number;
  maxTotalBps: number;
  impactKBps: number;
  liquidityE6: bigint;
}

interface LpQuote {
  lpIndex: number;
  matcherProgram: string;
  matcherKind: string;
  bid: bigint;
  ask: bigint;
  totalEdgeBps: number;
  feeBps: number;
  spreadBps: number;
  capital: bigint;
  position: bigint;
}

async function fetchMatcherParams(
  connection: Connection,
  matcherCtx: PublicKey,
): Promise<MatcherParams | null> {
  try {
    const info = await connection.getAccountInfo(matcherCtx);
    if (!info || info.data.length < CTX_BASE + 80) return null;

    const data = info.data;
    const magic = data.readBigUInt64LE(CTX_BASE);
    if (magic !== PERCMATC_MAGIC) return null;

    return {
      kind: data.readUInt8(CTX_BASE + 12),
      feeBps: data.readUInt32LE(CTX_BASE + 48),
      spreadBps: data.readUInt32LE(CTX_BASE + 52),
      maxTotalBps: data.readUInt32LE(CTX_BASE + 56),
      impactKBps: data.readUInt32LE(CTX_BASE + 60),
      liquidityE6: data.readBigUInt64LE(CTX_BASE + 64) + (data.readBigUInt64LE(CTX_BASE + 72) << 64n),
    };
  } catch {
    return null;
  }
}

function kindLabel(kind: number): string {
  return kind === 0 ? "passive" : kind === 1 ? "vAMM" : `custom(${kind})`;
}

/**
 * Compute bid/ask using actual matcher parameters.
 * For passive: totalEdge = fee + spread.
 * For vAMM: same base, but vAMM adds trade-size impact on-chain (not estimable here).
 * Capped at maxTotalBps.
 */
function computeQuote(
  oraclePrice: bigint,
  params: MatcherParams,
): { bid: bigint; ask: bigint; totalEdgeBps: number; feeBps: number; spreadBps: number } {
  const feeBps = BigInt(params.feeBps);
  const spreadBps = BigInt(params.spreadBps);
  let totalEdgeBps = feeBps + spreadBps;

  if (params.maxTotalBps > 0 && totalEdgeBps > BigInt(params.maxTotalBps)) {
    totalEdgeBps = BigInt(params.maxTotalBps);
  }

  const bid = (oraclePrice * (BPS_DENOM - totalEdgeBps)) / BPS_DENOM;
  const askNumer = oraclePrice * (BPS_DENOM + totalEdgeBps);
  const ask = (askNumer + BPS_DENOM - 1n) / BPS_DENOM;

  return {
    bid,
    ask,
    totalEdgeBps: Number(totalEdgeBps),
    feeBps: Number(feeBps),
    spreadBps: Number(spreadBps),
  };
}

async function getChainlinkPrice(connection: Connection, oracle: PublicKey): Promise<{ price: bigint; decimals: number }> {
  const info = await connection.getAccountInfo(oracle);
  if (!info) throw new Error("Oracle account not found: " + oracle.toBase58());
  return parseChainlinkPrice(info.data as Buffer);
}

export function registerBestPrice(program: Command): void {
  program
    .command("best-price")
    .description("Scan LPs and find best prices for trading")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--oracle <pubkey>", "Price oracle account")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const oraclePk = validatePublicKey(opts.oracle, "--oracle");

      // Fetch slab and oracle in parallel
      const [slabData, oracleData] = await Promise.all([
        fetchSlab(ctx.connection, slabPk),
        getChainlinkPrice(ctx.connection, oraclePk),
      ]);

      const oraclePrice = oracleData.price;
      const oraclePriceUsd = Number(oraclePrice) / Math.pow(10, oracleData.decimals);

      // Find all LPs and collect matcher context addresses
      const usedIndices = parseUsedIndices(slabData);
      const lpAccounts: { idx: number; account: ReturnType<typeof parseAccount> }[] = [];

      for (const idx of usedIndices) {
        const account = parseAccount(slabData, idx);
        if (!account) continue;

        const isLp = account.kind === AccountKind.LP ||
          (account.matcherProgram && !account.matcherProgram.equals(PublicKey.default));

        if (isLp) {
          lpAccounts.push({ idx, account });
        }
      }

      if (lpAccounts.length === 0) {
        if (flags.json) {
          console.log(JSON.stringify({ error: "No LPs found" }));
        } else {
          console.log("No LPs found in this market");
        }
        process.exitCode = 1;
        return;
      }

      // Fetch all matcher contexts in parallel
      const matcherParams = await Promise.all(
        lpAccounts.map(({ account }) =>
          account.matcherContext && !account.matcherContext.equals(PublicKey.default)
            ? fetchMatcherParams(ctx.connection, account.matcherContext)
            : Promise.resolve(null)
        )
      );

      // Build quotes using actual matcher params
      const quotes: LpQuote[] = [];

      for (let i = 0; i < lpAccounts.length; i++) {
        const { idx, account } = lpAccounts[i];
        const params = matcherParams[i];

        const fallbackParams: MatcherParams = {
          kind: 0, feeBps: 0, spreadBps: 50, maxTotalBps: 0, impactKBps: 0, liquidityE6: 0n,
        };
        const p = params ?? fallbackParams;
        const quote = computeQuote(oraclePrice, p);

        quotes.push({
          lpIndex: idx,
          matcherProgram: account.matcherProgram?.toBase58() || "none",
          matcherKind: params ? kindLabel(params.kind) : "unknown (fallback 50bps)",
          bid: quote.bid,
          ask: quote.ask,
          totalEdgeBps: quote.totalEdgeBps,
          feeBps: quote.feeBps,
          spreadBps: quote.spreadBps,
          capital: account.capital,
          position: account.positionSize,
        });
      }

      // Find best prices
      const bestBuy = quotes.reduce((best, q) => q.ask < best.ask ? q : best);
      const bestSell = quotes.reduce((best, q) => q.bid > best.bid ? q : best);

      if (flags.json) {
        console.log(JSON.stringify({
          oracle: {
            price: oraclePrice.toString(),
            priceUsd: oraclePriceUsd,
            decimals: oracleData.decimals,
          },
          lps: quotes.map(q => ({
            index: q.lpIndex,
            matcherProgram: q.matcherProgram,
            matcherKind: q.matcherKind,
            bid: q.bid.toString(),
            ask: q.ask.toString(),
            totalEdgeBps: q.totalEdgeBps,
            feeBps: q.feeBps,
            spreadBps: q.spreadBps,
            capital: q.capital.toString(),
            position: q.position.toString(),
          })),
          bestBuy: {
            lpIndex: bestBuy.lpIndex,
            matcherKind: bestBuy.matcherKind,
            price: bestBuy.ask.toString(),
            priceUsd: Number(bestBuy.ask) / Math.pow(10, oracleData.decimals),
          },
          bestSell: {
            lpIndex: bestSell.lpIndex,
            matcherKind: bestSell.matcherKind,
            price: bestSell.bid.toString(),
            priceUsd: Number(bestSell.bid) / Math.pow(10, oracleData.decimals),
          },
          effectiveSpreadBps: Number((bestBuy.ask - bestSell.bid) * 10000n / oraclePrice),
        }, null, 2));
      } else {
        console.log("=== Best Price Scanner ===\n");
        console.log(`Oracle: $${oraclePriceUsd.toFixed(2)}`);
        console.log(`LPs found: ${quotes.length}\n`);

        console.log("--- LP Quotes ---");
        for (const q of quotes) {
          const bidUsd = Number(q.bid) / Math.pow(10, oracleData.decimals);
          const askUsd = Number(q.ask) / Math.pow(10, oracleData.decimals);
          const capitalSol = Number(q.capital) / 1e9;
          console.log(
            `LP ${q.lpIndex} [${q.matcherKind}] (${q.totalEdgeBps}bps = fee=${q.feeBps}+spread=${q.spreadBps}): ` +
            `bid=$${bidUsd.toFixed(4)} ask=$${askUsd.toFixed(4)} ` +
            `capital=${capitalSol.toFixed(2)}SOL pos=${q.position}`
          );
        }

        console.log("\n--- Best Prices ---");
        const bestBuyUsd = Number(bestBuy.ask) / Math.pow(10, oracleData.decimals);
        const bestSellUsd = Number(bestSell.bid) / Math.pow(10, oracleData.decimals);
        console.log(`BEST BUY:  LP ${bestBuy.lpIndex} [${bestBuy.matcherKind}] @ $${bestBuyUsd.toFixed(4)}`);
        console.log(`BEST SELL: LP ${bestSell.lpIndex} [${bestSell.matcherKind}] @ $${bestSellUsd.toFixed(4)}`);

        const spreadBps = Number((bestBuy.ask - bestSell.bid) * 10000n / oraclePrice);
        console.log(`\nEffective spread: ${spreadBps.toFixed(1)} bps`);
      }
    });
}
