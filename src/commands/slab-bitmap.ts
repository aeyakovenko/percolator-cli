import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseUsedIndices, parseEngine } from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

export function registerSlabBitmap(program: Command): void {
  program
    .command("slab:bitmap")
    .description("Show which account indices are in use")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const data = await fetchSlab(ctx.connection, slabPk);
      const indices = parseUsedIndices(data);
      const engine = parseEngine(data);

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              numUsed: engine.numUsedAccounts,
              maxAccounts: 4096,
              usedIndices: indices,
            },
            null,
            2
          )
        );
      } else {
        console.log(`Used: ${engine.numUsedAccounts} / 4096 accounts\n`);

        if (indices.length === 0) {
          console.log("No accounts in use");
          return;
        }

        // Show indices in a compact format
        console.log("Used indices:");

        // Group into ranges for compact display
        const ranges: string[] = [];
        let start = indices[0];
        let end = indices[0];

        for (let i = 1; i < indices.length; i++) {
          if (indices[i] === end + 1) {
            end = indices[i];
          } else {
            ranges.push(start === end ? `${start}` : `${start}-${end}`);
            start = indices[i];
            end = indices[i];
          }
        }
        ranges.push(start === end ? `${start}` : `${start}-${end}`);

        // Print in rows of ~60 chars
        let line = "  ";
        for (const range of ranges) {
          if (line.length + range.length + 2 > 70) {
            console.log(line);
            line = "  ";
          }
          line += range + ", ";
        }
        if (line.length > 2) {
          console.log(line.slice(0, -2)); // Remove trailing ", "
        }
      }
    });
}
