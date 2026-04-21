import { PublicKey } from "@solana/web3.js";
import type { InitMarketArgs } from "../src/abi/instructions.js";

/**
 * Default Hyperp market params used by the stress / live-verify / preflight
 * scripts. Each caller can override individual fields. Keep the structure
 * aligned with `src/abi/instructions.ts#InitMarketArgs` so the encoder
 * accepts the payload without partial-tail rejection.
 */
export function defaultInitMarketArgs(
  admin: PublicKey,
  mint: PublicKey,
  overrides: Partial<InitMarketArgs> = {},
): InitMarketArgs {
  return {
    admin,
    collateralMint: mint,
    indexFeedId: "0000000000000000000000000000000000000000000000000000000000000000",
    maxStalenessSecs: "60",
    confFilterBps: 200,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: "100000000", // $100
    maintenanceFeePerSlot: "0",
    maxInsuranceFloor: "10000000000000000",
    minOraclePriceCapE2bps: "0",
    hMin: "4",
    maintenanceMarginBps: "500",
    initialMarginBps: "1000",
    tradingFeeBps: "10",
    maxAccounts: "64",
    insuranceFloor: "0",
    hMax: "200",
    maxCrankStalenessSlots: "10000",
    liquidationFeeBps: "100",
    liquidationFeeCap: "1000000000",
    resolvePriceDeviationBps: "5000",
    minLiquidationAbs: "100000",
    minInitialDeposit: "1000000",
    minNonzeroMmReq: "100000",
    minNonzeroImReq: "200000",
    // withdrawal disabled by default — tests that need it set both fields
    insuranceWithdrawMaxBps: 0,
    insuranceWithdrawCooldownSlots: "0",
    permissionlessResolveStaleSlots: "0",
    fundingHorizonSlots: "500",
    fundingKBps: "100",
    fundingMaxPremiumBps: "500",
    fundingMaxBpsPerSlot: "10",
    markMinFee: "0",
    forceCloseDelaySlots: "0",
    ...overrides,
  };
}
