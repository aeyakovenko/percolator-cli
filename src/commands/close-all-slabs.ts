import { Command } from "commander";
import { PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeCloseSlab } from "../abi/instructions.js";
import {
  ACCOUNTS_CLOSE_SLAB,
  buildAccountMetas,
} from "../abi/accounts.js";
import { buildIx } from "../runtime/tx.js";

// PERCOLAT magic bytes for filtering
const PERCOLAT_MAGIC = Buffer.from([0x50, 0x45, 0x52, 0x43, 0x4f, 0x4c, 0x41, 0x54]);
const SLAB_SIZE = 1107176; // Expected slab size

export function registerCloseAllSlabs(program: Command): void {
  program
    .command("close-all-slabs")
    .description("Find and close all slab accounts owned by the program (devnet cleanup)")
    .option("--dry-run", "List slabs without closing them")
    .option("--limit <n>", "Maximum number of slabs to close", "100")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const dryRun = opts.dryRun ?? false;
      const limit = parseInt(opts.limit, 10);

      console.log(`Searching for slab accounts owned by ${ctx.programId.toBase58()}...`);

      // Find all program accounts with the correct size
      let accounts;
      try {
        accounts = await ctx.connection.getProgramAccounts(ctx.programId, {
          filters: [
            { dataSize: SLAB_SIZE },
          ],
        });
      } catch (e: any) {
        // Fallback for RPC providers that don't support getProgramAccounts well
        console.log("getProgramAccounts failed, trying memcmp filter...");
        accounts = await ctx.connection.getProgramAccounts(ctx.programId, {
          filters: [
            { memcmp: { offset: 0, bytes: PERCOLAT_MAGIC.toString("base64") } },
          ],
        });
      }

      // Filter to only include accounts with PERCOLAT magic
      const slabs = accounts.filter(({ account }) => {
        if (account.data.length < 8) return false;
        return account.data.subarray(0, 8).equals(PERCOLAT_MAGIC);
      });

      console.log(`Found ${slabs.length} slab account(s)`);

      if (slabs.length === 0) {
        console.log("No slabs to close.");
        return;
      }

      if (dryRun) {
        console.log("\nSlabs (dry run - not closing):");
        for (const { pubkey, account } of slabs.slice(0, limit)) {
          const lamports = account.lamports / 1e9;
          console.log(`  ${pubkey.toBase58()} - ${lamports.toFixed(4)} SOL`);
        }
        const totalSol = slabs.reduce((sum, { account }) => sum + account.lamports, 0) / 1e9;
        console.log(`\nTotal recoverable: ${totalSol.toFixed(4)} SOL`);
        return;
      }

      // Close slabs
      let closed = 0;
      let failed = 0;
      let totalRecovered = 0;

      const toClose = slabs.slice(0, limit);
      console.log(`\nClosing ${toClose.length} slab(s)...`);

      for (const { pubkey, account } of toClose) {
        try {
          const ixData = encodeCloseSlab();
          const keys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
            ctx.payer.publicKey,
            pubkey,
          ]);

          const ix = buildIx({
            programId: ctx.programId,
            keys,
            data: ixData,
          });

          const tx = new Transaction();
          tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
          tx.add(ix);

          const sig = await sendAndConfirmTransaction(ctx.connection, tx, [ctx.payer], {
            commitment: ctx.commitment,
          });

          const solRecovered = account.lamports / 1e9;
          totalRecovered += solRecovered;
          closed++;
          console.log(`  Closed ${pubkey.toBase58().slice(0, 8)}... (+${solRecovered.toFixed(4)} SOL)`);
        } catch (e: any) {
          failed++;
          console.log(`  Failed ${pubkey.toBase58().slice(0, 8)}...: ${e.message?.slice(0, 50)}`);
        }
      }

      console.log(`\nSummary:`);
      console.log(`  Closed: ${closed}`);
      console.log(`  Failed: ${failed}`);
      console.log(`  SOL recovered: ${totalRecovered.toFixed(4)}`);
    });
}
