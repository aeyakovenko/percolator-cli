import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import {
  fetchSlab,
  parseHeader,
  parseEngine,
  parseParams,
  parseConfig,
} from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

const BURNED_ADMIN = new PublicKey("11111111111111111111111111111111");

export function registerInsuranceStatus(program: Command): void {
  program
    .command("insurance:status")
    .description(
      "Display insurance fund status: balance, fee revenue, growth metrics"
    )
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const data = await fetchSlab(ctx.connection, slabPk);

      const header = parseHeader(data);
      const engine = parseEngine(data);
      const params = parseParams(data);
      const mktConfig = parseConfig(data);

      const balance = engine.insuranceFund.balance;
      const feeRevenue = engine.insuranceFund.feeRevenue;
      const vault = engine.vault;
      const adminBurned = header.admin.equals(BURNED_ADMIN);

      // Fee capture ratio: what fraction of fee revenue is still in insurance
      // If balance > feeRevenue, external topups have been made
      // If balance < feeRevenue, liquidation shortfalls have consumed some
      const feeRetentionPct =
        feeRevenue > 0n
          ? Number((balance * 10000n) / feeRevenue) / 100
          : balance > 0n
            ? Infinity
            : 0;

      // Insurance as percentage of vault
      const insuranceToVaultPct =
        vault > 0n ? Number((balance * 10000n) / vault) / 100 : 0;

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              slab: slabPk.toBase58(),
              insurance: {
                balance: balance.toString(),
                feeRevenue: feeRevenue.toString(),
                feeRetentionPct: feeRetentionPct === Infinity ? "Infinity" : feeRetentionPct,
                insuranceToVaultPct,
              },
              vault: vault.toString(),
              tradingFeeBps: params.tradingFeeBps.toString(),
              withdrawable: !adminBurned,
              adminBurned,
            },
            null,
            2
          )
        );
      } else {
        console.log("=== Insurance Fund Status ===");
        console.log(`Slab: ${slabPk.toBase58()}`);
        console.log("");
        console.log("--- Balances ---");
        console.log(`Insurance Balance:       ${balance}`);
        console.log(`Cumulative Fee Revenue:  ${feeRevenue}`);
        console.log(`Vault Balance:           ${vault}`);
        console.log("");
        console.log("--- Ratios ---");
        console.log(
          `Fee Retention:           ${feeRetentionPct === Infinity ? "N/A (external topup only)" : feeRetentionPct.toFixed(2) + "%"}`
        );
        console.log(
          `Insurance / Vault:       ${insuranceToVaultPct.toFixed(2)}%`
        );
        console.log(`Trading Fee:             ${params.tradingFeeBps} bps`);
        console.log("");
        console.log("--- Security ---");
        console.log(
          `Withdrawable:            ${adminBurned ? "NO (admin burned)" : "YES (admin can withdraw after resolve)"}`
        );
        console.log(
          `Admin:                   ${header.admin.toBase58()}`
        );

        if (balance < feeRevenue) {
          const deficit = feeRevenue - balance;
          console.log("");
          console.log(
            `Note: Insurance balance is ${deficit} below cumulative fee revenue.`
          );
          console.log(
            "This indicates liquidation shortfalls have been absorbed by the insurance fund."
          );
        }
      }
    });
}
