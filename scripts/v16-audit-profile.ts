import {
  parseUsdcAmount,
  type V16MarketHealthOptions,
} from "./v16-market-health.ts";

export type V16AuditProfileName = "operational" | "recovery";

export interface V16AuditProfile {
  name: V16AuditProfileName;
  options: V16MarketHealthOptions;
}

function parseSlotLimit(value: string | undefined, fallback: bigint): bigint {
  const normalized = value?.trim() || fallback.toString();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("MARKET_MAX_CLOCK_LAG_SLOTS must be a non-negative integer");
  }
  return BigInt(normalized);
}

function parseStrictBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error("REQUIRE_AUTHORITY_PARITY must be true, false, 1, or 0");
}

function parseRequiredPositiveUsdc(value: string | undefined, label: string): bigint {
  if (!value?.trim()) throw new Error(`${label} is required for the operational audit profile`);
  const parsed = parseUsdcAmount(value, 0, label);
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

export function resolveV16AuditProfile(
  env: Readonly<Record<string, string | undefined>>,
): V16AuditProfile {
  const rawProfile = env.AUDIT_PROFILE?.trim().toLowerCase() || "recovery";
  if (rawProfile !== "recovery" && rawProfile !== "operational") {
    throw new Error("AUDIT_PROFILE must be recovery or operational");
  }

  const shared = {
    maxClockLagSlots: parseSlotLimit(env.MARKET_MAX_CLOCK_LAG_SLOTS, 300n),
    requireAuthorityParity: parseStrictBoolean(env.REQUIRE_AUTHORITY_PARITY, true),
  };
  if (rawProfile === "operational") {
    return {
      name: "operational",
      options: {
        ...shared,
        minimumDomainInsurance: parseRequiredPositiveUsdc(
          env.MIN_DOMAIN_INSURANCE_USDC,
          "MIN_DOMAIN_INSURANCE_USDC",
        ),
        minimumLpRiskEquity: parseRequiredPositiveUsdc(
          env.LP_MIN_RISK_EQUITY_USDC,
          "LP_MIN_RISK_EQUITY_USDC",
        ),
        requireFullSourceCredit: false,
      },
    };
  }

  return {
    name: "recovery",
    options: {
      ...shared,
      expectedDomainInsurance: parseUsdcAmount(
        env.EXPECTED_DOMAIN_INSURANCE_USDC,
        100_000,
        "EXPECTED_DOMAIN_INSURANCE_USDC",
      ),
      minimumLpRiskEquity: parseUsdcAmount(
        env.LP_MIN_RISK_EQUITY_USDC,
        100_000,
        "LP_MIN_RISK_EQUITY_USDC",
      ),
      requireFullSourceCredit: true,
    },
  };
}
