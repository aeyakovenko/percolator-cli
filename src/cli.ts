import { Command } from "commander";
import { GlobalFlags } from "./config.js";

// Import commands
import { registerInitMarket } from "./commands/init-market.js";
import { registerInitUser } from "./commands/init-user.js";
import { registerInitLp } from "./commands/init-lp.js";
import { registerDeposit } from "./commands/deposit.js";
import { registerWithdraw } from "./commands/withdraw.js";
import { registerKeeperCrank } from "./commands/keeper-crank.js";
import { registerTradeNocpi } from "./commands/trade-nocpi.js";
import { registerTradeCpi } from "./commands/trade-cpi.js";
import { registerLiquidateAtOracle } from "./commands/liquidate-at-oracle.js";
import { registerCloseAccount } from "./commands/close-account.js";
import { registerTopupInsurance } from "./commands/topup-insurance.js";
import { registerSetRiskThreshold } from "./commands/set-risk-threshold.js";
import { registerUpdateAdmin } from "./commands/update-admin.js";
import { registerCloseSlab } from "./commands/close-slab.js";
import { registerCloseAllSlabs } from "./commands/close-all-slabs.js";
import { registerSlabGet } from "./commands/slab-get.js";
import { registerSlabHeader } from "./commands/slab-header.js";
import { registerSlabConfig } from "./commands/slab-config.js";
import { registerSlabNonce } from "./commands/slab-nonce.js";
import { registerSlabEngine } from "./commands/slab-engine.js";
import { registerSlabParams } from "./commands/slab-params.js";
import { registerSlabAccount } from "./commands/slab-account.js";
import { registerSlabAccounts } from "./commands/slab-accounts.js";
import { registerSlabBitmap } from "./commands/slab-bitmap.js";
import { registerAuditCu } from "./commands/audit-cu.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("percolator-cli")
    .description("CLI for Percolator Solana program")
    .version("0.1.0");

  // Global options
  program
    .option("--config <path>", "Path to config file")
    .option("--rpc <url>", "RPC URL override")
    .option("--program <pubkey>", "Program ID override")
    .option("--wallet <path>", "Wallet keypair path override")
    .option(
      "--commitment <level>",
      "Commitment level: processed, confirmed, finalized"
    )
    .option("--json", "Output in JSON format")
    .option("--simulate", "Simulate transaction without sending");

  // Register all commands
  registerInitMarket(program);
  registerInitUser(program);
  registerInitLp(program);
  registerDeposit(program);
  registerWithdraw(program);
  registerKeeperCrank(program);
  registerTradeNocpi(program);
  registerTradeCpi(program);
  registerLiquidateAtOracle(program);
  registerCloseAccount(program);
  registerTopupInsurance(program);
  registerSetRiskThreshold(program);
  registerUpdateAdmin(program);
  registerCloseSlab(program);
  registerCloseAllSlabs(program);
  registerSlabGet(program);
  registerSlabHeader(program);
  registerSlabConfig(program);
  registerSlabNonce(program);
  registerSlabEngine(program);
  registerSlabParams(program);
  registerSlabAccount(program);
  registerSlabAccounts(program);
  registerSlabBitmap(program);
  registerAuditCu(program);

  return program;
}

/**
 * Extract global flags from parsed command.
 */
export function getGlobalFlags(cmd: Command): GlobalFlags {
  const opts = cmd.optsWithGlobals();
  return {
    config: opts.config,
    rpc: opts.rpc,
    program: opts.program,
    wallet: opts.wallet,
    commitment: opts.commitment,
    json: opts.json ?? false,
    simulate: opts.simulate ?? false,
  };
}
