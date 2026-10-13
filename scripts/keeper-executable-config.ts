import { PublicKey } from "@solana/web3.js";
import {
  resolveExplicitRuntimeConfig,
  type ExplicitRuntimeConfig,
} from "../src/normalized/config.ts";
import {
  keeperModeFromEnv,
  type KeeperMode,
} from "./keeper-shadow.ts";

export interface KeeperAssetConfiguration {
  readonly feedId: string;
  readonly index: number;
  readonly symbol: string;
}

export interface KeeperExecutableConfiguration {
  readonly assets: readonly KeeperAssetConfiguration[];
  readonly lpPortfolio: PublicKey;
  readonly market: PublicKey;
  readonly mode: KeeperMode;
  readonly runtime: ExplicitRuntimeConfig;
}

function requiredSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the v16 keeper`);
  return value;
}

function requiredPublicKey(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): PublicKey {
  try {
    return new PublicKey(requiredSetting(env, name));
  } catch (error) {
    if (error instanceof Error && error.message.includes(" is required ")) throw error;
    throw new Error(`${name} must be a base58 Solana public key`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseKeeperAssets(value: string): readonly KeeperAssetConfiguration[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("KEEPER_ASSETS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 16) {
    throw new Error("KEEPER_ASSETS_JSON must contain from 1 to 16 assets");
  }

  const assets: KeeperAssetConfiguration[] = [];
  const symbols = new Set<string>();
  const feedIds = new Set<string>();
  let previousIndex = -1;
  for (const [position, item] of parsed.entries()) {
    if (!isRecord(item)
      || Object.keys(item).sort().join(",") !== "feedId,index,symbol") {
      throw new Error(`KEEPER_ASSETS_JSON asset ${position} must contain only index, symbol, and feedId`);
    }
    const { feedId, index, symbol } = item;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 15) {
      throw new Error(`KEEPER_ASSETS_JSON asset ${position} index must be an integer from 0 to 15`);
    }
    if ((index as number) <= previousIndex) {
      throw new Error("KEEPER_ASSETS_JSON indexes must be unique and strictly increasing");
    }
    if (typeof symbol !== "string" || !/^[A-Z][A-Z0-9._-]{0,15}$/.test(symbol)) {
      throw new Error(`KEEPER_ASSETS_JSON asset ${position} symbol has an invalid format`);
    }
    if (symbols.has(symbol)) throw new Error("KEEPER_ASSETS_JSON symbols must be unique");
    if (typeof feedId !== "string" || !/^[0-9a-fA-F]{64}$/.test(feedId)) {
      throw new Error(`KEEPER_ASSETS_JSON asset ${position} feedId must be 32-byte hexadecimal`);
    }
    const normalizedFeedId = feedId.toLowerCase();
    if (feedIds.has(normalizedFeedId)) {
      throw new Error("KEEPER_ASSETS_JSON feed IDs must be unique");
    }
    previousIndex = index as number;
    symbols.add(symbol);
    feedIds.add(normalizedFeedId);
    assets.push({ feedId: normalizedFeedId, index: index as number, symbol });
  }
  return Object.freeze(assets.map((asset) => Object.freeze(asset)));
}

export function requireKeeperExecutableConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): KeeperExecutableConfiguration {
  const programId = requiredPublicKey(env, "PROGRAM_ID");
  const market = requiredPublicKey(env, "MARKET");
  const lpPortfolio = requiredPublicKey(env, "LP_PORTFOLIO");
  if (market.equals(programId) || lpPortfolio.equals(programId) || lpPortfolio.equals(market)) {
    throw new Error("PROGRAM_ID, MARKET, and LP_PORTFOLIO must be distinct public keys");
  }
  const mode = keeperModeFromEnv({ KEEPER_MODE: requiredSetting(env, "KEEPER_MODE") });
  const assets = parseKeeperAssets(requiredSetting(env, "KEEPER_ASSETS_JSON"));
  const runtime = resolveExplicitRuntimeConfig({
    commitment: "confirmed",
    programId,
    rpcUrl: requiredSetting(env, "RPC_URL"),
  });
  return { assets, lpPortfolio, market, mode, runtime };
}
