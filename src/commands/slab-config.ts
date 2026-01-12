import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig, parseHeader } from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

export function registerSlabConfig(program: Command): void {
  program
    .command("slab:config")
    .description("Display slab market config")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const data = await fetchSlab(ctx.connection, slabPk);
      const header = parseHeader(data);
      const mktConfig = parseConfig(data);

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              admin: header.admin.toBase58(),
              collateralMint: mktConfig.collateralMint.toBase58(),
              vault: mktConfig.vaultPubkey.toBase58(),
              indexFeedId: mktConfig.indexFeedId.toBase58(),
              maxStalenessSlots: mktConfig.maxStalenessSlots.toString(),
              confFilterBps: mktConfig.confFilterBps,
              vaultAuthorityBump: mktConfig.vaultAuthorityBump,
              invert: mktConfig.invert,
              unitScale: mktConfig.unitScale,
            },
            null,
            2
          )
        );
      } else {
        console.log(`Admin:              ${header.admin.toBase58()}`);
        console.log(`Collateral Mint:    ${mktConfig.collateralMint.toBase58()}`);
        console.log(`Vault:              ${mktConfig.vaultPubkey.toBase58()}`);
        console.log(`Index Feed ID:      ${mktConfig.indexFeedId.toBase58()}`);
        console.log(`Max Staleness:      ${mktConfig.maxStalenessSlots} slots`);
        console.log(`Conf Filter:        ${mktConfig.confFilterBps} bps`);
        console.log(`Vault Auth Bump:    ${mktConfig.vaultAuthorityBump}`);
        console.log(`Invert:             ${mktConfig.invert}`);
        console.log(`Unit Scale:         ${mktConfig.unitScale}`);
      }
    });
}
