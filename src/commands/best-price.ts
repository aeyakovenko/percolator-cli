import { Command } from "commander";
import { Connection, PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseUsedIndices, parseAccount, AccountKind } from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

const BPS_DENOM = 10000n;

// Matcher context layout (unified version 3+)
// First 64 bytes: reserved for matcher return data
// Context starts at byte 64:
//   +0:  magic (u64)     "PERCMATC" = 0x5045_5243_4d41_5443
//   +8:  version (u32)
//   +12: kind (u8)       0=Passive, 1=vAMM, 2=Credibility
//   +48: trading_fee_bps (u32)
//   +52: base_spread_bps (u32)
//   +56: max_total_bps (u32)
//   +60: impact_k_bps (u32)
//   +64: liquidity_notional_e6 (u128)
//   +96: inventory_base (i128)
const CTX_BASE = 64;
const PERCMATC_MAGIC = 0x5045_5243_4d41_5443n;

interface MatcherParams {
  kind: number;        // 0=Passive, 1=vAMM, 2+=custom
  feeBps: number;      // trading_fee_bps
  spreadBps: number;   // base_spread_bps
  maxTotalBps: number; // max_total_bps
  impactKBps: number;  // impact_k_bps
  liquidityE6: bigint; // liquidity_notional_e6
  inventory: bigint;   // inventory_base (signed)
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
  impactBps: number;
  capital: bigint;
  position: bigint;
}

/**
 * Fetch and parse a matcher context account.
 * Returns null if the account doesn't exist or has invalid magic.
 */
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

    const kind = data.readUInt8(CTX_BASE + 12);
    const feeBps = data.readUInt32LE(CTX_BASE + 48);
    const spreadBps = data.readUInt32LE(CTX_BASE + 52);
    const maxTotalBps = data.readUInt32LE(CTX_BASE + 56);
    const impactKBps = data.readUInt32LE(CTX_BASE + 60);

    // liquidity_notional_e6 at +64 (u128, 16 bytes)
    const loLiq = data.readBigUInt64LE(CTX_BASE + 64);
    const hiLiq = data.readBigUInt64LE(CTX_BASE + 72);
    const liquidityE6 = loLiq + (hiLiq << 64n);

    // inventory_base at +96 (i128, 16 bytes)
    const loInv = data.readBigUInt64LE(CTX_BASE + 96);
    const hiInv = data.readBigInt64LE(CTX_BASE + 104);
    const inventory = loInv + (BigInt(hiInv) << 64n);

    return { kind, feeBps, spreadBps, maxTotalBps, impactKBps, liquidityE6, inventory };
  } catch {
    return null;
  }
}

function kindLabel(kind: number): string {
  switch (kind) {
    case 0: return "passive";
    case 1: return "vAMM";
    case 2: return "credibility";
    default: return `custom(${kind})`;
  }
}

/**
 * Compute bid/ask using actual matcher parameters.
 *
 * For passive matchers: spread = base_spread_bps, no impact.
 * For vAMM/credibility: spread = base_spread_bps + impact from inventory skew.
 * Total edge = fee + spread, capped at max_total_bps.
 */
function computeQuote(
  oraclePrice: bigint,
  params: MatcherParams,
  tradeSize: bigint = 0n, // optional: estimate impact for a specific size
): { bid: bigint; ask: bigint; totalEdgeBps: number; feeBps: number; spreadBps: number; impactBps: number } {
  let spreadBps = BigInt(params.spreadBps);
  let impactBps = 0n;

  // For vAMM and credibility matchers, add inventory impact
  if (params.kind >= 1 && params.liquidityE6 > 0n && params.impactKBps > 0) {
    const absInventory = params.inventory < 0n ? -params.inventory : params.inventory;
    // impact = impactK * |inventory| / liquidity
    impactBps = (BigInt(params.impactKBps) * absInventory) / params.liquidityE6;
    spreadBps += impactBps;
  }

  const feeBps = BigInt(params.feeBps);
  let totalEdgeBps = feeBps + spreadBps;

  // Cap at max_total_bps if set
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
    impactBps: Number(impactBps),
  };
}

async function getChainlinkPrice(connection: Connection, oracle: PublicKey): Promise<{ price: bigint; decimals: number }> {
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

      // Fetch slab and oracle in parallel
      const [slabData, oracleData] = await Promise.all([
        fetchSlab(ctx.connection, slabPk),
        getChainlinkPrice(ctx.connection, oraclePk),
      ]);

      const oraclePrice = oracleData.price;
      const oraclePriceUsd = Number(oraclePrice) / Math.pow(10, oracleData.decimals);

      // Find all LPs and collect their matcher context addresses
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
      const ctxFetches = lpAccounts.map(({ account }) =>
        account.matcherContext && !account.matcherContext.equals(PublicKey.default)
          ? fetchMatcherParams(ctx.connection, account.matcherContext)
          : Promise.resolve(null)
      );
      const matcherParams = await Promise.all(ctxFetches);

      // Build quotes using actual matcher params
      const quotes: LpQuote[] = [];

      for (let i = 0; i < lpAccounts.length; i++) {
        const { idx, account } = lpAccounts[i];
        const params = matcherParams[i];

        let quote: ReturnType<typeof computeQuote>;
        let matcherKind: string;

        if (params) {
          // Use actual on-chain matcher parameters
          quote = computeQuote(oraclePrice, params);
          matcherKind = kindLabel(params.kind);
        } else {
          // Fallback: matcher context unreadable, assume 50bps passive
          quote = computeQuote(oraclePrice, {
            kind: 0,
            feeBps: 0,
            spreadBps: 50,
            maxTotalBps: 0,
            impactKBps: 0,
            liquidityE6: 0n,
            inventory: 0n,
          });
          matcherKind = "unknown (fallback 50bps)";
        }

        quotes.push({
          lpIndex: idx,
          matcherProgram: account.matcherProgram?.toBase58() || "none",
          matcherKind,
          bid: quote.bid,
          ask: quote.ask,
          totalEdgeBps: quote.totalEdgeBps,
          feeBps: quote.feeBps,
          spreadBps: quote.spreadBps,
          impactBps: quote.impactBps,
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
            impactBps: q.impactBps,
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
          const parts = [`fee=${q.feeBps}`, `spread=${q.spreadBps}`];
          if (q.impactBps > 0) parts.push(`impact=${q.impactBps}`);
          console.log(
            `LP ${q.lpIndex} [${q.matcherKind}] (${q.totalEdgeBps}bps = ${parts.join("+")}): ` +
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
