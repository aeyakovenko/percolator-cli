import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, readNonce } from "../solana/slab.js";

export function registerSlabNonce(program: Command): void {
  program
    .command("slab:nonce")
    .description("Display current slab nonce")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const data = await fetchSlab(ctx.connection, slabPk);
      const nonce = readNonce(data);

      if (flags.json) {
        console.log(JSON.stringify({ nonce: nonce.toString() }, null, 2));
      } else {
        console.log(`Nonce: ${nonce}`);
      }
    });
}
