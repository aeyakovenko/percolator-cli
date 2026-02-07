import { Command } from "commander";
import { PublicKey } from "@solana/web3.js";
import { getGlobalFlags } from "../cli.js";
import { loadConfig } from "../config.js";
import { createContext } from "../runtime/context.js";
import {
  fetchSlab,
  parseHeader,
  parseConfig,
  parseEngine,
  parseParams,
} from "../solana/slab.js";
import { validatePublicKey } from "../validation.js";

const BURNED_ADMIN = new PublicKey("11111111111111111111111111111111");
const ZERO_PUBKEY = new PublicKey("11111111111111111111111111111111");

interface ImmutabilityCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export function registerVerifyImmutability(program: Command): void {
  program
    .command("verify-immutability")
    .description(
      "Verify on-chain that the market is adminless and immutable"
    )
    .requiredOption("--slab <pubkey>", "Slab account public key")
    .action(async (opts, cmd) => {
      const flags = getGlobalFlags(cmd);
      const config = loadConfig(flags);
      const ctx = createContext(config);

      const slabPk = validatePublicKey(opts.slab, "--slab");
      const data = await fetchSlab(ctx.connection, slabPk);

      const header = parseHeader(data);
      const mktConfig = parseConfig(data);
      const engine = parseEngine(data);
      const params = parseParams(data);

      const checks: ImmutabilityCheck[] = [];

      // 1. Admin is burned
      const adminBurned = header.admin.equals(BURNED_ADMIN);
      checks.push({
        name: "admin_burned",
        passed: adminBurned,
        detail: adminBurned
          ? `Admin is system program (${BURNED_ADMIN.toBase58()})`
          : `Admin is NOT burned: ${header.admin.toBase58()}`,
      });

      // 2. Oracle authority is zero or non-functional
      const oracleAuthorityZero = mktConfig.oracleAuthority.equals(ZERO_PUBKEY);
      const oracleAuthorityNonFunctional =
        oracleAuthorityZero || (adminBurned && mktConfig.authorityPriceE6 === 0n);
      checks.push({
        name: "oracle_authority_disabled",
        passed: oracleAuthorityNonFunctional,
        detail: oracleAuthorityZero
          ? "Oracle authority is zero address (disabled)"
          : adminBurned
            ? `Oracle authority set to ${mktConfig.oracleAuthority.toBase58()} but admin is burned (cannot be changed). Authority price: ${mktConfig.authorityPriceE6}`
            : `WARNING: Oracle authority is ${mktConfig.oracleAuthority.toBase58()} and admin is NOT burned`,
      });

      // 3. Market is not resolved (resolved markets are finalized differently)
      checks.push({
        name: "market_active",
        passed: !header.resolved,
        detail: header.resolved
          ? "Market is RESOLVED (finalized)"
          : "Market is active (not resolved)",
      });

      // 4. Insurance fund is non-withdrawable (consequence of admin burn)
      checks.push({
        name: "insurance_non_withdrawable",
        passed: adminBurned,
        detail: adminBurned
          ? "Insurance fund cannot be withdrawn (admin burned)"
          : "WARNING: Insurance fund CAN be withdrawn by admin",
      });

      // 5. Config cannot be updated (consequence of admin burn)
      checks.push({
        name: "config_immutable",
        passed: adminBurned,
        detail: adminBurned
          ? "Config parameters are frozen (admin burned)"
          : "WARNING: Config CAN be modified by admin",
      });

      // 6. Risk threshold cannot be changed (consequence of admin burn)
      checks.push({
        name: "risk_threshold_immutable",
        passed: adminBurned,
        detail: adminBurned
          ? "Risk threshold is frozen (admin burned)"
          : "WARNING: Risk threshold CAN be modified by admin",
      });

      // 7. Slab cannot be closed (consequence of admin burn)
      checks.push({
        name: "slab_non_closeable",
        passed: adminBurned,
        detail: adminBurned
          ? "Slab cannot be closed (admin burned)"
          : "WARNING: Slab CAN be closed by admin",
      });

      const allPassed = checks.every((c) => c.passed);

      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              slab: slabPk.toBase58(),
              immutable: allPassed,
              admin: header.admin.toBase58(),
              oracleAuthority: mktConfig.oracleAuthority.toBase58(),
              resolved: header.resolved,
              checks: checks.map((c) => ({
                name: c.name,
                passed: c.passed,
                detail: c.detail,
              })),
              snapshot: {
                version: header.version,
                tradingFeeBps: params.tradingFeeBps.toString(),
                maintenanceMarginBps: params.maintenanceMarginBps.toString(),
                initialMarginBps: params.initialMarginBps.toString(),
                riskReductionThreshold: params.riskReductionThreshold.toString(),
                insuranceBalance: engine.insuranceFund.balance.toString(),
                insuranceFeeRevenue: engine.insuranceFund.feeRevenue.toString(),
                vault: engine.vault.toString(),
                totalOpenInterest: engine.totalOpenInterest.toString(),
              },
            },
            null,
            2
          )
        );
      } else {
        console.log("=== Immutability Verification ===");
        console.log(`Slab: ${slabPk.toBase58()}`);
        console.log("");

        for (const check of checks) {
          const icon = check.passed ? "PASS" : "FAIL";
          console.log(`[${icon}] ${check.name}`);
          console.log(`       ${check.detail}`);
        }

        console.log("");
        console.log("--- Frozen Parameters Snapshot ---");
        console.log(`Trading Fee:             ${params.tradingFeeBps} bps`);
        console.log(`Maintenance Margin:      ${params.maintenanceMarginBps} bps`);
        console.log(`Initial Margin:          ${params.initialMarginBps} bps`);
        console.log(`Risk Reduction Threshold:${params.riskReductionThreshold}`);
        console.log(`Liquidation Fee:         ${params.liquidationFeeBps} bps`);
        console.log(`Liquidation Fee Cap:     ${params.liquidationFeeCap}`);
        console.log(`Max Crank Staleness:     ${params.maxCrankStalenessSlots} slots`);

        console.log("");
        if (allPassed) {
          console.log("RESULT: Market is IMMUTABLE. No entity can modify parameters.");
        } else {
          console.log(
            "RESULT: Market is NOT fully immutable. See FAIL checks above."
          );
        }
      }
    });
}
