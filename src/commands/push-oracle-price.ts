import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { encodePushOraclePrice } from "../abi/instructions.js";
import { ACCOUNTS_PUSH_ORACLE_PRICE, buildAccountMetas } from "../abi/accounts.js";
import { buildIx, simulateOrSend, formatResult } from "../runtime/tx.js";
import { validatePublicKey } from "../validation.js";

export function registerPushOraclePrice(program: Command): void {
  program
    .command("push-oracle-price")
    .description("Push admin oracle price for binary market settlement (authority only)")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .requiredOption("--price <number>", "Price in e6 format (YES=1000000, NO=1)")
    .option("--timestamp <number>", "Unix timestamp (default: current time)")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const priceE6 = BigInt(opts.price);
      const timestamp = opts.timestamp
        ? BigInt(opts.timestamp)
        : BigInt(Math.floor(Date.now() / 1000));

      const ixData = encodePushOraclePrice({ priceE6, timestamp });
      const keys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [
        ctx.payer.publicKey,
        slabPk,
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
