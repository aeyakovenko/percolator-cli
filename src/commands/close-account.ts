import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { getAta } from "../solana/ata.js";
import { deriveVaultAuthority } from "../solana/pda.js";
import { encodeCloseAccount } from "../abi/instructions.js";
import {
  ACCOUNTS_CLOSE_ACCOUNT,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";

export function registerCloseAccount(program: Command): void {
  program
    .command("close-account")
    .description("Close a user account and withdraw remaining collateral")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--user-idx <number>", "User account index to close")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const userIdx = parseInt(opts.userIdx, 10);

      // Fetch slab config for vault and oracle
      const data = await fetchSlab(ctx.connection, slabPk);
      const mktConfig = parseConfig(data);

      // Get user's ATA for the collateral mint
      const userAta = await getAta(ctx.payer.publicKey, mktConfig.collateralMint);

      // Derive vault authority PDA
      const [vaultPda] = deriveVaultAuthority(ctx.programId, slabPk);

      // Build instruction data
      const ixData = encodeCloseAccount({ userIdx });

      // Build account metas (order matches ACCOUNTS_CLOSE_ACCOUNT)
      const keys = buildAccountMetas(ACCOUNTS_CLOSE_ACCOUNT, [
        ctx.payer.publicKey, // user
        slabPk, // slab
        mktConfig.vaultPubkey, // vault
        userAta, // userAta
        vaultPda, // vaultPda
        WELL_KNOWN.tokenProgram, // tokenProgram
        WELL_KNOWN.clock, // clock
        mktConfig.indexOracle, // oracle
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
