import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { parseHeader, parseConfig, parseEngine, parseParams } from "../solana/slab.js";

// PERCOLAT magic bytes
const PERCOLAT_MAGIC = Buffer.from([0x50, 0x45, 0x52, 0x43, 0x4f, 0x4c, 0x41, 0x54]);
const SLAB_SIZE = 1107176;

export function registerListMarkets(program: Command): void {
  program
    .command("list-markets")
    .description("Find and list all markets (slabs) owned by the program")
    .option("--verbose", "Show detailed market info")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);
      const verbose = opts.verbose ?? false;
      const json = flags.json ?? false;

      console.log(`Searching for markets owned by ${ctx.programId.toBase58()}...`);

      // Find all program accounts with slab size
      let accounts;
      try {
        accounts = await ctx.connection.getProgramAccounts(ctx.programId, {
          filters: [{ dataSize: SLAB_SIZE }],
        });
      } catch {
        // Fallback with memcmp filter
        accounts = await ctx.connection.getProgramAccounts(ctx.programId, {
          filters: [
            { memcmp: { offset: 0, bytes: PERCOLAT_MAGIC.toString("base64") } },
          ],
        });
      }

      // Filter to valid slabs
      const markets = accounts.filter(({ account }) => {
        if (account.data.length < 8) return false;
        return account.data.subarray(0, 8).equals(PERCOLAT_MAGIC);
      });

      if (json) {
        const result = markets.map(({ pubkey, account }) => {
          const data = account.data;
          const header = parseHeader(data);
          const config = parseConfig(data);
          const engine = parseEngine(data);
          const params = parseParams(data);

          return {
            pubkey: pubkey.toBase58(),
            lamports: account.lamports,
            version: Number(header.version),
            collateralMint: config.collateralMint.toBase58(),
            invert: config.invert,
            unitScale: config.unitScale,
            numAccounts: engine.numUsedAccounts,
            insuranceFund: engine.insuranceFund.balance.toString(),
            totalOI: engine.totalOpenInterest.toString(),
            riskReductionOnly: engine.riskReductionOnly,
            initialMarginBps: Number(params.initialMarginBps),
            maintenanceMarginBps: Number(params.maintenanceMarginBps),
          };
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`\nFound ${markets.length} market(s):\n`);

      for (const { pubkey, account } of markets) {
        const data = account.data;
        const header = parseHeader(data);
        const config = parseConfig(data);
        const engine = parseEngine(data);
        const params = parseParams(data);

        console.log(`Market: ${pubkey.toBase58()}`);
        console.log(`  Collateral: ${config.collateralMint.toBase58()}`);
        console.log(`  Inverted: ${config.invert === 1 ? "Yes" : "No"}`);
        console.log(`  Accounts: ${engine.numUsedAccounts}`);
        console.log(`  Insurance: ${Number(engine.insuranceFund.balance) / 1e6} USDC`);
        console.log(`  Open Interest: ${engine.totalOpenInterest}`);

        if (verbose) {
          console.log(`  Version: ${header.version}`);
          console.log(`  Unit Scale: ${config.unitScale}`);
          console.log(`  Initial Margin: ${Number(params.initialMarginBps) / 100}%`);
          console.log(`  Maintenance Margin: ${Number(params.maintenanceMarginBps) / 100}%`);
          console.log(`  Liquidation Fee: ${Number(params.liquidationFeeBps) / 100}%`);
          console.log(`  Trading Fee: ${Number(params.tradingFeeBps) / 100}%`);
          console.log(`  Risk Reduction Mode: ${engine.riskReductionOnly}`);
          console.log(`  Funding Index: ${engine.fundingIndexQpbE6}`);
          console.log(`  Rent: ${account.lamports / 1e9} SOL`);
        }
        console.log();
      }

      if (markets.length === 0) {
        console.log("No markets found.");
      }
    });
}
