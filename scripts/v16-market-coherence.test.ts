import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateV16HealthCoherence,
  formatV16HealthCoherence,
  monitorV16HealthCoherence,
} from "./v16-market-coherence.ts";
import type { V16MarketHealthAssessment } from "./v16-market-health.ts";

function healthSample(input: {
  contextSlot?: bigint;
  criticalReasons?: string[];
  invalidReasons?: string[];
  marketSlot?: bigint;
  oracleLag?: bigint;
  sideStateLag?: bigint;
} = {}): V16MarketHealthAssessment {
  const marketCurrentSlot = input.marketSlot ?? 100n;
  const oracleLag = input.oracleLag ?? 0n;
  const sideStateLag = input.sideStateLag ?? 0n;
  const invalidReasons = input.invalidReasons ?? (
    oracleLag < 0n || sideStateLag < 0n
      ? ["asset 0 clocks are ahead of the market clock"]
      : []
  );
  const criticalReasons = input.criticalReasons ?? [];
  const warningReasons: string[] = [];
  const reasons = invalidReasons.length > 0
    ? invalidReasons
    : criticalReasons.length > 0
      ? criticalReasons
      : warningReasons;
  return {
    accountedVault: 200_000_000_000n,
    accountingResidual: 0n,
    aggregateCapital: 100_000_000_000n,
    assets: [{
      asset: 0,
      authorityParity: true,
      lifecycle: 2,
      oracleLag,
      oracleSlot: marketCurrentSlot - oracleLag,
      sideStateLag,
      slotLast: marketCurrentSlot - sideStateLag,
      sides: [
        { a: 1n, epoch: 1n, mode: 0, oi: 0n, pending: 0n, side: "long", stale: 0n, stored: 0n, weight: 0n },
        { a: 1n, epoch: 1n, mode: 0, oi: 0n, pending: 0n, side: "short", stale: 0n, stored: 0n, weight: 0n },
      ],
    }],
    bankruptcyHlock: false,
    collateralMint: new Uint8Array(32),
    criticalReasons,
    custodyBalance: 200_000_000_000n,
    custodyDelta: 0n,
    domainInsurance: 100_000_000_000n,
    domains: [],
    insurance: 100_000_000_000n,
    invalidReasons,
    level: invalidReasons.length > 0 ? "invalid" : criticalReasons.length > 0 ? "critical" : "healthy",
    lossStaleActive: criticalReasons.includes("market loss-stale lock is active"),
    lpActiveLegs: 0,
    lpBookEquity: 100_000_000_000n,
    lpCapital: 100_000_000_000n,
    lpCertCurrent: true,
    lpCertifiedEquity: 100_000_000_000n,
    lpCertifiedInitialRequirement: 0n,
    lpCertifiedMaintenanceRequirement: 0n,
    lpFeeCredits: 0n,
    lpPnl: 0n,
    lpRiskEquity: 100_000_000_000n,
    marketAssetSetEpoch: 1n,
    marketClockLag: (input.contextSlot ?? 200n) - marketCurrentSlot,
    marketCurrentSlot,
    marketFundingEpoch: 1n,
    marketOracleEpoch: 1n,
    marketRiskEpoch: 1n,
    marketSlotLast: marketCurrentSlot,
    minimumLpCapital: 0n,
    negativePnlAccounts: 0n,
    observedClusterSlot: input.contextSlot ?? 200n,
    reasons,
    thresholdStress: false,
    warningReasons,
  };
}

async function runSequence(
  samples: V16MarketHealthAssessment[],
  windowMs = 2_000,
) {
  let index = 0;
  let time = 0;
  const minimumContextSlots: Array<bigint | undefined> = [];
  const result = await monitorV16HealthCoherence({
    nowMs: () => time,
    readSample: async (minContextSlot) => {
      minimumContextSlots.push(minContextSlot);
      return samples[Math.min(index++, samples.length - 1)];
    },
    sampleIntervalMs: 1_000,
    sleep: async (ms) => {
      time += ms;
    },
    windowMs,
  });
  return { minimumContextSlots, result };
}

test("a coherent first sample returns without polling", async () => {
  const { minimumContextSlots, result } = await runSequence([healthSample()]);
  assert.equal(result.kind, "coherent");
  assert.equal(result.sampleCount, 1);
  assert.deepEqual(minimumContextSlots, [undefined]);
});

test("a bounded oracle lead is accepted only after market progress and normalization", async () => {
  const sequence = [
    healthSample({ contextSlot: 200n, marketSlot: 100n, oracleLag: -14n }),
    healthSample({ contextSlot: 201n, marketSlot: 106n, oracleLag: -8n }),
    healthSample({ contextSlot: 202n, marketSlot: 120n, oracleLag: 6n }),
  ];
  const { minimumContextSlots, result } = await runSequence(sequence);
  assert.equal(result.kind, "coherent");
  assert.equal(result.marketClockAdvanced, true);
  assert.equal(result.maxOracleLeadSlots, 14n);
  assert.equal(result.transientOrderingSamples, 2);
  assert.deepEqual(minimumContextSlots, [undefined, 200n, 201n]);
});

test("persistent ordering failure closes after the strict window", async () => {
  const { result } = await runSequence([
    healthSample({ contextSlot: 200n, marketSlot: 100n, oracleLag: -14n }),
    healthSample({ contextSlot: 201n, marketSlot: 105n, oracleLag: -14n }),
    healthSample({ contextSlot: 202n, marketSlot: 110n, oracleLag: -14n }),
  ]);
  assert.equal(result.kind, "failed");
  assert.match(result.reason ?? "", /did not normalize/);
});

test("lack of on-chain market progress fails closed", async () => {
  const { result } = await runSequence([
    healthSample({ contextSlot: 200n, marketSlot: 100n, oracleLag: -14n }),
    healthSample({ contextSlot: 201n, marketSlot: 100n, oracleLag: -14n }),
    healthSample({ contextSlot: 202n, marketSlot: 100n, oracleLag: -14n }),
  ]);
  assert.equal(result.kind, "failed");
  assert.match(result.reason ?? "", /market clock did not advance/);
});

test("hard financial failures are never masked by transient clock ordering", () => {
  const decision = evaluateV16HealthCoherence([healthSample({
    criticalReasons: ["LP conservative risk equity is below the configured target"],
    oracleLag: -14n,
  })]);
  assert.equal(decision.kind, "failed");
  assert.match(decision.reason ?? "", /hard critical invariant/);
});

test("state-clock leads, excessive oracle leads, and regressions fail immediately", () => {
  const stateAhead = evaluateV16HealthCoherence([healthSample({ sideStateLag: -1n })]);
  assert.equal(stateAhead.kind, "failed");
  assert.match(stateAhead.reason ?? "", /state clock is ahead/);

  const excessiveLead = evaluateV16HealthCoherence([healthSample({ oracleLag: -65n })]);
  assert.equal(excessiveLead.kind, "failed");
  assert.match(excessiveLead.reason ?? "", /exceeds the 64-slot/);

  const contextRegression = evaluateV16HealthCoherence([
    healthSample({ contextSlot: 200n, oracleLag: -1n }),
    healthSample({ contextSlot: 199n, oracleLag: -1n }),
  ]);
  assert.equal(contextRegression.kind, "failed");
  assert.match(contextRegression.reason ?? "", /context slot regressed/);
});

test("recovery-only critical state remains visible without being mislabeled incoherent", async () => {
  const { result } = await runSequence([healthSample({
    criticalReasons: ["market loss-stale lock is active"],
  })]);
  assert.equal(result.kind, "coherent");
  assert.equal(result.assessment.level, "critical");
  assert.match(formatV16HealthCoherence(result), /CLOCK COHERENCE COHERENT/);
});
