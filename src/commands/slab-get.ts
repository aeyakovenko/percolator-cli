import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseHeader, parseConfig } from "../solana/slab.js";

export function registerSlabGet(program: Command): void {
  program
    .command("slab:get")
    .description("Fetch and display full slab info")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const data = await fetchSlab(ctx.connection, slabPk);
      const header = parseHeader(data);
      const mktConfig = parseConfig(data);

      const output = {
        slab: slabPk.toBase58(),
        dataLen: data.length,
        header: {
          magic: header.magic.toString(16),
          version: header.version,
          bump: header.bump,
          admin: header.admin.toBase58(),
          nonce: header.nonce.toString(),
          lastThrUpdateSlot: header.lastThrUpdateSlot.toString(),
        },
        config: {
          collateralMint: mktConfig.collateralMint.toBase58(),
          vault: mktConfig.vaultPubkey.toBase58(),
          collateralOracle: mktConfig.collateralOracle.toBase58(),
          indexOracle: mktConfig.indexOracle.toBase58(),
          maxStalenessSlots: mktConfig.maxStalenessSlots.toString(),
          confFilterBps: mktConfig.confFilterBps,
          vaultAuthorityBump: mktConfig.vaultAuthorityBump,
        },
      };

      if (flags.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`Slab: ${output.slab}`);
        console.log(`Data Length: ${output.dataLen} bytes`);
        console.log("\n--- Header ---");
        console.log(`Magic:              0x${output.header.magic}`);
        console.log(`Version:            ${output.header.version}`);
        console.log(`Bump:               ${output.header.bump}`);
        console.log(`Admin:              ${output.header.admin}`);
        console.log(`Nonce:              ${output.header.nonce}`);
        console.log(`Last Thr Update:    ${output.header.lastThrUpdateSlot}`);
        console.log("\n--- Config ---");
        console.log(`Collateral Mint:    ${output.config.collateralMint}`);
        console.log(`Vault:              ${output.config.vault}`);
        console.log(`Collateral Oracle:  ${output.config.collateralOracle}`);
        console.log(`Index Oracle:       ${output.config.indexOracle}`);
        console.log(`Max Staleness:      ${output.config.maxStalenessSlots} slots`);
        console.log(`Conf Filter:        ${output.config.confFilterBps} bps`);
        console.log(`Vault Auth Bump:    ${output.config.vaultAuthorityBump}`);
      }
    });
}
