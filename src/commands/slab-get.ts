import { Command } from "commander";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import { fetchSlab, parseHeader, parseConfig } from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

export function registerSlabGet(program: Command): void {
  program
    .command("slab:get")
    .description("Fetch and display full slab info")
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const data = await fetchSlab(ctx.connection, slabPk, ctx.programId);
      const header = parseHeader(data);
      const mktConfig = parseConfig(data);

      const output = {
        slab: slabPk.toBase58(),
        dataLen: data.length,
        header: {
          magic: header.magic.toString(16),
          version: header.version,
          bump: header.bump,
          admin: header.admin.toBase58(),
          nonce: header.nonce.toString(),
          matCounter: header.matCounter.toString(),
          insuranceAuthority: header.insuranceAuthority.toBase58(),
          insuranceOperator: header.insuranceOperator.toBase58(),
        },
        config: {
          collateralMint: mktConfig.collateralMint.toBase58(),
          vault: mktConfig.vaultPubkey.toBase58(),
          indexFeedId: mktConfig.indexFeedId.toBase58(),
          maxStalenessSecs: mktConfig.maxStalenessSecs.toString(),
          confFilterBps: mktConfig.confFilterBps,
          vaultAuthorityBump: mktConfig.vaultAuthorityBump,
          invert: mktConfig.invert,
          unitScale: mktConfig.unitScale,
          maintenanceFeePerSlot: mktConfig.maintenanceFeePerSlot.toString(),
          oracleTargetPriceE6: mktConfig.oracleTargetPriceE6.toString(),
          oracleTargetPublishTime: mktConfig.oracleTargetPublishTime.toString(),
          insuranceWithdrawDepositRemaining: mktConfig.insuranceWithdrawDepositRemaining.toString(),
        },
      };

      if (flags.json) {
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`Slab: ${output.slab}`);
        console.log(`Data Length: ${output.dataLen} bytes`);
        console.log("\n--- Header ---");
        console.log(`Magic:              0x${output.header.magic}`);
        console.log(`Version:            ${output.header.version}`);
        console.log(`Bump:               ${output.header.bump}`);
        console.log(`Admin:              ${output.header.admin}`);
        console.log(`Nonce:              ${output.header.nonce}`);
        console.log(`Mat Counter:        ${output.header.matCounter}`);
        console.log(`Insurance Auth:     ${output.header.insuranceAuthority}`);
        console.log(`Insurance Operator: ${output.header.insuranceOperator}`);
        console.log("\n--- Config ---");
        console.log(`Collateral Mint:    ${output.config.collateralMint}`);
        console.log(`Vault:              ${output.config.vault}`);
        console.log(`Index Feed ID:      ${output.config.indexFeedId}`);
        console.log(`Max Staleness:      ${output.config.maxStalenessSecs} seconds`);
        console.log(`Conf Filter:        ${output.config.confFilterBps} bps`);
        console.log(`Vault Auth Bump:    ${output.config.vaultAuthorityBump}`);
        console.log(`Invert:             ${output.config.invert}`);
        console.log(`Unit Scale:         ${output.config.unitScale}`);
        console.log(`Maintenance Fee/slot: ${output.config.maintenanceFeePerSlot}`);
        console.log(`Oracle Target Px E6: ${output.config.oracleTargetPriceE6}`);
        console.log(`Oracle Target Time:  ${output.config.oracleTargetPublishTime}`);
        console.log(`Ins Withdraw Remain: ${output.config.insuranceWithdrawDepositRemaining}`);
      }
    });
}
