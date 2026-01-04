import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Commitment } from "@solana/web3.js";

const CommitmentSchema = z.enum(["processed", "confirmed", "finalized"]);

const ConfigSchema = z.object({
  rpcUrl: z.string().url(),
  programId: z.string(),
  wallet: z.string(),
  commitment: CommitmentSchema.default("confirmed"),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface GlobalFlags {
  config?: string;
  rpc?: string;
  program?: string;
  wallet?: string;
  commitment?: Commitment;
  json?: boolean;
  simulate?: boolean;
}

const DEFAULT_CONFIG_NAME = "percolator-cli.json";

/**
 * Load and validate config, with CLI flag overrides.
 */
export function loadConfig(flags: GlobalFlags): Config {
  // Find config file
  const configPath = flags.config ?? findConfig();

  let fileConfig: Partial<Config> = {};
  if (configPath && existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to parse config file ${configPath}: ${e}`);
    }
  }

  // Merge: CLI flags override file config
  const merged = {
    rpcUrl: flags.rpc ?? fileConfig.rpcUrl ?? "https://api.mainnet-beta.solana.com",
    programId: flags.program ?? fileConfig.programId,
    wallet: flags.wallet ?? fileConfig.wallet ?? "~/.config/solana/id.json",
    commitment: flags.commitment ?? fileConfig.commitment ?? "confirmed",
  };

  // Validate
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid config:\n${issues.join("\n")}`);
  }

  return result.data;
}

/**
 * Find config file in cwd.
 */
function findConfig(): string | undefined {
  const path = resolve(process.cwd(), DEFAULT_CONFIG_NAME);
  return existsSync(path) ? path : undefined;
}

/**
 * Expand ~ to home directory.
 */
export function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return resolve(home, p.slice(2));
  }
  return resolve(p);
}
