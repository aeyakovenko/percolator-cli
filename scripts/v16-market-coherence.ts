import type { V16MarketHealthAssessment } from "./v16-market-health.ts";

export const DEFAULT_COHERENCE_WINDOW_MS = 20_000;
export const DEFAULT_COHERENCE_SAMPLE_INTERVAL_MS = 1_000;
export const DEFAULT_MAX_ORACLE_LEAD_SLOTS = 64n;

const ASSET_CLOCK_ORDERING_REASON = /^asset \d+ clocks are ahead of the market clock$/;
const RECOVERY_ONLY_CRITICAL_REASONS = [
  /^market loss-stale lock is active$/,
  /^asset \d+ state clock exceeds the configured lag limit$/,
  /^asset \d+ oracle clock exceeds the configured lag limit$/,
  /^market clock exceeds the configured lag limit$/,
];

export interface V16HealthCoherenceDecision {
  assessment: V16MarketHealthAssessment;
  kind: "coherent" | "failed" | "pending";
  marketClockAdvanced: boolean;
  maxOracleLeadSlots: bigint;
  reason: string | null;
  sampleCount: number;
  transientOrderingSamples: number;
}

export interface V16HealthCoherenceResult extends V16HealthCoherenceDecision {
  durationMs: number;
}

export interface V16HealthCoherenceMonitorInput {
  maxOracleLeadSlots?: bigint;
  nowMs?: () => number;
  readSample: (minContextSlot?: bigint) => Promise<V16MarketHealthAssessment>;
  sampleIntervalMs?: number;
  sleep: (ms: number) => Promise<void>;
  windowMs?: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecoveryOnlyCriticalReason(reason: string): boolean {
  return RECOVERY_ONLY_CRITICAL_REASONS.some((pattern) => pattern.test(reason));
}

function maxOracleLeadSlots(assessment: V16MarketHealthAssessment): bigint {
  return assessment.assets.reduce((maximum, asset) => (
    asset.oracleLag < 0n && -asset.oracleLag > maximum ? -asset.oracleLag : maximum
  ), 0n);
}

function result(
  kind: V16HealthCoherenceDecision["kind"],
  assessment: V16MarketHealthAssessment,
  samples: V16MarketHealthAssessment[],
  maximumLead: bigint,
  marketClockAdvanced: boolean,
  reason: string | null,
): V16HealthCoherenceDecision {
  return {
    assessment,
    kind,
    marketClockAdvanced,
    maxOracleLeadSlots: maximumLead,
    reason,
    sampleCount: samples.length,
    transientOrderingSamples: samples.filter((sample) => maxOracleLeadSlots(sample) > 0n).length,
  };
}

function monotonicFailure(
  previous: V16MarketHealthAssessment,
  current: V16MarketHealthAssessment,
): string | null {
  if (current.observedClusterSlot < previous.observedClusterSlot) {
    return "RPC context slot regressed inside the coherence window";
  }
  if (current.marketCurrentSlot < previous.marketCurrentSlot) {
    return "market current slot regressed inside the coherence window";
  }
  if (current.marketSlotLast < previous.marketSlotLast) {
    return "market last-crank slot regressed inside the coherence window";
  }
  if (current.marketOracleEpoch < previous.marketOracleEpoch
    || current.marketFundingEpoch < previous.marketFundingEpoch
    || current.marketRiskEpoch < previous.marketRiskEpoch
    || current.marketAssetSetEpoch < previous.marketAssetSetEpoch) {
    return "market epoch regressed inside the coherence window";
  }
  if (current.assets.length !== previous.assets.length) {
    return "active asset set changed inside the coherence window";
  }
  const previousAssets = new Map(previous.assets.map((asset) => [asset.asset, asset]));
  for (const asset of current.assets) {
    const prior = previousAssets.get(asset.asset);
    if (!prior || prior.lifecycle !== asset.lifecycle) {
      return `asset ${asset.asset} lifecycle changed inside the coherence window`;
    }
    if (asset.oracleSlot < prior.oracleSlot) {
      return `asset ${asset.asset} oracle slot regressed inside the coherence window`;
    }
    if (asset.slotLast < prior.slotLast) {
      return `asset ${asset.asset} state slot regressed inside the coherence window`;
    }
  }
  return null;
}

export function evaluateV16HealthCoherence(
  samples: V16MarketHealthAssessment[],
  maximumAllowedOracleLeadSlots = DEFAULT_MAX_ORACLE_LEAD_SLOTS,
): V16HealthCoherenceDecision {
  if (samples.length === 0) fail("at least one health sample is required");
  if (maximumAllowedOracleLeadSlots < 0n) fail("maximum oracle lead must be non-negative");

  let maximumLead = 0n;
  let firstTransientMarketSlot: bigint | null = null;
  let marketClockAdvanced = false;

  for (let index = 0; index < samples.length; index += 1) {
    const assessment = samples[index];
    const previous = samples[index - 1];
    if (previous) {
      const monotonic = monotonicFailure(previous, assessment);
      if (monotonic) {
        return result("failed", assessment, samples, maximumLead, marketClockAdvanced, monotonic);
      }
    }

    const nonClockInvalidReasons = assessment.invalidReasons.filter(
      (reason) => !ASSET_CLOCK_ORDERING_REASON.test(reason),
    );
    if (nonClockInvalidReasons.length > 0) {
      return result(
        "failed",
        assessment,
        samples,
        maximumLead,
        marketClockAdvanced,
        `hard invalid invariant: ${nonClockInvalidReasons.join("; ")}`,
      );
    }
    const hardCriticalReasons = assessment.criticalReasons.filter(
      (reason) => !isRecoveryOnlyCriticalReason(reason),
    );
    if (hardCriticalReasons.length > 0) {
      return result(
        "failed",
        assessment,
        samples,
        maximumLead,
        marketClockAdvanced,
        `hard critical invariant: ${hardCriticalReasons.join("; ")}`,
      );
    }
    if (assessment.marketClockLag < 0n || assessment.marketCurrentSlot < assessment.marketSlotLast) {
      return result(
        "failed",
        assessment,
        samples,
        maximumLead,
        marketClockAdvanced,
        "market clock ordering is invalid",
      );
    }
    const stateAhead = assessment.assets.find((asset) => asset.sideStateLag < 0n);
    if (stateAhead) {
      return result(
        "failed",
        assessment,
        samples,
        maximumLead,
        marketClockAdvanced,
        `asset ${stateAhead.asset} state clock is ahead of the market clock`,
      );
    }

    const lead = maxOracleLeadSlots(assessment);
    if (lead > maximumLead) maximumLead = lead;
    if (lead > maximumAllowedOracleLeadSlots) {
      return result(
        "failed",
        assessment,
        samples,
        maximumLead,
        marketClockAdvanced,
        `oracle lead ${lead.toString()} exceeds the ${maximumAllowedOracleLeadSlots.toString()}-slot coherence bound`,
      );
    }

    if (lead > 0n) {
      firstTransientMarketSlot ??= assessment.marketCurrentSlot;
      if (assessment.marketCurrentSlot > firstTransientMarketSlot) marketClockAdvanced = true;
      continue;
    }

    if (assessment.invalidReasons.length > 0) {
      return result(
        "failed",
        assessment,
        samples,
        maximumLead,
        marketClockAdvanced,
        `invalid health sample without a bounded oracle lead: ${assessment.invalidReasons.join("; ")}`,
      );
    }
    if (firstTransientMarketSlot === null) {
      return result("coherent", assessment, samples, maximumLead, false, null);
    }
    marketClockAdvanced ||= assessment.marketCurrentSlot > firstTransientMarketSlot;
    if (!marketClockAdvanced) continue;
    return result("coherent", assessment, samples, maximumLead, true, null);
  }

  const latest = samples[samples.length - 1];
  return result("pending", latest, samples, maximumLead, marketClockAdvanced, null);
}

export async function monitorV16HealthCoherence(
  input: V16HealthCoherenceMonitorInput,
): Promise<V16HealthCoherenceResult> {
  const windowMs = input.windowMs ?? DEFAULT_COHERENCE_WINDOW_MS;
  const sampleIntervalMs = input.sampleIntervalMs ?? DEFAULT_COHERENCE_SAMPLE_INTERVAL_MS;
  const maximumAllowedOracleLeadSlots = input.maxOracleLeadSlots ?? DEFAULT_MAX_ORACLE_LEAD_SLOTS;
  const nowMs = input.nowMs ?? Date.now;
  if (!Number.isFinite(windowMs) || windowMs <= 0) fail("coherence window must be positive and finite");
  if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs <= 0) {
    fail("coherence sample interval must be positive and finite");
  }
  const startedAt = nowMs();
  const maximumSamples = Math.ceil(windowMs / sampleIntervalMs) + 2;
  const samples: V16MarketHealthAssessment[] = [];

  for (let sample = 0; sample < maximumSamples; sample += 1) {
    const minContextSlot = samples.at(-1)?.observedClusterSlot;
    const assessment = await input.readSample(minContextSlot);
    samples.push(assessment);
    const elapsed = nowMs() - startedAt;
    const decision = evaluateV16HealthCoherence(samples, maximumAllowedOracleLeadSlots);
    if (decision.kind === "failed") return { ...decision, durationMs: elapsed };
    if (decision.kind === "coherent") {
      if (decision.transientOrderingSamples > 0 && elapsed > windowMs) {
        return {
          ...decision,
          durationMs: elapsed,
          kind: "failed",
          reason: "oracle ordering normalized only after the bounded coherence window expired",
        };
      }
      return { ...decision, durationMs: elapsed };
    }
    if (elapsed >= windowMs) {
      return {
        ...decision,
        durationMs: elapsed,
        kind: "failed",
        reason: decision.marketClockAdvanced
          ? "oracle ordering did not normalize after on-chain market-clock progress within the bounded coherence window"
          : "on-chain market clock did not advance within the bounded coherence window",
      };
    }
    await input.sleep(Math.min(sampleIntervalMs, windowMs - elapsed));
  }

  const decision = evaluateV16HealthCoherence(samples, maximumAllowedOracleLeadSlots);
  return {
    ...decision,
    durationMs: nowMs() - startedAt,
    kind: "failed",
    reason: "coherence monitor exhausted its bounded sample budget",
  };
}

export function formatV16HealthCoherence(result: V16HealthCoherenceResult): string {
  const status = result.kind === "coherent" ? "COHERENT" : "FAILED";
  const reason = result.reason ? ` | ${result.reason}` : "";
  return [
    `CLOCK COHERENCE ${status}`,
    `samples=${result.sampleCount}`,
    `transient=${result.transientOrderingSamples}`,
    `maxOracleLead=${result.maxOracleLeadSlots.toString()}`,
    `marketClockAdvanced=${result.marketClockAdvanced}`,
    `durationMs=${result.durationMs}`,
  ].join(" | ") + reason;
}
