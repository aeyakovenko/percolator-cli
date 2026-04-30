import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { parseHeader, parseConfig, parseEngine, parseParams, SLAB_LEN } from "../solana/slab.js";

// PERCOLAT magic bytes
const PERCOLAT_MAGIC = Buffer.from([0x50, 0x45, 0x52, 0x43, 0x4f, 0x4c, 0x41, 0x54]);

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

      let accounts;
      try {
        accounts = await ctx.connection.getProgramAccounts(ctx.programId, {
          filters: [{ dataSize: SLAB_LEN }],
        });
      } catch {
        accounts = await ctx.connection.getProgramAccounts(ctx.programId, {
          filters: [
            { memcmp: { offset: 0, bytes: PERCOLAT_MAGIC.toString("base64") } },
          ],
        });
      }

      if (accounts.length === 0) {
        console.log("No markets found.");
        return;
      }

      console.log(`Found ${accounts.length} market(s):\n`);

      for (const { pubkey, account } of accounts) {
        try {
          const header = parseHeader(account.data);
          const config_ = parseConfig(account.data);
          const engine = parseEngine(account.data);
          const params = parseParams(account.data);

          if (verbose) {
            console.log(`Market: ${pubkey.toBase58()}`);
            console.log(`  Magic: ${header.magic.toString("hex")}`);
            console.log(`  Version: ${header.version}`);
            console.log(`  Slab size: ${header.slabSize}`);
            console.log(`  Collateral mint: ${config_.collateralMint.toBase58()}`);
            console.log(`  Vault: ${config_.vault.toBase58()}`);
            console.log(`  Oracle: ${config_.oracle.toBase58()}`);
            console.log(`  Mark price: ${engine.markE6} (e6)`);
            console.log(`  Index price: ${engine.idxE6} (e6)`);
            console.log(`  Total accounts: ${engine.totalAccounts}`);
            if (params) {
              console.log(`  Initial margin: ${params.initialMarginBps} bps`);
              console.log(`  Maintenance margin: ${params.maintenanceMarginBps} bps`);
              console.log(`  Trading fee: ${params.tradingFeeBps} bps`);
            }
            console.log();
          } else {
            console.log(`${pubkey.toBase58()} - mark: ${engine.markE6 / 1e6}, accounts: ${engine.totalAccounts}`);
          }
        } catch (e: any) {
          console.error(`Failed to parse ${pubkey.toBase58()}: ${e.message}`);
        }
      }

      if (json) {
        console.log(JSON.stringify(accounts.map(a => a.pubkey.toBase58()), null, 2));
      }
    });
}
