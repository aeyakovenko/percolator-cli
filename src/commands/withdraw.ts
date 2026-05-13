import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { getAta } from "../solana/ata.js";
import { deriveVaultAuthority } from "../solana/pda.js";
import { encodeWithdrawCollateral } from "../abi/instructions.js";
import {
  ACCOUNTS_WITHDRAW_COLLATERAL,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import {
  validatePublicKey,
  validateIndex,
  validateAmount,
} from "../validation.js";

export function registerWithdraw(program: Command): void {
  program
    .command("withdraw")
    .description("Withdraw collateral from user account")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--user-idx <number>", "User account index")
    .requiredOption("--amount <string>", "Amount to withdraw (native units)")
    .option("--oracle <pubkey>", "Oracle account (required for non-Hyperp markets; Hyperp markets use the slab itself)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      // Validate inputs
      const slabPk = validatePublicKey(opts.slab, "--slab");
      const userIdx = validateIndex(opts.userIdx, "--user-idx");
      validateAmount(opts.amount, "--amount");
      const amount = opts.amount;

      // Fetch slab config for vault and oracles
      const data = await fetchSlab(ctx.connection, slabPk, ctx.programId);
      const mktConfig = parseConfig(data);

      // Get user's ATA for the collateral mint
      const userAta = await getAta(ctx.payer.publicKey, mktConfig.collateralMint);

      // Derive vault authority PDA
      const [vaultPda] = deriveVaultAuthority(ctx.programId, slabPk);

      // Build instruction data
      const ixData = encodeWithdrawCollateral({ userIdx, amount });

      // Pick oracle: explicit --oracle wins; otherwise Hyperp markets
      // pass the slab itself (wrapper accepts any pubkey when feed_id is
      // zero); non-Hyperp markets force the operator to be explicit
      // because indexFeedId is the Pyth feed-id hash, not the
      // PriceUpdateV2 account pubkey.
      let oracle: PublicKey;
      if (opts.oracle) {
        oracle = validatePublicKey(opts.oracle, "--oracle");
      } else {
        const ZERO = new PublicKey(new Uint8Array(32));
        if (mktConfig.indexFeedId.equals(ZERO)) {
          oracle = slabPk;
        } else {
          throw new Error(
            "Non-Hyperp market detected (indexFeedId ≠ 0). Pass --oracle <pubkey> with the Pyth/Chainlink account used at InitMarket."
          );
        }
      }

      // Build account metas (order matches ACCOUNTS_WITHDRAW_COLLATERAL)
      const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
        ctx.payer.publicKey, // user
        slabPk, // slab
        mktConfig.vaultPubkey, // vault
        userAta, // userAta
        vaultPda, // vaultPda
        WELL_KNOWN.tokenProgram, // tokenProgram
        WELL_KNOWN.clock, // clock
        oracle,
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
