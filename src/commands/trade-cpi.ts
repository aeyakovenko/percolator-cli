import { Command } from "commander";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig, parseAccount } from "../solana/slab.js";
import { deriveLpPda } from "../solana/pda.js";
import { encodeTradeCpi } from "../abi/instructions.js";
import {
  ACCOUNTS_TRADE_CPI,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import {
  validatePublicKey,
  validateIndex,
  validateI128,
} from "../validation.js";

export function registerTradeCpi(program: Command): void {
  program
    .command("trade-cpi")
    .description("Execute trade via CPI through matcher")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--lp-idx <number>", "LP account index")
    .requiredOption("--user-idx <number>", "User account index")
    .requiredOption("--size <string>", "Trade size (i128, positive=long, negative=short)")
    .requiredOption("--matcher-program <pubkey>", "Matcher program ID")
    .requiredOption("--matcher-context <pubkey>", "Matcher context account")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      // Validate inputs
      const slabPk = validatePublicKey(opts.slab, "--slab");
      const matcherProgram = validatePublicKey(opts.matcherProgram, "--matcher-program");
      const matcherContext = validatePublicKey(opts.matcherContext, "--matcher-context");
      const lpIdx = validateIndex(opts.lpIdx, "--lp-idx");
      const userIdx = validateIndex(opts.userIdx, "--user-idx");
      validateI128(opts.size, "--size");

      // Fetch slab config for oracle
      const data = await fetchSlab(ctx.connection, slabPk);
      const mktConfig = parseConfig(data);

      // Derive LP PDA
      const [lpPda] = deriveLpPda(ctx.programId, slabPk, lpIdx);

      // Read LP owner from slab (no keypair needed — lpOwner is not a signer for trade-cpi)
      const lpAccount = parseAccount(data, lpIdx);
      const lpOwnerPk = lpAccount.owner;

      // Build instruction data
      const ixData = encodeTradeCpi({
        lpIdx,
        userIdx,
        size: opts.size,
      });

      // Build account metas (order matches ACCOUNTS_TRADE_CPI)
      const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
        ctx.payer.publicKey, // user (signer)
        lpOwnerPk, // lpOwner (read from slab, not a signer)
        slabPk, // slab
        WELL_KNOWN.clock, // clock
        mktConfig.indexFeedId, // oracle (use index feed ID from config)
        matcherProgram, // matcherProg
        matcherContext, // matcherCtx
        lpPda, // lpPda
      ]);

      const ix = buildIx({
        programId: ctx.programId,
        keys,
        data: ixData,
      });

      // Only the user (payer) signs — lpOwner does not sign for trade-cpi
      const signers: Keypair[] = [ctx.payer];

      const result = await simulateOrSend({
        connection: ctx.connection,
        ix,
        signers,
        simulate: flags.simulate ?? false,
        commitment: ctx.commitment,
      });

      console.log(formatResult(result, flags.json ?? false));
    });
}
