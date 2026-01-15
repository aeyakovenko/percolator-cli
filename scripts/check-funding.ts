/**
 * Check funding state on the market
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseAccount } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

function readI128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigInt64LE(off + 8);
  return (hi << 64n) | lo;
}

async function main() {
  const data = await fetchSlab(connection, SLAB);

  // Parse funding state from engine (at ENGINE_OFF = 328)
  const ENGINE_OFF = 328;

  // Engine layout (SBF u128 has 8-byte alignment):
  // vault: u128 @ 0
  // insurance_fund: {balance: u128, fee_revenue: u128} @ 16
  // params: RiskParams (144 bytes) @ 48
  // current_slot: u64 @ 192
  // funding_index_qpb_e6: i128 @ 200
  // last_funding_slot: u64 @ 216
  const vault = readI128LE(data, ENGINE_OFF + 0);
  const insuranceBalance = readI128LE(data, ENGINE_OFF + 16);
  const currentSlot = data.readBigUInt64LE(ENGINE_OFF + 192);
  const fundingIndex = readI128LE(data, ENGINE_OFF + 200);
  const lastFundingSlot = data.readBigUInt64LE(ENGINE_OFF + 216);

  // MarketConfig at offset 72 (after 72-byte header)
  // Layout (repr(C)):
  // - collateral_mint: 32 bytes @ 0
  // - vault_pubkey: 32 bytes @ 32
  // - index_feed_id: 32 bytes @ 64
  // - max_staleness_secs: u64 @ 96
  // - conf_filter_bps: u16 @ 104
  // - vault_authority_bump: u8 @ 106
  // - invert: u8 @ 107
  // - unit_scale: u32 @ 108
  // - funding_horizon_slots: u64 @ 112
  // - funding_k_bps: u64 @ 120
  // - funding_inv_scale_notional_e6: u128 @ 128
  // - funding_max_premium_bps: i64 @ 144
  // - funding_max_bps_per_slot: i64 @ 152
  const CONFIG_OFF = 72;
  const confFilterBps = data.readUInt16LE(CONFIG_OFF + 104);
  const vaultBump = data.readUInt8(CONFIG_OFF + 106);
  const invert = data.readUInt8(CONFIG_OFF + 107);
  const unitScale = data.readUInt32LE(CONFIG_OFF + 108);
  const fundingHorizon = data.readBigUInt64LE(CONFIG_OFF + 112);
  const fundingKBps = data.readBigUInt64LE(CONFIG_OFF + 120);
  const fundingScale = readI128LE(data, CONFIG_OFF + 128);
  const fundingMaxPremium = data.readBigInt64LE(CONFIG_OFF + 144);
  const fundingMaxPerSlot = data.readBigInt64LE(CONFIG_OFF + 152);

  console.log('=== Market Config ===');
  console.log('Conf Filter Bps:', confFilterBps);
  console.log('Invert:', invert, invert === 1 ? '(price is inverted!)' : '');
  console.log('Unit Scale:', unitScale);

  // net_lp_pos found at engine offset 82360 via empirical search
  const NET_LP_POS_OFF = 82360;
  const netLpPos = readI128LE(data, ENGINE_OFF + NET_LP_POS_OFF);
  const lpSumAbs = readI128LE(data, ENGINE_OFF + NET_LP_POS_OFF + 16);
  const lpMaxAbs = readI128LE(data, ENGINE_OFF + NET_LP_POS_OFF + 32);

  // Compute what the effective_funding_rate should be
  // (replicate compute_inventory_funding_bps_per_slot logic)
  function computeFundingRate(
    netPos: bigint,
    priceE6: bigint,
    horizon: bigint,
    kBps: bigint,
    scale: bigint,
    maxPremium: bigint,
    maxPerSlot: bigint
  ): bigint {
    if (netPos === 0n || priceE6 === 0n || horizon === 0n) return 0n;

    const absPos = netPos < 0n ? -netPos : netPos;
    const notionalE6 = absPos * priceE6 / 1_000_000n;
    let premiumBps = notionalE6 * kBps / (scale > 0n ? scale : 1n);

    if (premiumBps > maxPremium) premiumBps = maxPremium;

    const signedPremium = netPos > 0n ? premiumBps : -premiumBps;
    let perSlot = signedPremium / horizon;

    // Clamp to max
    if (perSlot > maxPerSlot) perSlot = maxPerSlot;
    if (perSlot < -maxPerSlot) perSlot = -maxPerSlot;

    return perSlot;
  }

  // Use hardcoded price since we don't parse oracle here
  const oraclePrice = 138_000_000n; // ~$138
  const computedRate = computeFundingRate(
    netLpPos,
    oraclePrice,
    fundingHorizon,
    fundingKBps,
    fundingScale,
    BigInt(fundingMaxPremium),
    BigInt(fundingMaxPerSlot)
  );

  console.log('\n=== Funding Rate Calculation ===');
  console.log('Input net_lp_pos:', netLpPos.toString());
  console.log('Input price (e6):', oraclePrice.toString());
  console.log('Input horizon:', fundingHorizon.toString());
  console.log('Input k_bps:', fundingKBps.toString());
  console.log('Input scale:', fundingScale.toString());
  console.log('Input max_premium:', fundingMaxPremium.toString());
  console.log('Input max_per_slot:', fundingMaxPerSlot.toString());
  console.log('=> Computed rate (bps/slot):', computedRate.toString());

  console.log('=== Engine State ===');
  console.log('Vault:', Number(vault) / 1e9, 'SOL');
  console.log('Insurance Balance:', Number(insuranceBalance) / 1e9, 'SOL');
  console.log('Current Slot:', currentSlot.toString());
  console.log('Funding Index (i128):', fundingIndex.toString());
  console.log('Last Funding Slot:', lastFundingSlot.toString());
  console.log('Net LP Position:', netLpPos.toString());
  console.log('LP Sum Abs:', lpSumAbs.toString());
  console.log('LP Max Abs:', lpMaxAbs.toString());

  console.log('\n=== Funding Config ===');
  console.log('Horizon Slots:', fundingHorizon.toString());
  console.log('K Bps:', fundingKBps.toString());
  console.log('Scale (notional e6):', fundingScale.toString());
  console.log('Max Premium Bps:', fundingMaxPremium.toString());
  console.log('Max Bps/Slot:', fundingMaxPerSlot.toString());

  console.log('\n=== Account States ===');
  for (let i = 0; i <= 5; i++) {
    const acc = parseAccount(data, i);
    if (acc) {
      const label = i === 0 ? 'LP' : `Trader ${i}`;
      const fundingDelta = fundingIndex - acc.fundingIndex;
      const fundingOwed = (fundingDelta * acc.positionSize) / (10n ** 6n);  // rough calc
      console.log(`[${i}] ${label}:`);
      console.log(`    Position: ${acc.positionSize}`);
      console.log(`    Capital: ${Number(acc.capital) / 1e9} SOL`);
      console.log(`    PnL: ${acc.pnl}`);
      console.log(`    Acct Funding Index: ${acc.fundingIndex}`);
      console.log(`    Funding Delta: ${fundingDelta} (owed: ${fundingOwed})`);
    }
  }
}

main().catch(console.error);
