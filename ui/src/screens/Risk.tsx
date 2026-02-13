import { StatCard } from "../components/StatCard";
import { lamportsToSol, bpsToPercent, slotsToHumanDuration } from "../lib/format";
import { computeTier, TIER_LADDER, type CoverageTier } from "../lib/tiers";
import type { SlabSnapshot } from "../hooks/use-slab";
import type { UseMatcherCtxResult } from "../hooks/use-matcher-ctx";
import styles from "./Risk.module.css";

interface RiskProps {
  data: SlabSnapshot;
  matcherCtx: UseMatcherCtxResult;
}

// Fallback constants (only used if matcher context unavailable)
const FALLBACK_BASE_BPS = 30;
const FALLBACK_INS_WEIGHT = 20;
const FALLBACK_IMB_K = 10;

export function Risk({ data, matcherCtx }: RiskProps) {
  const { engine } = data;
  const mc = matcherCtx.data;

  const oi = engine.totalOpenInterest;
  const netLp = engine.netLpPos;
  const insuranceBal = engine.insuranceFund.balance;
  const fundingRate = engine.fundingRateBpsPerSlotLast;

  // Use live matcher params if available, fallback otherwise
  const baseSpreadBps = mc ? mc.baseFeeBps : FALLBACK_BASE_BPS;
  const insuranceWeightBps = mc ? mc.insuranceWeightBps : FALLBACK_INS_WEIGHT;
  const imbalanceKBps = mc ? mc.imbalanceKBps : FALLBACK_IMB_K;
  const minSpreadBps = mc ? mc.minSpreadBps : 5;
  const maxSpreadBps = mc ? mc.maxSpreadBps : 200;

  // Use matcher snapshots if available, otherwise live slab values
  const insForCalc = mc ? mc.insuranceSnapshot : insuranceBal;
  const oiForCalc = mc ? mc.totalOiSnapshot : oi;

  // Compute the active coverage tier
  const tier: CoverageTier = computeTier(insForCalc, oiForCalc);

  // Imbalance from slab (live)
  const imbalancePct = oi > 0n ? (Number(netLp) / Number(oi)) * 100 : 0;

  // Inventory-based impact (from matcher context if available)
  let imbalancePenalty: number;
  if (mc && mc.liquidityNotionalE6 > 0n) {
    const absInv = mc.inventoryBase < 0n ? -mc.inventoryBase : mc.inventoryBase;
    imbalancePenalty = (Number(absInv) / Number(mc.liquidityNotionalE6)) * imbalanceKBps;
  } else {
    const absImb = Math.abs(imbalancePct) / 100;
    imbalancePenalty = Math.min(absImb, 1.0) * imbalanceKBps;
  }

  // Spread is now tier-driven, but we show the decomposition
  const rawSpread = baseSpreadBps + imbalancePenalty;
  const effectiveSpread = Math.max(minSpreadBps, Math.min(maxSpreadBps, rawSpread));

  // Funding annualized
  const fundingPerDay = Number(fundingRate) * 216000;
  const fundingPerYear = fundingPerDay * 365;

  // Imbalance bar
  const barWidth = Math.min(Math.abs(imbalancePct), 100);
  const isLong = imbalancePct > 0;

  // Snapshot staleness
  const snapshotStaleness = mc
    ? engine.currentSlot > mc.snapshotSlot
      ? engine.currentSlot - mc.snapshotSlot
      : 0n
    : null;

  return (
    <div className={styles.root}>
      <h2 className={styles.heading}>Risk & Pricing Intelligence</h2>

      {/* Data source indicator */}
      <div className={styles.sourceBar}>
        {mc ? (
          <span className={styles.sourceLive}>
            Live matcher params (on-chain)
          </span>
        ) : matcherCtx.loading ? (
          <span className={styles.sourceLoading}>Loading matcher context...</span>
        ) : (
          <span className={styles.sourceFallback}>
            Using fallback constants (matcher context unavailable)
          </span>
        )}
      </div>

      {/* Active Tier Display */}
      <div
        className={styles.tierBanner}
        style={{
          borderColor: tier.borderColor,
          backgroundColor: tier.bgColor,
        }}
      >
        <div className={styles.tierBannerLeft}>
          <span className={styles.tierLabel} style={{ color: tier.color }}>
            {tier.name}
          </span>
          <span className={styles.tierCoverage}>
            Coverage: {tier.coveragePct.toFixed(1)}%
          </span>
        </div>
        <div className={styles.tierBannerRight}>
          <span className={styles.tierEffect}>{tier.spreadEffect}</span>
          <span className={styles.tierFill}>
            Fill capacity: {tier.fillCapPct}%
          </span>
        </div>
      </div>

      {/* Tier Ladder */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Coverage Tier Ladder</h3>
        <p className={styles.description}>
          The market prices its own fragility. Thin liquidity is automatically expensive.
        </p>
        <div className={styles.tierLadder}>
          {TIER_LADDER.map((t) => {
            const isActive = t.name === tier.name;
            return (
              <div
                key={t.name}
                className={`${styles.tierRow} ${isActive ? styles.tierRowActive : ""}`}
                style={isActive ? { borderColor: t.color, backgroundColor: `${t.color}10` } : {}}
              >
                <span
                  className={styles.tierName}
                  style={{ color: isActive ? t.color : "#525252" }}
                >
                  {t.name}
                </span>
                <span className={styles.tierThreshold}>{t.threshold}</span>
                <span className={styles.tierFillCap}>
                  fill: {t.fillCap}
                </span>
                {isActive && (
                  <span className={styles.tierActiveIndicator} style={{ color: t.color }}>
                    ACTIVE
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Imbalance */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Net Imbalance</h3>
        <div className={styles.imbalanceBar}>
          <div className={styles.barTrack}>
            <div className={styles.barCenter} />
            <div
              className={`${styles.barFill} ${isLong ? styles.barLong : styles.barShort}`}
              style={{
                width: `${barWidth / 2}%`,
                [isLong ? "left" : "right"]: "50%",
              }}
            />
          </div>
          <div className={styles.barLabels}>
            <span>Short</span>
            <span className={styles.barValue}>
              {imbalancePct > 0 ? "+" : ""}
              {imbalancePct.toFixed(2)}%
            </span>
            <span>Long</span>
          </div>
        </div>
        {mc && (
          <div className={styles.inventoryDetail}>
            <span>Matcher inventory: {lamportsToSol(mc.inventoryBase < 0n ? -mc.inventoryBase : mc.inventoryBase)} SOL</span>
            <span>Max inventory: {lamportsToSol(mc.maxInventoryAbs)} SOL</span>
          </div>
        )}
      </div>

      {/* Funding */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Funding Rate</h3>
        <div className={styles.fundingGrid}>
          <StatCard
            label="Per slot"
            value={`${Number(fundingRate).toFixed(4)} bps`}
          />
          <StatCard
            label="Daily (est)"
            value={`${fundingPerDay.toFixed(2)} bps`}
          />
          <StatCard
            label="Annualized (est)"
            value={`${(fundingPerYear / 100).toFixed(2)}%`}
          />
        </div>
      </div>

      {/* Spread Decomposition */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Spread Decomposition</h3>
        <p className={styles.description}>
          {mc
            ? "Computed from live matcher context. Tier determines base spread, imbalance adds penalty."
            : "Estimated using fallback constants. Connect to devnet for live data."}
        </p>
        <div className={styles.spreadTable}>
          <div className={styles.spreadRow}>
            <span className={styles.spreadLabel}>Tier spread ({tier.name})</span>
            <span className={styles.spreadValue} style={{ color: tier.color }}>
              {tier.name === "CRITICAL" ? maxSpreadBps : tier.name === "FORTIFIED" ? minSpreadBps : effectiveSpread.toFixed(1)} bps
            </span>
          </div>
          <div className={styles.spreadRow}>
            <span className={styles.spreadLabel}>+ Imbalance penalty</span>
            <span className={styles.spreadValue}>
              {imbalancePenalty.toFixed(1)} bps
            </span>
          </div>
          <div className={`${styles.spreadRow} ${styles.spreadRowTotal}`}>
            <span className={styles.spreadLabel}>= Effective spread</span>
            <span className={styles.spreadValue}>
              {effectiveSpread.toFixed(1)} bps
            </span>
          </div>
          {mc && (
            <>
              <div className={styles.spreadRow}>
                <span className={styles.spreadLabel}>Floor</span>
                <span className={styles.spreadValueDim}>{minSpreadBps} bps</span>
              </div>
              <div className={styles.spreadRow}>
                <span className={styles.spreadLabel}>Cap</span>
                <span className={styles.spreadValueDim}>{maxSpreadBps} bps</span>
              </div>
            </>
          )}
        </div>
        <p className={styles.note}>
          No governance. No intervention. The coverage ratio determines the tier.
          The tier determines the spread and fill limits. Just math.
        </p>
      </div>

      {/* Summary stats */}
      <div className={styles.grid}>
        <StatCard
          label="Open Interest"
          value={`${lamportsToSol(oi)} SOL`}
        />
        <StatCard
          label="Insurance"
          value={`${lamportsToSol(insuranceBal)} SOL`}
        />
        <StatCard
          label="Coverage Ratio"
          value={`${tier.coveragePct.toFixed(2)}%`}
          sub={tier.name}
        />
        <StatCard
          label="Fill Capacity"
          value={`${tier.fillCapPct}%`}
          sub="of base max fill"
        />
        {mc && (
          <>
            <StatCard
              label="Oracle Price"
              value={`$${(Number(mc.lastOraclePriceE6) / 1e6).toFixed(2)}`}
            />
            <StatCard
              label="Last Exec Price"
              value={`$${(Number(mc.lastExecPriceE6) / 1e6).toFixed(2)}`}
            />
            <StatCard
              label="Market Age"
              value={slotsToHumanDuration(mc.marketAgeSlots)}
            />
            <StatCard
              label="Snapshot Age"
              value={snapshotStaleness !== null ? slotsToHumanDuration(snapshotStaleness) : "—"}
              sub="since last keeper update"
            />
          </>
        )}
      </div>
    </div>
  );
}
