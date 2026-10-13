export type OraclePriceSource =
  | "pyth-solana-push"
  | "pyth-hermes"
  | "magicblock-demo";

export interface OraclePriceSourceEnvironment {
  ORACLE_PRICE_SOURCE?: string;
  PYTH_PRICE_SOURCE?: string;
  [name: string]: string | undefined;
}

export class OraclePriceSourceConfigurationError extends Error {}

/**
 * Preserve the deployed Pyth configuration while making every non-Pyth source
 * an explicit opt-in. `PYTH_PRICE_SOURCE` remains supported for rollback and
 * older Fly releases.
 */
export function requireOraclePriceSource(
  env: OraclePriceSourceEnvironment,
): OraclePriceSource {
  const explicit = env.ORACLE_PRICE_SOURCE?.trim();
  if (explicit) {
    if (
      explicit !== "pyth-solana-push"
      && explicit !== "pyth-hermes"
      && explicit !== "magicblock-demo"
    ) {
      throw new OraclePriceSourceConfigurationError(
        "ORACLE_PRICE_SOURCE must be pyth-solana-push, pyth-hermes, or magicblock-demo.",
      );
    }
    return explicit;
  }

  const legacyPyth = env.PYTH_PRICE_SOURCE?.trim() || "solana-push";
  if (legacyPyth === "solana-push") return "pyth-solana-push";
  if (legacyPyth === "hermes") return "pyth-hermes";
  throw new OraclePriceSourceConfigurationError(
    "PYTH_PRICE_SOURCE must be solana-push or hermes when ORACLE_PRICE_SOURCE is unset.",
  );
}

export function assertOracleSourceLifecycleCompatibility(
  source: OraclePriceSource,
  assets: readonly { asset: number; lifecycle: number }[],
): void {
  if (source !== "magicblock-demo") return;
  const supported = new Set([0, 1, 2]);
  const unsupportedLive = assets
    .filter((asset) => (asset.lifecycle === 2 || asset.lifecycle === 3) && !supported.has(asset.asset))
    .map((asset) => asset.asset)
    .sort((a, b) => a - b);
  if (unsupportedLive.length > 0) {
    throw new OraclePriceSourceConfigurationError(
      `magicblock-demo requires unsupported live asset indexes ${unsupportedLive.join(",")} to be Recovery or Retired`,
    );
  }
}
