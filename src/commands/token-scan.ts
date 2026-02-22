/**
 * token-scan — Fetch and display token data from DexScreener + pump.fun
 * Mirrors the ALIENTOR Chart scanner page functionality for CLI usage.
 * Synced from ALIEN-PERC ui/src/pages/Chart.tsx
 */

import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";

// ALIENATOR protocol constants (synced from ALIEN-PERC server.js)
const ALIENATOR_MINT = "AWQ5b6KkXKASgEQ9E7zh19fLAZaSFftSBJCQyhJrpump";
const GRADUATION_THRESHOLD_SOL = 85;
const INITIAL_VIRTUAL_SOL = 30;

interface DexPair {
  baseToken?: { name?: string; symbol?: string; address?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { m1?: number; m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  info?: { imageUrl?: string };
  dexId?: string;
  pairAddress?: string;
}

function formatNum(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function formatPrice(n: number): string {
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  if (n < 1) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

function fmtPct(n: number | undefined): string {
  if (n === undefined || n === null) return "  -  ";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function scoreColor(score: number): string {
  if (score >= 65) return "\x1b[32m"; // green
  if (score >= 35) return "\x1b[33m"; // yellow
  return "\x1b[31m"; // red
}

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

export function registerTokenScan(program: Command): void {
  program
    .command("token-scan")
    .description("Scan a Solana token — fetches DexScreener + pump.fun data (ALIENTOR Chart)")
    .argument("<mint>", "Token mint address (contract address)")
    .option("--verbose", "Show extended metrics")
    .action(async (mint: string, opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const json = flags.json ?? false;
      const verbose = opts.verbose ?? false;

      if (!mint || mint.length < 30) {
        console.error("Error: provide a valid token mint address");
        process.exit(1);
      }

      // Fetch DexScreener data
      let dexPair: DexPair | null = null;
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json() as { pairs?: DexPair[] };
        dexPair = data.pairs?.[0] ?? null;
      } catch (e: any) {
        console.error(`DexScreener fetch failed: ${e.message}`);
      }

      // Fetch pump.fun data
      let pumpData: any = null;
      try {
        const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) pumpData = await res.json();
      } catch { /* silent */ }

      if (!dexPair && !pumpData) {
        console.error("Token not found on DexScreener or pump.fun");
        process.exit(1);
      }

      // Build unified token object
      const name = dexPair?.baseToken?.name ?? pumpData?.name ?? "Unknown";
      const symbol = dexPair?.baseToken?.symbol ?? pumpData?.symbol ?? "???";
      const price = parseFloat(dexPair?.priceUsd ?? "0") || 0;
      const fdv = dexPair?.fdv ?? pumpData?.usd_market_cap ?? 0;
      const liq = dexPair?.liquidity?.usd ?? 0;
      const vol24h = dexPair?.volume?.h24 ?? pumpData?.volume_24h ?? 0;
      const holders = pumpData?.holder_count ?? 0;
      const pc = dexPair?.priceChange ?? {};
      const txns = dexPair?.txns ?? {};
      const txns24h = txns.h24 ? (txns.h24.buys ?? 0) + (txns.h24.sells ?? 0) : 0;
      const image = dexPair?.info?.imageUrl ?? pumpData?.image_uri ?? null;
      const dexId = dexPair?.dexId ?? (pumpData?.complete ? "graduated" : "pump.fun");

      // Calculate ALIEN Score (synced from ALIEN-PERC Chart.tsx scoring logic)
      const liqRatio = fdv > 0 ? (liq / fdv) * 100 : 0;
      const volRatio = fdv > 0 ? (vol24h / fdv) * 100 : 0;
      const change5m = pc.m5 ?? 0;
      const tx5m = txns.m5 ? (txns.m5.buys ?? 0) + (txns.m5.sells ?? 0) : 0;

      const sFDV = fdv < 15000 ? 80 : fdv < 50000 ? 65 : fdv < 100000 ? 50 : fdv < 250000 ? 40 : 30;
      const sLiq = liq > 25000 ? 70 : liq > 15000 ? 55 : liq > 8000 ? 40 : liq > 3000 ? 30 : 15;
      const sVol = volRatio > 50 ? 75 : volRatio > 25 ? 60 : volRatio > 10 ? 50 : volRatio > 5 ? 40 : 25;
      const sMom = change5m > 15 ? 75 : change5m > 5 ? 60 : change5m > 0 ? 50 : change5m > -5 ? 40 : 25;
      const sTx = tx5m > 25 ? 75 : tx5m > 10 ? 60 : tx5m > 5 ? 45 : tx5m > 2 ? 35 : 20;
      const sRisk = liqRatio > 20 ? 70 : liqRatio > 10 ? 55 : liqRatio > 5 ? 40 : 25;
      const alienScore = Math.max(0, Math.min(100,
        Math.round(sFDV * 0.20 + sLiq * 0.18 + sVol * 0.17 + sMom * 0.20 + sTx * 0.15 + sRisk * 0.10)
      ));

      // Safety analysis
      const noMint = pumpData ? pumpData.mint_authority === null : null;
      const noFreeze = pumpData ? pumpData.freeze_authority === null : null;

      // Pump.fun graduation progress
      let graduated = pumpData?.complete === true;
      let progress = 0;
      if (pumpData) {
        const realSol = (pumpData.real_sol_reserves ?? 0) / 1e9;
        const virtualSol = (pumpData.virtual_sol_reserves ?? 0) / 1e9;
        const calculatedReal = realSol > 0 ? realSol : (virtualSol > INITIAL_VIRTUAL_SOL ? virtualSol - INITIAL_VIRTUAL_SOL : 0);
        progress = Math.min((calculatedReal / GRADUATION_THRESHOLD_SOL) * 100, 100);
        if (graduated) progress = 100;
      }
      if (dexId === "raydium" || dexId === "pumpswap") {
        graduated = true;
        progress = 100;
      }

      // JSON output
      if (json) {
        console.log(JSON.stringify({
          mint,
          name,
          symbol,
          price,
          marketCap: fdv,
          liquidity: liq,
          volume24h: vol24h,
          holders,
          txns24h,
          alienScore,
          priceChange: { m1: pc.m1, m5: pc.m5, h1: pc.h1, h6: pc.h6, h24: pc.h24 },
          txns: { m5: txns.m5, h1: txns.h1, h24: txns.h24 },
          layers: { fdv: sFDV, liquidity: sLiq, volume: sVol, momentum: sMom, txnFlow: sTx, safety: sRisk },
          safety: { noMint, noFreeze, holders },
          pumpFun: pumpData ? { graduated, progress: +progress.toFixed(1) } : null,
          dex: dexId,
          image,
        }, null, 2));
        return;
      }

      // Human-readable output
      console.log();
      console.log(`${BOLD}╔═══════════════════════════════════════════════════════════╗${RESET}`);
      console.log(`${BOLD}║  ALIENTOR TOKEN SCANNER                                   ║${RESET}`);
      console.log(`${BOLD}╚═══════════════════════════════════════════════════════════╝${RESET}`);
      console.log();
      console.log(`  ${BOLD}${symbol}${RESET} / SOL  ${DIM}(${name})${RESET}`);
      console.log(`  ${DIM}${mint}${RESET}`);
      console.log(`  ${DIM}DEX: ${dexId}${RESET}`);
      console.log();

      // Price
      console.log(`  ${BOLD}Price:${RESET}       ${formatPrice(price)}`);
      console.log(`  ${BOLD}Market Cap:${RESET}  ${formatNum(fdv)}`);
      console.log(`  ${BOLD}Liquidity:${RESET}   ${formatNum(liq)}`);
      console.log(`  ${BOLD}Volume 24h:${RESET}  ${formatNum(vol24h)}`);
      console.log(`  ${BOLD}Holders:${RESET}     ${holders > 0 ? holders.toLocaleString() : "-"}`);
      console.log(`  ${BOLD}Txns 24h:${RESET}    ${txns24h > 0 ? txns24h.toLocaleString() : "-"}`);
      console.log();

      // Price changes
      console.log(`  ${DIM}Price Changes:${RESET}`);
      const changes = [
        { label: "1m", val: pc.m1 },
        { label: "5m", val: pc.m5 },
        { label: "1h", val: pc.h1 },
        { label: "6h", val: pc.h6 },
        { label: "24h", val: pc.h24 },
      ];
      const pcLine = changes.map(c => {
        const color = (c.val ?? 0) > 0 ? GREEN : (c.val ?? 0) < 0 ? RED : DIM;
        return `  ${c.label}: ${color}${fmtPct(c.val)}${RESET}`;
      }).join("  ");
      console.log(pcLine);
      console.log();

      // ALIEN Score
      const sc = scoreColor(alienScore);
      console.log(`  ${BOLD}ALIEN Score:${RESET} ${sc}${alienScore}/100${RESET}`);
      console.log(`    FDV: ${sFDV}  Liq: ${sLiq}  Vol: ${sVol}  Mom: ${sMom}  Tx: ${sTx}  Risk: ${sRisk}`);
      console.log();

      // Safety
      console.log(`  ${DIM}Safety Analysis:${RESET}`);
      console.log(`    NoMint:   ${noMint === true ? `${GREEN}✓${RESET}` : noMint === false ? `${RED}✗${RESET}` : "-"}`);
      console.log(`    NoFreeze: ${noFreeze === true ? `${GREEN}✓${RESET}` : noFreeze === false ? `${RED}✗${RESET}` : "-"}`);
      console.log(`    Holders:  ${holders >= 200 ? GREEN : holders >= 50 ? "\x1b[33m" : RED}${holders > 0 ? holders.toLocaleString() : "-"}${RESET}`);

      if (pumpData) {
        console.log();
        console.log(`  ${DIM}Pump.fun Status:${RESET}`);
        console.log(`    Graduated: ${graduated ? `${GREEN}YES${RESET}` : `${RED}NO${RESET}`}`);
        console.log(`    Progress:  ${progress.toFixed(1)}%`);
      }

      if (verbose) {
        console.log();
        console.log(`  ${DIM}Extended Metrics:${RESET}`);
        console.log(`    Vol/MCap:  ${volRatio.toFixed(1)}%`);
        console.log(`    Liq/MCap:  ${liqRatio.toFixed(1)}%`);
        if (txns.m5) console.log(`    5m Txns:   ${(txns.m5.buys ?? 0)}B / ${(txns.m5.sells ?? 0)}S`);
        if (txns.h1) console.log(`    1h Txns:   ${(txns.h1.buys ?? 0)}B / ${(txns.h1.sells ?? 0)}S`);
        if (txns.h24) console.log(`    24h Txns:  ${(txns.h24.buys ?? 0)}B / ${(txns.h24.sells ?? 0)}S`);
        const momentum = ((change5m * 2) + (pc.h1 ?? 0)) / 3;
        console.log(`    Momentum:  ${momentum >= 0 ? "+" : ""}${momentum.toFixed(1)}%`);
        const buys5 = txns.m5?.buys ?? 0;
        const sells5 = txns.m5?.sells ?? 0;
        if (buys5 + sells5 > 0) {
          const flow = Math.round((buys5 / (buys5 + sells5)) * 100);
          console.log(`    5m Flow:   ${flow}% Buy`);
        }
      }

      console.log();
    });
}
