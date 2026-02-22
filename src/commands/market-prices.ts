/**
 * market-prices — Fetch BTC, SOL, and ALIENATOR market prices
 * Synced from ALIEN-PERC Chart.tsx market bar + server.js enrichment
 */

import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";

// ALIENATOR token (synced from ALIEN-PERC server.js)
const ALIENATOR_MINT = "AWQ5b6KkXKASgEQ9E7zh19fLAZaSFftSBJCQyhJrpump";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function registerMarketPrices(program: Command): void {
  program
    .command("market-prices")
    .description("Show BTC, SOL, and ALIENATOR prices (ALIENTOR market bar)")
    .option("--watch", "Refresh every 30 seconds")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const json = flags.json ?? false;
      const watch = opts.watch ?? false;

      const fetchAndDisplay = async () => {
        let btcPrice = 0;
        let solPrice = 0;
        let alienPrice = 0;
        let alienMcap = 0;
        let alienVolume = 0;
        let alienChange24h = 0;
        let alienDex = "";

        // CoinGecko for BTC + SOL
        try {
          const res = await fetch(
            "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,solana&vs_currencies=usd&include_24hr_change=true",
            { signal: AbortSignal.timeout(8000) }
          );
          const data = await res.json() as any;
          btcPrice = data.bitcoin?.usd ?? 0;
          solPrice = data.solana?.usd ?? 0;
        } catch { /* silent */ }

        // DexScreener for ALIENATOR
        try {
          const res = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${ALIENATOR_MINT}`,
            { signal: AbortSignal.timeout(8000) }
          );
          const data = await res.json() as any;
          const pair = data.pairs?.[0];
          if (pair) {
            alienPrice = parseFloat(pair.priceUsd ?? "0");
            alienMcap = pair.fdv ?? 0;
            alienVolume = pair.volume?.h24 ?? 0;
            alienChange24h = pair.priceChange?.h24 ?? 0;
            alienDex = pair.dexId ?? "";
          }
        } catch { /* silent */ }

        if (json) {
          console.log(JSON.stringify({
            btc: { price: btcPrice },
            sol: { price: solPrice },
            alienator: {
              mint: ALIENATOR_MINT,
              price: alienPrice,
              marketCap: alienMcap,
              volume24h: alienVolume,
              priceChange24h: alienChange24h,
              dex: alienDex,
            },
            timestamp: Date.now(),
          }, null, 2));
          return;
        }

        // Human output
        if (watch) {
          process.stdout.write("\x1B[2J\x1B[0f"); // Clear screen
        }

        console.log();
        console.log(`${BOLD}╔═══════════════════════════════════════╗${RESET}`);
        console.log(`${BOLD}║  ALIENTOR MARKET PRICES               ║${RESET}`);
        console.log(`${BOLD}╚═══════════════════════════════════════╝${RESET}`);
        console.log();

        // BTC
        console.log(`  ${BOLD}BTC${RESET}         $${btcPrice > 0 ? btcPrice.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "--"}`);

        // SOL
        console.log(`  ${BOLD}SOL${RESET}         $${solPrice > 0 ? solPrice.toFixed(2) : "--"}`);

        // ALIENATOR
        const alienPriceStr = alienPrice > 0
          ? (alienPrice < 0.0001 ? alienPrice.toExponential(2) : alienPrice.toFixed(6))
          : "--";
        const mcapStr = alienMcap >= 1e6
          ? `$${(alienMcap / 1e6).toFixed(1)}M`
          : alienMcap >= 1e3
            ? `$${(alienMcap / 1e3).toFixed(0)}K`
            : "--";
        const changeColor = alienChange24h >= 0 ? GREEN : RED;
        const changeStr = alienChange24h !== 0
          ? `${changeColor}${alienChange24h >= 0 ? "+" : ""}${alienChange24h.toFixed(2)}%${RESET}`
          : "";

        console.log(`  ${BOLD}$ALIENATOR${RESET}  $${alienPriceStr}  ${mcapStr}  ${changeStr}`);

        if (alienVolume > 0) {
          const volStr = alienVolume >= 1e6
            ? `$${(alienVolume / 1e6).toFixed(1)}M`
            : `$${(alienVolume / 1e3).toFixed(0)}K`;
          console.log(`  ${DIM}Volume 24h: ${volStr}  DEX: ${alienDex}${RESET}`);
        }

        console.log(`  ${DIM}Mint: ${ALIENATOR_MINT}${RESET}`);

        if (watch) {
          console.log();
          console.log(`  ${DIM}Refreshing every 30s... (Ctrl+C to stop)${RESET}`);
        }
        console.log();
      };

      await fetchAndDisplay();

      if (watch) {
        setInterval(fetchAndDisplay, 30000);
      }
    });
}
