import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { getAta } from "../solana/ata.js";
import { encodeDepositCollateral } from "../abi/instructions.js";
import {
  ACCOUNTS_DEPOSIT_COLLATERAL,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";

export function registerDeposit(program: Command): void {
  program
    .command("deposit")
    .description("Deposit collateral to user account")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--user-idx <number>", "User account index")
    .requiredOption("--amount <string>", "Amount to deposit (native units)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const userIdx = parseInt(opts.userIdx, 10);
      const amount = opts.amount;

      // Fetch slab config for vault
      const data = await fetchSlab(ctx.connection, slabPk);
      const mktConfig = parseConfig(data);

      // Get user's ATA for the collateral mint
      const userAta = await getAta(ctx.payer.publicKey, mktConfig.collateralMint);

      // Build instruction data
      const ixData = encodeDepositCollateral({ userIdx, amount });

      // Build account metas (order matches ACCOUNTS_DEPOSIT_COLLATERAL)
      const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
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
