import { useMemo } from "react";
import type { SlabSnapshot } from "./use-slab";

export interface KeeperHealth {
  /** Slots since last crank */
  staleness: bigint;
  /** Max allowed staleness */
  maxStaleness: bigint;
  /** Whether the keeper is stale (trades blocked) */
  isStale: boolean;
  /** Whether the keeper is fresh (trades enabled) */
  isFresh: boolean;
  /** Health as 0-100%, where 100% = just cranked, 0% = at threshold */
  healthPct: number;
  /** Current slot */
  currentSlot: bigint;
  /** Last crank slot */
  lastCrankSlot: bigint;
}

/**
 * Hook that derives keeper health from slab engine state.
 */
export function useKeeperHealth(data: SlabSnapshot | null): KeeperHealth | null {
  return useMemo(() => {
    if (!data) return null;

    const { engine } = data;
    const staleness =
      engine.currentSlot > engine.lastCrankSlot
        ? engine.currentSlot - engine.lastCrankSlot
        : 0n;
    const maxStaleness = engine.maxCrankStalenessSlots;
    const isStale = staleness >= maxStaleness;
    const isFresh = !isStale;

    // Health: 100% when staleness=0, 0% when staleness>=maxStaleness
    const healthPct = maxStaleness > 0n
      ? Math.max(0, Math.min(100, (1 - Number(staleness) / Number(maxStaleness)) * 100))
      : 0;

    return {
      staleness,
      maxStaleness,
      isStale,
      isFresh,
      healthPct,
      currentSlot: engine.currentSlot,
      lastCrankSlot: engine.lastCrankSlot,
    };
  }, [data]);
}
