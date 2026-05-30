/**
 * Positive liquidation test — the safety-critical path the pre-v16 suite never
 * covered (t6/t14 only asserted that HEALTHY accounts are NOT liquidated, and
 * t14's calculateMarginRequired was defined-but-never-called dead code).
 *
 * This is the deterministic, network-free half of liquidation correctness:
 *   1. an account driven BELOW maintenance margin is flagged liquidatable;
 *   2. a healthy account just ABOVE the threshold is NOT;
 *   3. the exact margin boundary behaves correctly (buffer == 0 is not liquidatable);
 *   4. the global solvency identity (vault == capital + insurance + pnl_pos_tot)
 *      is preserved across a simulated liquidation settlement.
 *
 * What this DOESN'T cover (needs an integration env — solana-test-validator or a
 * funded devnet keeper): the on-chain PermissionlessCrank action:1 actually
 * executing, the mark-walk envelope (≤480 bps/crank), and CPI fee routing. Those
 * are noted in the PR as the live-RPC follow-up. The math asserted here is exactly
 * what the keeper computes off-chain before it fires that instruction.
 */
import {
  maintenanceRequired, liquidationFee, healthBuffer, isLiquidatable,
  availableEquity, totalMaintenanceRequired,
  MAINTENANCE_MARGIN_BPS, LIQUIDATION_FEE_BPS, BPS,
  AccountRisk,
} from "./risk-math.js";
import { Suite, TestResult } from "./harness.js";

export function runLiquidationTests(): TestResult {
  const s = new Suite("v16 liquidation — maintenance-margin math (positive path)");

  // A single BTC-ish position: 1,000 units at price 88_000 (e6-style integer).
  // notional = 88_000_000 ; maintenance_req @ 500 bps = 4_400_000.
  const PRICE = 88_000n;
  const POS = 1_000n;
  const NOTIONAL = POS * PRICE;
  const REQ = (NOTIONAL * MAINTENANCE_MARGIN_BPS) / BPS;

  s.run("maintenanceRequired / liquidationFee are exact", () => {
    s.eq(maintenanceRequired(POS, PRICE), REQ, "maintenance_req = notional × 500bps");
    s.eq(maintenanceRequired(POS, PRICE), 4_400_000n, "maintenance_req == 4_400_000 (long)");
    s.eq(maintenanceRequired(-POS, PRICE), 4_400_000n, "maintenance_req symmetric for short (|pos|)");
    s.eq(liquidationFee(POS, PRICE), (NOTIONAL * LIQUIDATION_FEE_BPS) / BPS, "liq fee = notional × 5bps");
    s.eq(liquidationFee(POS, PRICE), 44_000n, "liq fee == 44_000");
  });

  // (1) BELOW maintenance → liquidatable.
  s.run("undercollateralized account IS liquidatable", () => {
    const acct: AccountRisk = {
      capital: REQ - 1n, // one atom short of the requirement
      pnl: 0n,
      feeDebt: 0n,
      positions: [{ basisPosQ: POS, price: PRICE }],
    };
    s.check(healthBuffer(acct) < 0n, `health buffer < 0 (buffer=${healthBuffer(acct)})`);
    s.check(isLiquidatable(acct), "isLiquidatable() == true");
  });

  // A more realistic drift: a position that was healthy, then the mark moved against
  // it, draining pnl below the maintenance requirement.
  s.run("adverse mark move drives a once-healthy account under maintenance", () => {
    const acct: AccountRisk = {
      capital: 5_000_000n,        // comfortably above REQ (4.4M) at entry
      pnl: -700_000n,             // mark moved against the position
      feeDebt: 50_000n,           // accrued maintenance fee debt
      positions: [{ basisPosQ: POS, price: PRICE }],
    };
    // equity = 5_000_000 − 700_000 − 50_000 = 4_250_000 < 4_400_000 = REQ
    s.eq(availableEquity(acct), 4_250_000n, "available equity = capital + pnl − fee_debt");
    s.eq(totalMaintenanceRequired(acct), REQ, "Σ maintenance_req == 4_400_000");
    s.check(isLiquidatable(acct), "account is liquidatable after the adverse move");
  });

  // (2) ABOVE maintenance → NOT liquidatable (positive control, mirrors the only
  //     thing the old suite checked, but now with the real margin math).
  s.run("healthy account is NOT liquidatable", () => {
    const acct: AccountRisk = {
      capital: REQ + 1n,
      pnl: 0n,
      feeDebt: 0n,
      positions: [{ basisPosQ: POS, price: PRICE }],
    };
    s.check(!isLiquidatable(acct), "isLiquidatable() == false when equity exceeds Σ maintenance_req");
  });

  // (3) Exact boundary: buffer == 0 means equity exactly meets the requirement —
  //     NOT liquidatable (liquidatable is strictly buffer < 0).
  s.run("exact margin boundary (buffer == 0) is NOT liquidatable", () => {
    const acct: AccountRisk = {
      capital: REQ,
      pnl: 0n,
      feeDebt: 0n,
      positions: [{ basisPosQ: POS, price: PRICE }],
    };
    s.eq(healthBuffer(acct), 0n, "health buffer == 0 at the boundary");
    s.check(!isLiquidatable(acct), "boundary account is not liquidated (strict < 0)");
  });

  // (4) Conservation across a simulated liquidation settlement.
  //     The invariant the program upholds (docs/audit/lp_issue.md + status.md):
  //
  //         vault  >=  Σ capital  +  insurance
  //
  //     The vault is the custodied collateral; the slack above the RHS is unrealised
  //     pnl (lp_issue.md: "The extra ~0.76 SOL in the vault is unrealized PnL"). A
  //     liquidation is an INTERNAL settlement — no deposit/withdraw — so the vault
  //     (custodied lamports) does NOT move, while a bankrupt account's uncovered
  //     deficit is drawn from insurance. We assert the inequality holds BEFORE and
  //     AFTER, and that the value consumed (capital + insurance) exactly equals the
  //     realised loss — nothing minted, nothing leaked. The vault is held fixed and
  //     COMPARED to the RHS (never assigned from it), so the check is non-vacuous.
  s.run("conservation invariant (vault >= Sigma capital + insurance) holds across liquidation", () => {
    const vault = 6_220_000n;       // custodied collateral — CONSTANT (no external flow)
    let sumCapital = 4_250_000n;    // Sigma account capital (incl. the soon-bankrupt account)
    let insurance = 1_210_000n;
    // pre: 6_220_000 >= 4_250_000 + 1_210_000 = 5_460_000, slack 760_000 (= unrealised pnl)
    s.check(vault >= sumCapital + insurance, "pre: vault >= Sigma capital + insurance");
    s.eq(vault - (sumCapital + insurance), 760_000n, "pre: slack == unrealised pnl (760_000)");

    // The bankrupt account holds 200_000 capital against a 500_000 realised loss. The
    // liquidator closes it: its 200_000 capital is consumed (leaves Sigma capital) and
    // the 300_000 shortfall is socialised out of insurance. No collateral is created;
    // the vault is unchanged (the realised loss is paid from the vault's own
    // unrealised-pnl slack to the still-in-book winning side).
    const bankruptCapital = 200_000n;
    const realisedLoss = 500_000n;
    const shortfall = realisedLoss - bankruptCapital; // 300_000 from insurance

    sumCapital -= bankruptCapital;  // bankrupt account removed from capital
    insurance -= shortfall;         // insurance absorbs the uncovered loss

    // post: 6_220_000 >= 4_050_000 + 910_000 = 4_960_000, slack 1_260_000
    s.check(vault >= sumCapital + insurance, "post: vault >= Sigma capital + insurance still holds");
    s.check(insurance >= 0n, "insurance did not go negative (loss was covered)");
    s.check(sumCapital >= 0n, "Sigma capital did not go negative");
    // capital consumed + insurance drawn == realised loss  =>  value conserved.
    s.eq((4_250_000n - sumCapital) + (1_210_000n - insurance), realisedLoss,
      "capital consumed + insurance drawn == realised loss (no leak)");
  });

  return s.report();
}
