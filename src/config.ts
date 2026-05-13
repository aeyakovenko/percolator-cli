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

const FileConfigSchema = z
  .object({
    rpcUrl: z.string().url().optional(),
    programId: z.string().optional(),
    wallet: z.string().optional(),
    walletPath: z.string().optional(),
    commitment: CommitmentSchema.optional(),
  })
  .passthrough();

export interface GlobalFlags {
  config?: string;
  rpc?: string;
  program?: string;
  wallet?: string;
  commitment?: Commitment;
  json?: boolean;
  simulate?: boolean;
  send?: boolean;
  yesMainnet?: boolean;
}

const DEFAULT_CONFIG_NAME = "percolator-cli.json";

/**
 * Load and validate config, with CLI flag overrides.
 */
export function loadConfig(flags: GlobalFlags): Config {
  // Find config file
  const configPath = flags.config ? expandPath(flags.config) : findConfig();

  let fileConfig: Partial<Config> = {};
  if (configPath && existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      fileConfig = normalizeFileConfig(JSON.parse(raw), configPath);
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
  const cwdPath = resolve(process.cwd(), DEFAULT_CONFIG_NAME);
  if (existsSync(cwdPath)) return cwdPath;

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return undefined;
  const homePath = resolve(home, ".config", DEFAULT_CONFIG_NAME);
  return existsSync(homePath) ? homePath : undefined;
}

function normalizeFileConfig(raw: unknown, configPath: string): Partial<Config> {
  const result = FileConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid config file ${configPath}:\n${issues.join("\n")}`);
  }

  const parsed = result.data;
  return {
    rpcUrl: parsed.rpcUrl,
    programId: parsed.programId,
    wallet: parsed.wallet ?? parsed.walletPath,
    commitment: parsed.commitment,
  };
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
