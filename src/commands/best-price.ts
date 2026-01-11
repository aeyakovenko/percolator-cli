import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseUsedIndices, parseAccount, AccountKind } from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

// Matcher constants
const PASSIVE_MATCHER_EDGE_BPS = 50n;
const BPS_DENOM = 10000n;

interface LpQuote {
  lpIndex: number;
  matcherProgram: string;
  bid: bigint;
  ask: bigint;
  edgeBps: number;
  capital: bigint;
  position: bigint;
}

function computePassiveQuote(oraclePrice: bigint, edgeBps: bigint): { bid: bigint; ask: bigint } {
  const bid = (oraclePrice * (BPS_DENOM - edgeBps)) / BPS_DENOM;
  const askNumer = oraclePrice * (BPS_DENOM + edgeBps);
  const ask = (askNumer + BPS_DENOM - 1n) / BPS_DENOM;
  return { bid, ask };
}

async function getChainlinkPrice(connection: any, oracle: PublicKey): Promise<{ price: bigint; decimals: number }> {
  const info = await connection.getAccountInfo(oracle);
  if (!info) throw new Error("Oracle not found");
  const decimals = info.data.readUInt8(138);
  const answer = info.data.readBigInt64LE(216);
  return { price: answer, decimals };
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

      // Fetch data
      const [slabData, oracleData] = await Promise.all([
        fetchSlab(ctx.connection, slabPk),
        getChainlinkPrice(ctx.connection, oraclePk),
      ]);

      const oraclePrice = oracleData.price;
      const oraclePriceUsd = Number(oraclePrice) / Math.pow(10, oracleData.decimals);

      // Find all LPs
      const usedIndices = parseUsedIndices(slabData);
      const quotes: LpQuote[] = [];

      for (const idx of usedIndices) {
        const account = parseAccount(slabData, idx);
        if (!account) continue;

        // LP detection: kind === LP or matcher_program is non-zero
        const isLp = account.kind === AccountKind.LP ||
          (account.matcherProgram && !account.matcherProgram.equals(PublicKey.default));

        if (isLp) {
          // For now, assume all matchers are 50bps passive
          const edgeBps = 50;
          const { bid, ask } = computePassiveQuote(oraclePrice, BigInt(edgeBps));

          quotes.push({
            lpIndex: idx,
            matcherProgram: account.matcherProgram?.toBase58() || "none",
            bid,
            ask,
            edgeBps,
            capital: account.capital,
            position: account.positionSize,
          });
        }
      }

      if (quotes.length === 0) {
        if (flags.json) {
          console.log(JSON.stringify({ error: "No LPs found" }));
        } else {
          console.log("No LPs found in this market");
        }
        process.exitCode = 1;
        return;
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
            bid: q.bid.toString(),
            ask: q.ask.toString(),
            edgeBps: q.edgeBps,
            capital: q.capital.toString(),
            position: q.position.toString(),
          })),
          bestBuy: {
            lpIndex: bestBuy.lpIndex,
            price: bestBuy.ask.toString(),
            priceUsd: Number(bestBuy.ask) / Math.pow(10, oracleData.decimals),
          },
          bestSell: {
            lpIndex: bestSell.lpIndex,
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
          console.log(`LP ${q.lpIndex} (${q.edgeBps}bps): bid=$${bidUsd.toFixed(4)} ask=$${askUsd.toFixed(4)} capital=${capitalSol.toFixed(2)}SOL pos=${q.position}`);
        }

        console.log("\n--- Best Prices ---");
        const bestBuyUsd = Number(bestBuy.ask) / Math.pow(10, oracleData.decimals);
        const bestSellUsd = Number(bestSell.bid) / Math.pow(10, oracleData.decimals);
        console.log(`BEST BUY:  LP ${bestBuy.lpIndex} @ $${bestBuyUsd.toFixed(4)}`);
        console.log(`BEST SELL: LP ${bestSell.lpIndex} @ $${bestSellUsd.toFixed(4)}`);

        const spreadBps = Number((bestBuy.ask - bestSell.bid) * 10000n / oraclePrice);
        console.log(`\nEffective spread: ${spreadBps.toFixed(1)} bps`);
      }
    });
}
