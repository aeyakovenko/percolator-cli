import { Command } from "commander";
import { Keypair } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { loadKeypair } from "../solana/wallet.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";
import { encodeTradeNoCpi } from "../abi/instructions.js";
import {
  ACCOUNTS_TRADE_NOCPI,
  buildAccountMetas,
  WELL_KNOWN,
} from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import {
  validatePublicKey,
  validateIndex,
  validateI128,
  validateAmount,
} from "../validation.js";

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
    .option("--max-price <string>", "Max acceptable price (e6 units, client-side slippage guard)")
    .option("--min-price <string>", "Min acceptable price (e6 units, client-side slippage guard)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      // Validate inputs
      const slabPk = validatePublicKey(opts.slab, "--slab");
      const oracle = validatePublicKey(opts.oracle, "--oracle");
      const lpIdx = validateIndex(opts.lpIdx, "--lp-idx");
      const userIdx = validateIndex(opts.userIdx, "--user-idx");
      validateI128(opts.size, "--size");

      // Client-side slippage protection: check last effective price against user bounds
      if (opts.maxPrice || opts.minPrice) {
        const data = await fetchSlab(ctx.connection, slabPk);
        const mktConfig = parseConfig(data);
        const currentPrice = mktConfig.lastEffectivePriceE6;

        if (opts.maxPrice) {
          const maxPrice = validateAmount(opts.maxPrice, "--max-price");
          if (currentPrice > maxPrice) {
            throw new Error(
              `Current price ${currentPrice} exceeds --max-price ${maxPrice}. ` +
              `Trade aborted (client-side slippage guard).`
            );
          }
        }
        if (opts.minPrice) {
          const minPrice = validateAmount(opts.minPrice, "--min-price");
          if (currentPrice < minPrice) {
            throw new Error(
              `Current price ${currentPrice} is below --min-price ${minPrice}. ` +
              `Trade aborted (client-side slippage guard).`
            );
          }
        }
      }

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
