import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { getAta } from "../solana/ata.js";
import { encodeInitUser } from "../abi/instructions.js";
import {
  ACCOUNTS_INIT_USER,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey, validateU128 } from "../validation.js";

export function registerInitUser(program: Command): void {
  program
    .command("init-user")
    .description("Initialize a new user account")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--fee <string>", "Fee payment amount (native units)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      // Validate inputs
      const slabPk = validatePublicKey(opts.slab, "--slab");
      validateU128(opts.fee, "--fee");

      // Fetch slab config for mint, vault, oracle
      const data = await fetchSlab(ctx.connection, slabPk);
      const mktConfig = parseConfig(data);

      // Get user's ATA for the collateral mint
      const userAta = await getAta(ctx.payer.publicKey, mktConfig.collateralMint);

      // Build instruction data
      const ixData = encodeInitUser({ feePayment: opts.fee });

      // Build account metas (order matches ACCOUNTS_INIT_USER: 5 accounts)
      const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [
        ctx.payer.publicKey, // user (signer)
        slabPk, // slab (writable)
        userAta, // userAta (writable)
        mktConfig.vaultPubkey, // vault (writable)
        WELL_KNOWN.tokenProgram, // tokenProgram
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

      console.log(formatResult(result, flags.json ?? false));
    });
}
