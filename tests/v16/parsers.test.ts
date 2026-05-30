/**
 * Golden-vector parser test.
 *
 * Decodes the real on-chain mainnet bounty-5 v16 market + keeper portfolio
 * (committed fixtures) and asserts every safety-critical risk field against
 * known-good values — the values printed by `scripts/v16-inspect.ts` against
 * the same account, independently re-derived here from constants.ts offsets.
 *
 * This is the offline regression guard the live parser never had: a future
 * header/offset/stride drift in constants.ts that silently mis-decodes the
 * risk state will fail HERE, before it can mis-report vault/insurance/c_tot on
 * chain.
 */
import {
  parseHeader, isMarket, isPortfolio,
  parseWrapperConfig, parseMarketGroup, parsePortfolio,
} from "../../src/v16/parsers.js";
import {
  MAGIC, VERSION, KIND_MARKET, KIND_PORTFOLIO,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN,
  MARKET_GROUP_OFF, ASSET_SLOT_LEN, MG,
  V16_MAX_MARKET_SLOTS, AssetLifecycle,
} from "../../src/v16/constants.js";
import { loadFixture } from "./fixtures.js";
import { Suite, TestResult } from "./harness.js";

export function runParserTests(): TestResult {
  const s = new Suite("v16 parsers — golden vectors (real mainnet accounts)");

  // ----------------------------------------------------------------- market
  const market = loadFixture("market-bhkmic5g.json");
  const mbuf = market.data;

  s.run("market: header + identity", () => {
    s.eq(mbuf.length, MARKET_ACCOUNT_LEN, "market account length == MARKET_ACCOUNT_LEN (capacity 64)");
    s.check(isMarket(mbuf), "isMarket() recognises the KIND_MARKET header");
    s.check(!isPortfolio(mbuf), "isPortfolio() rejects a market account");
    const h = parseHeader(mbuf);
    s.eq(h.magic, MAGIC, "header magic == PERCV16");
    s.eq(h.version, VERSION, "header version == 16");
    s.eq(h.kind, KIND_MARKET, "header kind == KIND_MARKET");
  });

  const wc = parseWrapperConfig(mbuf);
  s.run("market: WrapperConfigV16 safety fields", () => {
    s.eq(wc.admin.toBase58(), "A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK", "admin pubkey");
    s.eq(wc.collateralMint.toBase58(), "So11111111111111111111111111111111111111112", "collateral mint == wSOL");
    s.eq(wc.permissionlessResolveStaleSlots, 6_480_000n, "permissionlessResolveStaleSlots (~30d)");
    s.eq(wc.forceCloseDelaySlots, 216_000n, "forceCloseDelaySlots (~24h)");
    s.eq(wc.feeRedirectToMarket0Bps, 2000, "feeRedirectToMarket0Bps (20%)");
    s.eq(wc.invert, 1, "invert == 1 (inverted market)");
  });

  const g = parseMarketGroup(mbuf);
  s.run("market: MarketGroupV16 risk state", () => {
    // The conservation anchors — these are what the keeper / inspect actually trust.
    s.eq(g.vault, 1_505_865_425n, "vault");
    s.eq(g.insurance, 1_505_865_425n, "insurance");
    s.eq(g.cTot, 0n, "c_tot");
    s.eq(g.pnlPosTot, 0n, "pnl_pos_tot");
    s.eq(g.pnlMaturedPosTot, 0n, "pnl_matured_pos_tot");
    s.eq(g.mode, 0, "mode == Live");
    s.eq(g.materializedPortfolioCount, 1n, "materialized_portfolio_count");
    s.eq(g.assetActivationCount, 1n, "asset_activation_count");
  });

  s.run("market: per-asset lifecycle + price (legs decode at correct offset)", () => {
    // asset[0..2] are Active with non-trivial marks; asset[3] is Retired; the rest
    // are Disabled (price 0). The leg sits at slot+ASSET_ORACLE_WRAPPER_LEN — a
    // wrong stride would shift these prices.
    const byIndex = new Map(g.assets.map((a) => [a.index, a]));
    const a0 = byIndex.get(0)!;
    const a1 = byIndex.get(1)!;
    const a2 = byIndex.get(2)!;
    const a3 = byIndex.get(3)!;
    s.eq(a0.lifecycle, AssetLifecycle.Active, "asset[0] lifecycle == Active");
    s.eq(a0.effectivePrice, 12157n, "asset[0] effective_price");
    s.eq(a1.effectivePrice, 1_173_863n, "asset[1] effective_price");
    s.eq(a2.effectivePrice, 1119n, "asset[2] effective_price");
    s.eq(a3.lifecycle, AssetLifecycle.Retired, "asset[3] lifecycle == Retired");
    s.eq(a3.effectivePrice, 1_000_000n, "asset[3] effective_price");
  });

  // -------------------------------------------------- conservation identity
  s.run("market: conservation identity holds on real account", () => {
    // vault == c_tot + insurance + pnl_pos_tot  (the global solvency identity).
    s.eq(g.vault, g.cTot + g.insurance + g.pnlPosTot,
      "vault == c_tot + insurance + pnl_pos_tot");
  });

  // ----------------------------------------------------- asset_slot_capacity
  // Regression guard for the (formerly latent) capacity bug: the parser now reads
  // the authoritative on-chain `asset_slot_capacity` (u32) instead of inferring the
  // slot count from the account byte length. The two MUST agree for a well-formed
  // account; a mismatch signals header/stride drift.
  s.run("market: asset_slot_capacity is authoritative + matches length-derivation", () => {
    const derived = Math.floor((mbuf.length - MARKET_GROUP_OFF - MG.asset_slots) / ASSET_SLOT_LEN);
    s.eq(g.assetSlotCapacity, V16_MAX_MARKET_SLOTS, "assetSlotCapacity == 64 (on-chain u32 @ MG.asset_slot_capacity)");
    s.eq(g.assetSlotCapacity, derived, "stored asset_slot_capacity == (len - asset_slots) / ASSET_SLOT_LEN");
    // Independently re-read the u32 to prove we read the right offset (not vault, etc.).
    s.eq(mbuf.readUInt32LE(MARKET_GROUP_OFF + MG.asset_slot_capacity), 64,
      "raw u32 @ MARKET_GROUP_OFF+MG.asset_slot_capacity == 64");
  });

  // -------------------------------------------------------------- portfolio
  const pf = loadFixture("portfolio-keeper.json");
  const pbuf = pf.data;

  s.run("portfolio: header + provenance + capital", () => {
    s.eq(pbuf.length, PORTFOLIO_ACCOUNT_LEN, "portfolio account length == PORTFOLIO_ACCOUNT_LEN");
    s.check(isPortfolio(pbuf), "isPortfolio() recognises the KIND_PORTFOLIO header");
    s.check(!isMarket(pbuf), "isMarket() rejects a portfolio account");
    const h = parseHeader(pbuf);
    s.eq(h.kind, KIND_PORTFOLIO, "header kind == KIND_PORTFOLIO");

    const p = parsePortfolio(pbuf);
    // provenance.market_group_id is the MARKET account pubkey — links the portfolio
    // back to the market the v16-inspect invariant filters on.
    s.eq(p.marketGroupId.toBase58(), market.meta.address, "provenance market_group_id == market address");
    s.eq(p.portfolioAccountId.toBase58(), pf.meta.address, "provenance portfolio_account_id == own address");
    s.eq(p.owner.toBase58(), "A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK", "owner pubkey");
    s.eq(p.capital, 0n, "capital");
    s.eq(p.pnl, 0n, "pnl");
    s.eq(p.activeBitmap, 0n, "active_bitmap == 0 (no open legs)");
    s.eq(p.legs.length, 0, "no active legs");
  });

  // Cross-account conservation, the way scripts/v16-inspect.ts asserts it: with the
  // ONE materialized portfolio fully discovered, c_tot must equal Σ capital exactly.
  s.run("cross-account: c_tot == Σ portfolio capital (complete discovery)", () => {
    const p = parsePortfolio(pbuf);
    const sumCapital = p.capital; // the single materialized portfolio for this market
    s.eq(g.cTot, sumCapital, "c_tot == Σ portfolio capital");
    s.check(g.vault >= sumCapital, "vault ≥ Σ portfolio capital");
  });

  return s.report();
}
