import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseHeader } from "../solana/slab.js";
import { encodeUpdateAdmin } from "../abi/instructions.js";
import {
  ACCOUNTS_UPDATE_ADMIN,
  buildAccountMetas,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey } from "../validation.js";

/**
 * The burned admin address. The system program cannot sign transactions,
 * so transferring admin here permanently disables all admin-gated instructions.
 */
const BURNED_ADMIN = new PublicKey("11111111111111111111111111111111");

export function registerBurnAdmin(program: Command): void {
  program
    .command("burn-admin")
    .description(
      "Burn the admin key by transferring it to the system program (irreversible)"
    )
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .option(
      "--confirm",
      "Skip confirmation prompt (required for non-interactive use)"
    )
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");

      // Fetch current state to verify caller is admin
      const data = await fetchSlab(ctx.connection, slabPk);
      const header = parseHeader(data);

      // Check if already burned
      if (header.admin.equals(BURNED_ADMIN)) {
        console.log("Admin is already burned.");
        console.log(`Admin: ${header.admin.toBase58()}`);
        return;
      }

      // Check caller is current admin
      if (!header.admin.equals(ctx.payer.publicKey)) {
        console.error(
          `Error: Current admin is ${header.admin.toBase58()}, but wallet is ${ctx.payer.publicKey.toBase58()}`
        );
        console.error("Only the current admin can burn the admin key.");
        process.exit(1);
      }

      if (!opts.confirm && !flags.simulate) {
        console.error("WARNING: This operation is IRREVERSIBLE.");
        console.error(
          "After burning, no one can modify fees, risk params, oracle sources, or the matcher registry."
        );
        console.error("");
        console.error("The following operations will be permanently disabled:");
        console.error("  - update-config (funding/threshold parameters)");
        console.error("  - set-risk-threshold");
        console.error("  - update-admin");
        console.error("  - set-oracle-authority");
        console.error("  - resolve-market");
        console.error("  - close-slab");
        console.error("  - withdraw-insurance");
        console.error("");
        console.error("Pass --confirm to proceed, or --simulate to dry-run.");
        process.exit(1);
      }

      // Build UpdateAdmin instruction targeting the system program
      const ixData = encodeUpdateAdmin({ newAdmin: BURNED_ADMIN });
      const keys = buildAccountMetas(ACCOUNTS_UPDATE_ADMIN, [
        ctx.payer.publicKey, // admin (current)
        slabPk, // slab
      ]);

      const ix = buildIx({
        programId: ctx.programId,
        keys,
        data: ixData,
      });

      const result = await simulateOrSend({
        connection: ctx.connection,
        ix,
        signers: [ctx.payer],
        simulate: flags.simulate ?? false,
        commitment: ctx.commitment,
      });

      if (!result.err) {
        console.log("Admin key burned successfully.");
        console.log(`Admin transferred to: ${BURNED_ADMIN.toBase58()}`);
        console.log(
          "All admin-gated operations are now permanently disabled."
        );
        console.log("");
      }

      console.log(formatResult(result, flags.json ?? false));
    });
}
