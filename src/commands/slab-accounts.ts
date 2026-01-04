import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseAllAccounts, AccountKind } from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

export function registerSlabAccounts(program: Command): void {
  program
    .command("slab:accounts")
    .description("List all active accounts with summary")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const data = await fetchSlab(ctx.connection, slabPk);
      const accounts = parseAllAccounts(data);

      if (flags.json) {
        const output = accounts.map(({ idx, account }) => ({
          idx,
          kind: account.kind === AccountKind.LP ? "LP" : "User",
          accountId: account.accountId.toString(),
          owner: account.owner.toBase58(),
          capital: account.capital.toString(),
          pnl: account.pnl.toString(),
          positionSize: account.positionSize.toString(),
          entryPrice: account.entryPrice.toString(),
        }));
        console.log(JSON.stringify(output, null, 2));
      } else {
        if (accounts.length === 0) {
          console.log("No active accounts");
          return;
        }

        console.log(`Found ${accounts.length} active account(s):\n`);
        console.log("Idx   Type  AcctID  Owner                                        Capital              Position");
        console.log("----  ----  ------  -------------------------------------------  -------------------  --------------------");

        for (const { idx, account } of accounts) {
          const kindStr = account.kind === AccountKind.LP ? "LP  " : "User";
          const ownerShort = account.owner.toBase58();
          const capitalStr = account.capital.toString().padStart(19);
          const posStr = account.positionSize.toString().padStart(20);
          console.log(
            `${idx.toString().padStart(4)}  ${kindStr}  ${account.accountId.toString().padStart(6)}  ${ownerShort}  ${capitalStr}  ${posStr}`
          );
        }

        // Summary
        const users = accounts.filter(a => a.account.kind === AccountKind.User);
        const lps = accounts.filter(a => a.account.kind === AccountKind.LP);
        const totalCapital = accounts.reduce((sum, a) => sum + a.account.capital, 0n);
        const totalOI = accounts.reduce((sum, a) => {
          const pos = a.account.positionSize;
          return sum + (pos < 0n ? -pos : pos);
        }, 0n);

        console.log("");
        console.log(`Users: ${users.length}  |  LPs: ${lps.length}  |  Total Capital: ${totalCapital}  |  Total OI: ${totalOI}`);
      }
    });
}
