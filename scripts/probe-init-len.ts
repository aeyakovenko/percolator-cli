import { encInitMarket } from "../src/v16/instructions.js";
const buf = encInitMarket({
  maxPortfolioAssets: 4,
  hMin: 0n, hMax: 6_480_000n, initialPrice: 1_000_000n,
  minNonzeroMmReq: 500n, minNonzeroImReq: 600n,
  maintenanceMarginBps: 500n, initialMarginBps: 500n,
  maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 1n,
  liquidationFeeBps: 5n, liquidationFeeCap: 50_000_000_000n,
  minLiquidationAbs: 0n,
  maxPriceMoveBpsPerSlot: 49n, maxAccrualDtSlots: 10n,
  maxAbsFundingE9PerSlot: 1_000n, minFundingLifetimeSlots: 10_000_000n,
  maxAccountBSettlementChunks: 16n, maxBankruptCloseChunks: 16n,
  maxBankruptCloseLifetimeSlots: 10_000_000n,
  publicBChunkAtoms: 1_000_000n, maintenanceFeePerSlot: 58n,
});
console.log("bytes:", buf.length);
console.log("tag:", buf[0]);
console.log("hex:", buf.toString("hex"));
