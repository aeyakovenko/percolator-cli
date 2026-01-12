import { Command } from "commander";
import { Keypair } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { deriveLpPda } from "../solana/pda.js";
import { loadKeypair } from "../solana/wallet.js";
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
    .option("--lp-wallet <path>", "LP owner wallet keypair (if different from payer)")
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

      // Load LP owner keypair if provided, otherwise use payer
      const lpOwnerKeypair = opts.lpWallet ? loadKeypair(opts.lpWallet) : ctx.payer;

      // Build instruction data
      const ixData = encodeTradeCpi({
        lpIdx,
        userIdx,
        size: opts.size,
      });

      // Build account metas (order matches ACCOUNTS_TRADE_CPI)
      const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
        ctx.payer.publicKey, // user
        lpOwnerKeypair.publicKey, // lpOwner
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

      // Determine signers
      const signers: Keypair[] =
        lpOwnerKeypair.publicKey.equals(ctx.payer.publicKey)
          ? [ctx.payer]
          : [ctx.payer, lpOwnerKeypair];

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
