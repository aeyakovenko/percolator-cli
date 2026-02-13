import { useState, useEffect, useCallback } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { MATCHER_CTX } from "../config/market";

/**
 * Parsed credibility matcher context — matches the on-chain layout
 * at byte 64 of the 320-byte matcher context account.
 */
export interface MatcherCtxData {
  magic: bigint;
  version: number;
  kind: number;
  lpPda: PublicKey;
  baseFeeBps: number;
  minSpreadBps: number;
  maxSpreadBps: number;
  imbalanceKBps: number;
  liquidityNotionalE6: bigint;
  maxFillAbs: bigint;
  inventoryBase: bigint;       // i128
  lastOraclePriceE6: bigint;
  lastExecPriceE6: bigint;
  maxInventoryAbs: bigint;
  insuranceSnapshot: bigint;   // u128
  totalOiSnapshot: bigint;     // u128
  marketAgeSlots: bigint;
  lastDeficitSlot: bigint;
  snapshotSlot: bigint;
  ageHalflifeSlots: number;
  insuranceWeightBps: number;
}

const CTX_BASE = 64;
const PERCMATC_MAGIC = 0x5045_5243_4d41_5443n;

function readI128LE(buf: Uint8Array, off: number): bigint {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lo = dv.getBigUint64(off, true);
  const hi = dv.getBigUint64(off + 8, true);
  const unsigned = (hi << 64n) | lo;
  const SIGN_BIT = 1n << 127n;
  if (unsigned >= SIGN_BIT) return unsigned - (1n << 128n);
  return unsigned;
}

function readU128LE(buf: Uint8Array, off: number): bigint {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lo = dv.getBigUint64(off, true);
  const hi = dv.getBigUint64(off + 8, true);
  return (hi << 64n) | lo;
}

function parseMatcherContext(data: Uint8Array): MatcherCtxData | null {
  if (data.length < CTX_BASE + 208) return null;

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = dv.getBigUint64(CTX_BASE, true);
  if (magic !== PERCMATC_MAGIC) return null;

  return {
    magic,
    version: dv.getUint32(CTX_BASE + 8, true),
    kind: dv.getUint8(CTX_BASE + 12),
    lpPda: new PublicKey(data.slice(CTX_BASE + 16, CTX_BASE + 48)),
    baseFeeBps: dv.getUint32(CTX_BASE + 48, true),
    minSpreadBps: dv.getUint32(CTX_BASE + 52, true),
    maxSpreadBps: dv.getUint32(CTX_BASE + 56, true),
    imbalanceKBps: dv.getUint32(CTX_BASE + 60, true),
    liquidityNotionalE6: readU128LE(data, CTX_BASE + 64),
    maxFillAbs: readU128LE(data, CTX_BASE + 80),
    inventoryBase: readI128LE(data, CTX_BASE + 96),
    lastOraclePriceE6: dv.getBigUint64(CTX_BASE + 112, true),
    lastExecPriceE6: dv.getBigUint64(CTX_BASE + 120, true),
    maxInventoryAbs: readU128LE(data, CTX_BASE + 128),
    insuranceSnapshot: readU128LE(data, CTX_BASE + 144),
    totalOiSnapshot: readU128LE(data, CTX_BASE + 160),
    marketAgeSlots: dv.getBigUint64(CTX_BASE + 176, true),
    lastDeficitSlot: dv.getBigUint64(CTX_BASE + 184, true),
    snapshotSlot: dv.getBigUint64(CTX_BASE + 192, true),
    ageHalflifeSlots: dv.getUint32(CTX_BASE + 200, true),
    insuranceWeightBps: dv.getUint32(CTX_BASE + 204, true),
  };
}

export interface UseMatcherCtxResult {
  data: MatcherCtxData | null;
  loading: boolean;
  error: string | null;
}

/**
 * Hook to fetch and parse the credibility matcher context account.
 * Polls every 5 seconds.
 */
export function useMatcherCtx(rpcUrl: string): UseMatcherCtxResult {
  const [data, setData] = useState<MatcherCtxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const doFetch = useCallback(async () => {
    try {
      const connection = new Connection(rpcUrl, "confirmed");
      const info = await connection.getAccountInfo(MATCHER_CTX);
      if (!info) {
        setError("Matcher context account not found");
        return;
      }
      const parsed = parseMatcherContext(info.data);
      if (!parsed) {
        setError("Invalid matcher context data");
        return;
      }
      setData(parsed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rpcUrl]);

  useEffect(() => {
    doFetch();
    const id = setInterval(doFetch, 5_000);
    return () => clearInterval(id);
  }, [doFetch]);

  return { data, loading, error };
}
