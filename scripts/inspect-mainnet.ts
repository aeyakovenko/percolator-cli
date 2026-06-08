import { Connection, PublicKey } from "@solana/web3.js";
import { parseMarketGroup, parseWrapperConfig } from "../src/v16/parsers.js";

(async () => {
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const MARKET = new PublicKey("4AXbMuJzrUv5KtVs6zc5jDtXTB4XKhKtEBGU6BmkVut4");
  const PROG = new PublicKey("4m3ipBQDYX6JQ9YSmUXDjESDHMtGWtiXforkWr9Qoxdi");

  const ai = (await conn.getAccountInfo(MARKET, "confirmed"))!;
  console.log("market:    ", MARKET.toBase58());
  console.log("owner:     ", ai.owner.toBase58(), ai.owner.equals(PROG) ? "✓" : "✗ NOT WRAPPER");
  console.log("rent SOL:  ", (ai.lamports / 1e9).toFixed(6));
  console.log("account:   ", ai.data.length, "B");

  const buf = Buffer.from(ai.data);
  const wc: any = parseWrapperConfig(buf);
  const mg: any = parseMarketGroup(buf);

  console.log("\n--- wrapper config ---");
  console.log("marketauth:           ", wc.marketauth.toBase58());
  console.log("collateral_mint:      ", wc.collateralMint.toBase58());
  console.log("trade_fee_base_bps:   ", wc.tradeFeeBaseBps);
  console.log("maintenance_fee/slot: ", wc.maintenanceFeePerSlot);
  console.log("perm_resolve_stale:   ", wc.permissionlessResolveStaleSlots);
  console.log("force_close_delay:    ", wc.forceCloseDelaySlots);
  console.log("perm_init_fee:        ", wc.permissionlessMarketInitFee);
  console.log("oracle_mode:          ", wc.oracleMode, "(1=HYBRID_AFTER_HOURS)");
  console.log("last_good_oracle_slot:", wc.lastGoodOracleSlot);

  console.log("\n--- market group header ---");
  console.log("asset_slot_capacity:  ", mg.assetSlotCapacity);
  console.log("vault:                ", mg.vault);
  console.log("insurance:            ", mg.insurance);
  console.log("c_tot:                ", mg.cTot);
  console.log("pnl_pos_tot:          ", mg.pnlPosTot);
  console.log("pnl_matured_pos_tot:  ", mg.pnlMaturedPosTot);
  console.log("materialized portfs:  ", mg.materializedPortfolioCount);
  console.log("stale_certs:          ", mg.staleCertificateCount);
  console.log("mode:                 ", mg.mode, "(0=Live)");
  console.log("current_slot:         ", mg.currentSlot);
  console.log("slot_last:            ", mg.slotLast);

  console.log("\n--- assets (only present if active/configured) ---");
  if (mg.assets.length === 0) {
    console.log("  (no active assets — placeholders filtered out by parser)");
  }
  for (const a of mg.assets) {
    console.log(`asset[${a.index}]: lifecycle=${a.lifecycle} eff_price=${a.effectivePrice} oi_long=${a.oiEffLongQ} oi_short=${a.oiEffShortQ} stored_long=${a.storedPosCountLong} stored_short=${a.storedPosCountShort} slot_last=${a.slotLast}`);
  }

  const now = BigInt(await conn.getSlot("confirmed"));
  console.log("\n--- liveness ---");
  console.log("network slot:         ", now);
  console.log("slots since oracle:   ", now - wc.lastGoodOracleSlot);
  console.log("slots since accrue:   ", now - mg.slotLast);

  // Hunt for portfolios under this program with provenance pointing at this market
  console.log("\n--- portfolios under this market ---");
  try {
    const pfsNew = await conn.getProgramAccounts(PROG, {
      commitment: "confirmed",
      filters: [
        { dataSize: 9347 },
        { memcmp: { offset: 16 + 32, bytes: MARKET.toBase58() } },
      ],
    });
    console.log("portfolios @ 9347 B (post-realloc):", pfsNew.length);
    for (const p of pfsNew) console.log("   ", p.pubkey.toBase58());
    const pfsOld = await conn.getProgramAccounts(PROG, {
      commitment: "confirmed",
      filters: [
        { dataSize: 9299 },
        { memcmp: { offset: 16 + 32, bytes: MARKET.toBase58() } },
      ],
    });
    console.log("portfolios @ 9299 B (PRE-realloc):", pfsOld.length);
    for (const p of pfsOld) console.log("   ", p.pubkey.toBase58());
  } catch (e: any) {
    console.log("portfolio scan skipped:", e.message?.slice(0, 100));
  }
})().catch(e => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
