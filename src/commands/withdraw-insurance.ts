import { Command } from "commander";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodeWithdrawInsurance } from "../abi/instructions.js";
import { ACCOUNTS_WITHDRAW_INSURANCE, buildAccountMetas } from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey } from "../validation.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { deriveVaultAuthority } from "../solana/pda.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

export function registerWithdrawInsurance(program: Command): void {
  program
    .command("withdraw-insurance")
    .description("Withdraw insurance fund after market resolution (admin only)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");

      // Fetch slab config to get vault and mint
      const slabData = await fetchSlab(ctx.connection, slabPk);
      const slabConfig = parseConfig(slabData);

      const [vaultPda] = deriveVaultAuthority(ctx.programId, slabPk);
      const adminAta = await getAssociatedTokenAddress(
        slabConfig.collateralMint,
        ctx.payer.publicKey
      );

      const ixData = encodeWithdrawInsurance();
      const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
        ctx.payer.publicKey,
        slabPk,
        adminAta,
        slabConfig.vaultPubkey,
        TOKEN_PROGRAM_ID,
        vaultPda,
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
