import assert from "node:assert/strict";
import test from "node:test";
import { resolveV16AuditProfile } from "./v16-audit-profile.ts";

test("recovery remains the strict default with pristine targets", () => {
  const profile = resolveV16AuditProfile({});
  assert.equal(profile.name, "recovery");
  assert.equal(profile.options.minimumLpRiskEquity, 100_000_000_000n);
  assert.equal(profile.options.expectedDomainInsurance, 100_000_000_000n);
  assert.equal(profile.options.requireFullSourceCredit, true);
  assert.equal(profile.options.maxClockLagSlots, 300n);
  assert.equal(profile.options.requireAuthorityParity, true);
});

test("operational profile requires explicit positive financial floors", () => {
  assert.throws(
    () => resolveV16AuditProfile({ AUDIT_PROFILE: "operational" }),
    /MIN_DOMAIN_INSURANCE_USDC is required/,
  );
  assert.throws(
    () => resolveV16AuditProfile({
      AUDIT_PROFILE: "operational",
      MIN_DOMAIN_INSURANCE_USDC: "90000",
    }),
    /LP_MIN_RISK_EQUITY_USDC is required/,
  );
  assert.throws(
    () => resolveV16AuditProfile({
      AUDIT_PROFILE: "operational",
      MIN_DOMAIN_INSURANCE_USDC: "0",
      LP_MIN_RISK_EQUITY_USDC: "90000",
    }),
    /must be greater than zero/,
  );
});

test("operational profile uses floors and permits bounded source-credit haircuts", () => {
  const profile = resolveV16AuditProfile({
    AUDIT_PROFILE: "operational",
    LP_MIN_RISK_EQUITY_USDC: "90000.5",
    MIN_DOMAIN_INSURANCE_USDC: "80000.25",
    MARKET_MAX_CLOCK_LAG_SLOTS: "450",
  });
  assert.equal(profile.name, "operational");
  assert.equal(profile.options.minimumLpRiskEquity, 90_000_500_000n);
  assert.equal(profile.options.minimumDomainInsurance, 80_000_250_000n);
  assert.equal(profile.options.expectedDomainInsurance, undefined);
  assert.equal(profile.options.requireFullSourceCredit, false);
  assert.equal(profile.options.maxClockLagSlots, 450n);
});

test("unknown profiles and malformed bounds fail closed", () => {
  assert.throws(() => resolveV16AuditProfile({ AUDIT_PROFILE: "loose" }), /recovery or operational/);
  assert.throws(
    () => resolveV16AuditProfile({ MARKET_MAX_CLOCK_LAG_SLOTS: "3.5" }),
    /non-negative integer/,
  );
});
