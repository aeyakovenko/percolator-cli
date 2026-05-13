import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createReadOnlyContext } from "../runtime/context.js";
import { hasSlabMagic, parseHeader, parseConfig, parseEngine, parseParams, slabMagicMemcmpFilter, SLAB_LEN } from "../solana/slab.js";
export function registerListMarkets(program: Command): void {
  program
    .command("list-markets")
    .description("Find and list all markets (slabs) owned by the program")
    .option("--verbose", "Show detailed market info")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createReadOnlyContext(config);
      const verbose = opts.verbose ?? false;
      const json = flags.json ?? false;

      console.log(`Searching for markets owned by ${ctx.programId.toBase58()}...`);

      // Find all program accounts with slab size
      let accounts;
      try {
        accounts = await ctx.connection.getProgramAccounts(ctx.programId, {
          filters: [{ dataSize: SLAB_LEN }],
        });
      } catch {
        // Fallback with memcmp filter
        accounts = await ctx.connection.getProgramAccounts(ctx.programId, {
          filters: [slabMagicMemcmpFilter()],
        });
      }

      // Filter to valid slabs
      const markets = accounts.filter(({ account }) => {
        return hasSlabMagic(account.data);
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
            oiEffLongQ: engine.oiEffLongQ.toString(),
            oiEffShortQ: engine.oiEffShortQ.toString(),
            cTot: engine.cTot.toString(),
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
        console.log(`  OI Eff Long Q: ${engine.oiEffLongQ}`);
        console.log(`  OI Eff Short Q: ${engine.oiEffShortQ}`);

        if (verbose) {
          console.log(`  Version: ${header.version}`);
          console.log(`  Unit Scale: ${config.unitScale}`);
          console.log(`  Initial Margin: ${Number(params.initialMarginBps) / 100}%`);
          console.log(`  Maintenance Margin: ${Number(params.maintenanceMarginBps) / 100}%`);
          console.log(`  Liquidation Fee: ${Number(params.liquidationFeeBps) / 100}%`);
          console.log(`  Trading Fee: ${Number(params.tradingFeeBps) / 100}%`);
          console.log(`  C_tot: ${engine.cTot}`);
          console.log(`  Market Mode: ${engine.marketMode === 0 ? "Live" : "Resolved"}`);
          console.log(`  Rent: ${account.lamports / 1e9} SOL`);
        }
        console.log();
      }

      if (markets.length === 0) {
        console.log("No markets found.");
      }
    });
}
