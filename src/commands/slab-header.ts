import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseHeader } from "../solana/slab.js";

export function registerSlabHeader(program: Command): void {
  program
    .command("slab:header")
    .description("Display slab header")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const data = await fetchSlab(ctx.connection, slabPk);
      const header = parseHeader(data);

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              magic: header.magic.toString(16),
              version: header.version,
              bump: header.bump,
              admin: header.admin.toBase58(),
              nonce: header.nonce.toString(),
              lastThrUpdateSlot: header.lastThrUpdateSlot.toString(),
            },
            null,
            2
          )
        );
      } else {
        console.log(`Magic:              0x${header.magic.toString(16)}`);
        console.log(`Version:            ${header.version}`);
        console.log(`Bump:               ${header.bump}`);
        console.log(`Admin:              ${header.admin.toBase58()}`);
        console.log(`Nonce:              ${header.nonce}`);
        console.log(`Last Thr Update:    ${header.lastThrUpdateSlot}`);
      }
    });
}
