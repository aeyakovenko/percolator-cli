import { Command } from "commander";
import { Keypair } from "@solana/web3.js";
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
import {
  validatePublicKey,
  validateIndex,
  validateI128,
} from "../validation.js";
import { fetchSlab, parseConfig } from "../solana/slab.js";

export function registerTradeNocpi(program: Command): void {
  program
    .command("trade-nocpi")
    .description("Execute direct trade (no CPI). Optional client-side price bounds (TOCTOU; the on-chain TradeNoCpi has no limit field).")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--lp-idx <number>", "LP account index")
    .requiredOption("--user-idx <number>", "User account index")
    .requiredOption("--size <string>", "Trade size (i128, positive=long, negative=short)")
    .option("--oracle <pubkey>", "Oracle account (required for non-Hyperp markets; Hyperp markets use the slab itself)")
    .option("--lp-wallet <path>", "LP wallet keypair (if different from payer)")
    .option("--max-price-e6 <n>", "Abort before submit if slab.lastEffectivePriceE6 > this (e6 units)")
    .option("--min-price-e6 <n>", "Abort before submit if slab.lastEffectivePriceE6 < this (e6 units)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      // Validate inputs
      const slabPk = validatePublicKey(opts.slab, "--slab");
      const oracle = opts.oracle ? validatePublicKey(opts.oracle, "--oracle") : slabPk;
      const lpIdx = validateIndex(opts.lpIdx, "--lp-idx");
      const userIdx = validateIndex(opts.userIdx, "--user-idx");
      const size = validateI128(opts.size, "--size");

      // Load LP keypair if provided, otherwise use payer
      const lpKeypair = opts.lpWallet ? loadKeypair(opts.lpWallet) : ctx.payer;

      // Optional pre-submit price gate. lastEffectivePriceE6 is the
      // dt-capped staircase the engine will read for this trade
      // (modulo any oracle update that lands in the same slot — hence
      // TOCTOU). Cheaper than nothing for fat-finger guarding.
      if (opts.maxPriceE6 !== undefined || opts.minPriceE6 !== undefined) {
        const slabBuf = await fetchSlab(ctx.connection, slabPk);
        const cur = parseConfig(slabBuf).lastEffectivePriceE6;
        if (opts.maxPriceE6 !== undefined && cur > validateI128(opts.maxPriceE6, "--max-price-e6")) {
          throw new Error(`pre-submit price ${cur} > --max-price-e6 ${opts.maxPriceE6}`);
        }
        if (opts.minPriceE6 !== undefined && cur < validateI128(opts.minPriceE6, "--min-price-e6")) {
          throw new Error(`pre-submit price ${cur} < --min-price-e6 ${opts.minPriceE6}`);
        }
      }

      // Build instruction data
      const ixData = encodeTradeNoCpi({
        lpIdx,
        userIdx,
        size,
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
