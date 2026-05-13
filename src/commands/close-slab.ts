import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { getAta } from "../solana/ata.js";
import { deriveVaultAuthority } from "../solana/pda.js";
import { encodeCloseSlab } from "../abi/instructions.js";
import {
  ACCOUNTS_CLOSE_SLAB,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey } from "../validation.js";

export function registerCloseSlab(program: Command): void {
  program
    .command("close-slab")
    .description("Close a market slab and recover SOL to admin")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      // Validate inputs
      const slabPk = validatePublicKey(opts.slab, "--slab");

      // Fetch slab config for vault, mint
      const data = await fetchSlab(ctx.connection, slabPk, ctx.programId);
      const mktConfig = parseConfig(data);

      // Derive vault authority PDA
      const [vaultAuth] = deriveVaultAuthority(ctx.programId, slabPk);

      // Get admin's ATA for the collateral mint (for draining stranded tokens)
      const destAta = await getAta(ctx.payer.publicKey, mktConfig.collateralMint);

      // Build instruction data
      const ixData = encodeCloseSlab();

      // Build account metas (order matches ACCOUNTS_CLOSE_SLAB: 6 accounts)
      const keys = buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
        ctx.payer.publicKey, // dest (signer, writable)
        slabPk, // slab (writable)
        mktConfig.vaultPubkey, // vault (writable)
        vaultAuth, // vaultAuth
        destAta, // destAta (writable)
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
        rpcUrl: config.rpcUrl,
        allowMainnet: flags.yesMainnet ?? false,
      });

      console.log(formatResult(result, flags.json ?? false));
    });
}
