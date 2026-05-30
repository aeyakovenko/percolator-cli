/**
 * v16 verification: read the devnet smoke market + all portfolios from
 * the v16 program; parse everything; print a summary. This validates the
 * parsers against on-chain ground truth.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  parseHeader, parseWrapperConfig, parseMarketGroup, parsePortfolio,
  isMarket, isPortfolio,
  discoverMarkets, discoverPortfolios,
  MARKET_ACCOUNT_LEN, PORTFOLIO_ACCOUNT_LEN, MarketMode, OracleMode,
} from "../src/v16/index.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM = new PublicKey(process.env.V16_PROGRAM_ID ?? "Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");

const conn = new Connection(RPC, "confirmed");

function j(v: any): any {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(j);
  if (v && typeof v === "object") {
    if (v.toBase58) return v.toBase58();
    const o: any = {};
    for (const [k, val] of Object.entries(v)) o[k] = j(val);
    return o;
  }
  return v;
}

async function main() {
  console.log("v16 inspect");
  console.log("  program:", PROGRAM.toBase58());
  console.log("  rpc:    ", RPC);

  console.log("\n=== Discovering markets ===");
  const markets = await discoverMarkets(conn, PROGRAM);
  console.log(`Found ${markets.length} market(s).`);
  for (const m of markets) {
    console.log(`\n--- Market ${m.address.toBase58()} ---`);
    console.log("  admin:        ", m.config.admin.toBase58());
    console.log("  mint:         ", m.config.collateralMint.toBase58());
    console.log("  mode:         ", m.group.mode === MarketMode.Live ? "Live"
                                  : m.group.mode === MarketMode.Resolved ? "Resolved"
                                  : `unknown(${m.group.mode})`);
    console.log("  oracle_mode:  ",
      m.config.oracleMode === OracleMode.Manual ? "Manual"
      : m.config.oracleMode === OracleMode.HybridAfterHours ? "HybridAfterHours"
      : m.config.oracleMode === OracleMode.Hyperp ? "Hyperp"
      : `unknown(${m.config.oracleMode})`);
    console.log("  vault:        ", m.group.vault.toString());
    console.log("  insurance:    ", m.group.insurance.toString());
    console.log("  c_tot:        ", m.group.cTot.toString());
    console.log("  pnl_pos_tot:  ", m.group.pnlPosTot.toString());
    console.log("  slot_last/cur:", `${m.group.slotLast} / ${m.group.currentSlot}`);
    console.log("  mat_port_cnt: ", m.group.materializedPortfolioCount.toString());
    console.log("  neg_pnl_cnt:  ", m.group.negativePnlAccountCount.toString());
    console.log("  mark_ewma_e6: ", m.config.markEwmaE6.toString(),
                "@ slot",   m.config.markEwmaLastSlot.toString());
    console.log("  trade_fee_bp: ", m.config.tradeFeeBaseBps.toString());
    console.log("  asset_activation_count:", m.group.assetActivationCount.toString());
    console.log("  truly-active assets:  ", m.group.assets.length, "(filtered out 16-slot placeholders)");
    for (const a of m.group.assets) {
      console.log(`    asset[${a.index}] lifecycle=${a.lifecycle} effPrice=${a.effectivePrice} ` +
                  `mode_L/S=${a.modeLong}/${a.modeShort} ` +
                  `oi_eff_L/S=${a.oiEffLongQ}/${a.oiEffShortQ} ` +
                  `stored_pos_L/S=${a.storedPosCountLong}/${a.storedPosCountShort}`);
    }
  }

  console.log("\n=== Discovering portfolios ===");
  const portfolios = await discoverPortfolios(conn, PROGRAM);
  console.log(`Found ${portfolios.length} portfolio(s).`);
  for (const p of portfolios) {
    const active = p.data.legs.length;
    console.log(`\n--- Portfolio ${p.address.toBase58()} ---`);
    console.log("  owner:        ", p.data.owner.toBase58());
    console.log("  capital:      ", p.data.capital.toString());
    console.log("  pnl:          ", p.data.pnl.toString());
    console.log("  reserved_pnl: ", p.data.reservedPnl.toString());
    console.log("  fee_credits:  ", p.data.feeCredits.toString());
    console.log("  active legs:  ", active, ` (bitmap=0x${p.data.activeBitmap.toString(16) + "n"})`);
    console.log("  stale L/B:    ", `${p.data.staleState} / ${p.data.bStaleState}`);
    console.log("  reb/liq lock: ", `${p.data.rebalanceLock} / ${p.data.liquidationLock}`);
    for (const l of p.data.legs) {
      console.log(`    leg[${l.index}] side=${l.side === 0 ? "long" : "short"} ` +
                  `basis_pos_q=${l.basisPosQ} a_basis=${l.aBasis} ` +
                  `b_snap=${l.bSnap} b_rem=${l.bRem} stale=${l.stale}`);
    }
  }

  // Sanity assertions
  let asserts = 0;
  let failed = 0;
  function check(name: string, ok: boolean) {
    asserts++;
    if (ok) console.log(`  ✓ ${name}`);
    else { console.log(`  ✗ ${name}`); failed++; }
  }
  console.log("\n=== Invariants ===");
  for (const m of markets) {
    const tag = m.address.toBase58().slice(0, 8);
    // Filter portfolios that belong to *this* market (by provenance.market_group_id).
    const minePortfolios = portfolios.filter(p =>
      p.data.marketGroupId.equals(m.address));
    const sumPortfolioCapital = minePortfolios.reduce((s, p) => s + p.data.capital, 0n);

    // vault ≥ Σ capital is a *lower-bound* invariant — it holds for any subset of
    // portfolios (capital is non-negative), so a partial discovery can't break it.
    check(`market[${tag}] vault ≥ Σ portfolio capital  (vault=${m.group.vault}, Σcapital=${sumPortfolioCapital}, n=${minePortfolios.length})`,
      m.group.vault >= sumPortfolioCapital);

    // c_tot == Σ capital is an *exact* conservation identity — but only over the
    // COMPLETE portfolio set. getProgramAccounts can return a partial set (RPC
    // node truncation / pagination / eventual consistency), in which case an exact
    // check would report a fake conservation violation. The group's own
    // materialized_portfolio_count tells us how many portfolios should exist, so
    // we only assert exact equality when we've discovered all of them; otherwise we
    // fall back to the always-true lower bound (c_tot ≥ Σ over a subset) and flag
    // the discovery as partial rather than failing.
    const expectedPortfolios = m.group.materializedPortfolioCount;
    const discoveryComplete = BigInt(minePortfolios.length) >= expectedPortfolios;
    if (discoveryComplete) {
      check(`market[${tag}] c_tot == Σ portfolio capital  (c_tot=${m.group.cTot}, Σcapital=${sumPortfolioCapital}, n=${minePortfolios.length}/${expectedPortfolios})`,
        m.group.cTot === sumPortfolioCapital);
    } else {
      console.log(`  ⚠ market[${tag}] partial discovery — c_tot==Σcapital skipped ` +
        `(found ${minePortfolios.length} of ${expectedPortfolios} materialized portfolios; ` +
        `asserting lower bound c_tot ≥ Σcapital instead)`);
      check(`market[${tag}] c_tot ≥ Σ portfolio capital (partial set)  (c_tot=${m.group.cTot}, Σcapital=${sumPortfolioCapital})`,
        m.group.cTot >= sumPortfolioCapital);
    }
  }
  console.log(`\n${asserts - failed}/${asserts} invariants passed.`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
