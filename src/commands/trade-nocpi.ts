import { Command } from "commander";
import { PublicKey, Keypair } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { loadKeypair } from "../solana/wallet.js";
import { encodeTradeNoCpi } from "../abi/instructions.js";
import {
  ACCOUNTS_TRADE_NOCPI,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";

export function registerTradeNocpi(program: Command): void {
  program
    .command("trade-nocpi")
    .description("Execute direct trade (no CPI)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--lp-idx <number>", "LP account index")
    .requiredOption("--user-idx <number>", "User account index")
    .requiredOption("--size <string>", "Trade size (i128, positive=long, negative=short)")
    .requiredOption("--oracle <pubkey>", "Price oracle account")
    .option("--lp-wallet <path>", "LP wallet keypair (if different from payer)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = new PublicKey(opts.slab);
      const oracle = new PublicKey(opts.oracle);
      const lpIdx = parseInt(opts.lpIdx, 10);
      const userIdx = parseInt(opts.userIdx, 10);

      // Load LP keypair if provided, otherwise use payer
      const lpKeypair = opts.lpWallet ? loadKeypair(opts.lpWallet) : ctx.payer;

      // Build instruction data
      const ixData = encodeTradeNoCpi({
        lpIdx,
        userIdx,
        size: opts.size,
      });

      // Build account metas (order matches ACCOUNTS_TRADE_NOCPI)
      const keys = buildAccountMetas(ACCOUNTS_TRADE_NOCPI, [
        ctx.payer.publicKey, // user
        lpKeypair.publicKey, // lp
        slabPk, // slab
        WELL_KNOWN.clock, // clock
        oracle, // oracle
      ]);

      const ix = buildIx({
        programId: ctx.programId,
        keys,
        data: ixData,
      });

      // Determine signers
      const signers: Keypair[] =
        lpKeypair.publicKey.equals(ctx.payer.publicKey)
          ? [ctx.payer]
          : [ctx.payer, lpKeypair];

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
