import { TimeElapsed } from "../components/TimeElapsed";
import { StatCard } from "../components/StatCard";
import { Signal } from "../components/Signal";
import { lamportsToSol, bpsToPercent, coverageRatio, slotsToHumanDuration, shortAddr } from "../lib/format";
import { computeTier } from "../lib/tiers";
import type { SlabSnapshot } from "../hooks/use-slab";
import { useProgramTrust } from "../hooks/use-program-trust";
import { useKeeperHealth } from "../hooks/use-keeper-health";
import styles from "./Overview.module.css";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const PERCOLATOR_PROG = "2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp";
const PERCOLATOR_MATCH = "4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy";

interface OverviewProps {
  data: SlabSnapshot;
  rpcUrl: string;
}

export function Overview({ data, rpcUrl }: OverviewProps) {
  const { header, engine, params } = data;
  const { programs } = useProgramTrust(rpcUrl, [PERCOLATOR_PROG, PERCOLATOR_MATCH]);
  const keeper = useKeeperHealth(data);

  const adminBurned = header.admin.toBase58() === SYSTEM_PROGRAM;
  const insuranceBal = engine.insuranceFund.balance;
  const feeRevenue = engine.insuranceFund.feeRevenue;
  const oi = engine.totalOpenInterest;
  const haircutSafe = engine.pnlPosTot <= engine.cTot;
  const lossesAbsorbed = feeRevenue > insuranceBal ? feeRevenue - insuranceBal : 0n;
  const tier = computeTier(insuranceBal, oi);

  return (
    <div className={styles.root}>
      <TimeElapsed currentSlot={engine.currentSlot} adminBurned={adminBurned} />

      <div className={styles.grid}>
        <StatCard
          label="Insurance"
          value={`${lamportsToSol(insuranceBal)} SOL`}
          sub={`${lamportsToSol(feeRevenue)} cumulative fees`}
        />
        <StatCard
          label="Coverage"
          value={coverageRatio(insuranceBal, oi)}
          sub={`Tier: ${tier.name}`}
        />
        <StatCard
          label="Open Interest"
          value={`${lamportsToSol(oi)} SOL`}
        />
        <StatCard
          label="Vault"
          value={`${lamportsToSol(engine.vault)} SOL`}
        />
        <StatCard
          label="Trading Fee"
          value={bpsToPercent(params.tradingFeeBps)}
          sub="frozen parameter"
        />
        <StatCard
          label="Liquidations"
          value={engine.lifetimeLiquidations.toString()}
          sub={`${engine.lifetimeForceCloses.toString()} force closes`}
        />
        <StatCard
          label="Accounts"
          value={engine.numUsedAccounts.toString()}
          sub={`of ${params.maxAccounts.toString()} max`}
        />
        <StatCard
          label="Losses Absorbed"
          value={`${lamportsToSol(lossesAbsorbed)} SOL`}
          sub="by insurance fund"
        />
      </div>

      {/* Keeper Health */}
      {keeper && (
        <div className={styles.signals}>
          <h3 className={styles.signalTitle}>Keeper Health</h3>
          <Signal
            label={keeper.isFresh ? "Keeper: active" : "Keeper: stale"}
            healthy={keeper.isFresh}
            detail={`${slotsToHumanDuration(keeper.staleness)} since last crank`}
          />
          <Signal
            label={keeper.isFresh ? "Trades: enabled" : "Trades: blocked"}
            healthy={keeper.isFresh}
            detail={`staleness ${keeper.staleness.toString()} / ${keeper.maxStaleness.toString()} slots`}
          />
          <div className={styles.keeperBar}>
            <div className={styles.keeperBarTrack}>
              <div
                className={`${styles.keeperBarFill} ${keeper.isFresh ? styles.keeperFresh : styles.keeperStale}`}
                style={{ width: `${keeper.healthPct}%` }}
              />
            </div>
            <span className={styles.keeperBarLabel}>
              {keeper.healthPct.toFixed(0)}% health
            </span>
          </div>
        </div>
      )}

      <div className={styles.signals}>
        <h3 className={styles.signalTitle}>Credibility Signals</h3>
        <Signal
          label="Admin key burned"
          healthy={adminBurned}
          detail={adminBurned ? SYSTEM_PROGRAM.slice(0, 8) + "..." : header.admin.toBase58().slice(0, 8) + "..."}
        />
        <Signal
          label="No insolvency events"
          healthy={haircutSafe}
          detail={haircutSafe ? "pnl < capital" : "haircut condition active"}
        />
        <Signal
          label="Insurance growing"
          healthy={insuranceBal > 0n}
          detail={feeRevenue > 0n ? `${((Number(insuranceBal) / Number(feeRevenue)) * 100).toFixed(1)}% retained` : "no fees yet"}
        />
        <Signal
          label="Market resolved"
          healthy={!header.resolved}
          detail={header.resolved ? "market resolved" : "active"}
        />
      </div>

      <div className={styles.signals}>
        <h3 className={styles.signalTitle}>Program Trust</h3>
        {programs.length === 0 && (
          <span className={styles.loading}>Checking program authorities...</span>
        )}
        {programs.map((p) => (
          <Signal
            key={p.programId}
            label={`${p.programId === PERCOLATOR_PROG ? "Risk engine" : "Matcher"} ${p.upgradeable ? "upgradeable" : "immutable"}`}
            healthy={!p.upgradeable}
            detail={
              p.upgradeable
                ? `authority: ${p.upgradeAuthority ? shortAddr(p.upgradeAuthority) : "unknown"}`
                : "upgrade authority burned"
            }
          />
        ))}
        {programs.some((p) => p.upgradeable) && (
          <p className={styles.trustNote}>
            Market-level immutability depends on these programs not being modified.
            Upgrade authorities should be burned or set to a multisig for full trustlessness.
          </p>
        )}
      </div>
    </div>
  );
}
