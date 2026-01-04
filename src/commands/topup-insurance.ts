import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { getAta } from "../solana/ata.js";
import { encodeTopUpInsurance } from "../abi/instructions.js";
import {
  ACCOUNTS_TOPUP_INSURANCE,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";

export function registerTopupInsurance(program: Command): void {
  program
    .command("topup-insurance")
    .description("Top up the insurance fund")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--amount <string>", "Amount to deposit (native units)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);

      // Fetch slab config for vault
      const data = await fetchSlab(ctx.connection, slabPk);
      const mktConfig = parseConfig(data);

      // Get user's ATA for the collateral mint
      const userAta = await getAta(ctx.payer.publicKey, mktConfig.collateralMint);

      // Build instruction data
      const ixData = encodeTopUpInsurance({ amount: opts.amount });

      // Build account metas (order matches ACCOUNTS_TOPUP_INSURANCE)
      const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
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
