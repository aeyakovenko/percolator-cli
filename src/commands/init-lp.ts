import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { getAta } from "../solana/ata.js";
import { encodeInitLP } from "../abi/instructions.js";
import {
  ACCOUNTS_INIT_LP,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey, validateU128 } from "../validation.js";

export function registerInitLp(program: Command): void {
  program
    .command("init-lp")
    .description("Initialize a new LP account")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--matcher-program <pubkey>", "Matcher program ID")
    .requiredOption("--matcher-context <pubkey>", "Matcher context account")
    .requiredOption("--fee <string>", "Fee payment amount (native units)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      // Validate inputs
      const slabPk = validatePublicKey(opts.slab, "--slab");
      const matcherProgram = validatePublicKey(opts.matcherProgram, "--matcher-program");
      const matcherContext = validatePublicKey(opts.matcherContext, "--matcher-context");
      validateU128(opts.fee, "--fee");

      // Fetch slab config for mint, vault, oracle
      const data = await fetchSlab(ctx.connection, slabPk);
      const mktConfig = parseConfig(data);

      // Get user's ATA for the collateral mint
      const userAta = await getAta(ctx.payer.publicKey, mktConfig.collateralMint);

      // Build instruction data
      const ixData = encodeInitLP({
        matcherProgram,
        matcherContext,
        feePayment: opts.fee,
      });

      // Build account metas (order matches ACCOUNTS_INIT_LP: 5 accounts)
      const keys = buildAccountMetas(ACCOUNTS_INIT_LP, [
        ctx.payer.publicKey, // user
        slabPk, // slab
        userAta, // userAta
        mktConfig.vaultPubkey, // vault
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
