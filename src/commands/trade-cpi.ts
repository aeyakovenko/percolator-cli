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
    .option("--limit-price-e6 <n>", "On-chain slippage limit (e6 units). For long trades, reject if fill price > limit; for short, reject if fill price < limit. 0 = disabled.")
    .option("--oracle <pubkey>", "Oracle account (required for non-Hyperp markets; Hyperp markets use the slab itself)")
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
      const size = validateI128(opts.size, "--size");

      // Fetch slab config for oracle
      const data = await fetchSlab(ctx.connection, slabPk, ctx.programId);
      const mktConfig = parseConfig(data);

      // Derive LP PDA
      const [lpPda] = deriveLpPda(ctx.programId, slabPk, lpIdx);

      // Read LP owner from slab (no keypair needed — lpOwner is not a signer for trade-cpi)
      const lpAccount = parseAccount(data, lpIdx);
      const lpOwnerPk = lpAccount.owner;

      // Build instruction data
      if (opts.limitPriceE6 !== undefined) {
        try { BigInt(opts.limitPriceE6); } catch {
          throw new Error(`Invalid --limit-price-e6: ${opts.limitPriceE6}`);
        }
      }
      const ixData = encodeTradeCpi({
        lpIdx,
        userIdx,
        size,
        limitPriceE6: opts.limitPriceE6 ?? "0",
      });

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

      // Build account metas (order matches ACCOUNTS_TRADE_CPI)
      const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
        ctx.payer.publicKey, // user (signer)
        lpOwnerPk, // lpOwner (read from slab, not a signer)
        slabPk, // slab
        WELL_KNOWN.clock, // clock
        oracle,
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
