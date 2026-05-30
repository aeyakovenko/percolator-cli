/**
 * Pure, network-free risk math for the v16 maintenance-margin / liquidation model.
 *
 * Source of truth: README.md "Configuration" + the keeper health-buffer rule —
 * the keeper computes each account's health OFF-CHAIN as
 *     (capital + pnl − fee_debt)  vs  Σ maintenance_req
 * and an account is liquidatable when that buffer goes negative. maintenance_req
 * for one position is its notional × maintenance-margin-bps.
 *
 * Live mainnet bounty-5 params (README.md):
 *   maintenance margin (mm) = 500 bps  (→ 20× nominal leverage, im == mm)
 *   liquidation_fee_bps     = 5
 * (The pre-v16 t14 harness hard-coded mm=500/im=1000/liq_fee=100bps for a different
 *  single-market build; the v16 on-chain values above supersede it.)
 *
 * These are integer-exact (bigint) to match the engine's fixed-point accounting —
 * no floats anywhere in the solvency path.
 */

export const MAINTENANCE_MARGIN_BPS = 500n; // 5% → 20× max leverage (im == mm on v16)
export const LIQUIDATION_FEE_BPS = 5n;      // 0.05%
export const BPS = 10_000n;

/**
 * Maintenance margin required to hold a position.
 *   notional        = |position| × price
 *   maintenance_req = notional × mm_bps / 10_000
 * `position` and `price` are in the engine's integer units (basis-q × price-e6);
 * the ratio is what matters for the health comparison, so units cancel consistently.
 */
export function maintenanceRequired(
  positionBasisQ: bigint,
  price: bigint,
  mmBps: bigint = MAINTENANCE_MARGIN_BPS,
): bigint {
  const abs = positionBasisQ < 0n ? -positionBasisQ : positionBasisQ;
  const notional = abs * price;
  return (notional * mmBps) / BPS;
}

/** Liquidation fee charged on the closed notional (frees engine envelope budget). */
export function liquidationFee(
  positionBasisQ: bigint,
  price: bigint,
  feeBps: bigint = LIQUIDATION_FEE_BPS,
): bigint {
  const abs = positionBasisQ < 0n ? -positionBasisQ : positionBasisQ;
  const notional = abs * price;
  return (notional * feeBps) / BPS;
}

export interface Position {
  basisPosQ: bigint; // signed: + long, − short
  price: bigint;     // mark/oracle price the health buffer is evaluated at
}

export interface AccountRisk {
  capital: bigint;
  pnl: bigint;       // signed
  feeDebt: bigint;   // ≥ 0, subtracted from the buffer
  positions: Position[];
}

/** Equity available to back margin: capital + pnl − fee_debt. */
export function availableEquity(a: AccountRisk): bigint {
  return a.capital + a.pnl - a.feeDebt;
}

/** Σ maintenance_req across all of the account's positions. */
export function totalMaintenanceRequired(
  a: AccountRisk,
  mmBps: bigint = MAINTENANCE_MARGIN_BPS,
): bigint {
  return a.positions.reduce((sum, p) => sum + maintenanceRequired(p.basisPosQ, p.price, mmBps), 0n);
}

/** Health buffer = available equity − Σ maintenance_req. Negative ⇒ liquidatable. */
export function healthBuffer(a: AccountRisk, mmBps: bigint = MAINTENANCE_MARGIN_BPS): bigint {
  return availableEquity(a) - totalMaintenanceRequired(a, mmBps);
}

/** An account is liquidatable when its health buffer is below zero. */
export function isLiquidatable(a: AccountRisk, mmBps: bigint = MAINTENANCE_MARGIN_BPS): boolean {
  return healthBuffer(a, mmBps) < 0n;
}
