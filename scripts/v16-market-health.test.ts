import assert from "node:assert/strict";
import test from "node:test";
import {
  assessV16MarketHealth,
  formatV16MarketHealth,
  parseUsdcAmount,
  parseUsdcFloor,
  readV16MarketCollateralMint,
  readV16MarketHealthSnapshot,
} from "./v16-market-health.ts";

const MAGIC = 0x5045_5243_5631_3600n;
const MARKET_GROUP_OFF = 464;
const MARKET_GROUP_HEADER_LEN = 726;
const ASSET_SLOT_LEN = 1797;
const ASSET_BASE = MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN;
const ENGINE_BASE = ASSET_BASE + 512;
const ADL_ONE = 1_000_000_000_000_000n;
const CREDIT_RATE_ONE = 1_000_000_000_000n;
const MARKET_ID = new Uint8Array(32).fill(3);
const LP_ID = new Uint8Array(32).fill(4);

function writeU128(data: Buffer, offset: number, value: bigint): void {
  data.writeBigUInt64LE(value & ((1n << 64n) - 1n), offset);
  data.writeBigUInt64LE(value >> 64n, offset + 8);
}

function writeI128(data: Buffer, offset: number, value: bigint): void {
  writeU128(data, offset, value < 0n ? value + (1n << 128n) : value);
}

function marketFixture(input: {
  vault?: bigint;
  capital?: bigint;
  domainInsurance?: bigint;
  insurance?: bigint;
  lossStale?: boolean;
} = {}): Buffer {
  const insurance = input.insurance ?? 10_000_000_000n;
  const domainInsurance = input.domainInsurance ?? insurance;
  const data = Buffer.alloc(MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN + ASSET_SLOT_LEN);
  data.writeBigUInt64LE(MAGIC, 0);
  data.writeUInt16LE(16, 8);
  data.writeUInt8(1, 10);
  data.set(new Uint8Array(32).fill(1), 16);
  data.set(new Uint8Array(32).fill(2), 48);
  data.set(MARKET_ID, MARKET_GROUP_OFF);
  data.writeUInt32LE(1, MARKET_GROUP_OFF + 281);
  writeU128(data, MARKET_GROUP_OFF + 285, input.vault ?? 120_000_000_000n);
  writeU128(data, MARKET_GROUP_OFF + 301, insurance);
  writeU128(data, MARKET_GROUP_OFF + 317, input.capital ?? 100_000_000_000n);
  writeU128(data, MARKET_GROUP_OFF + 461, domainInsurance);
  data.writeBigUInt64LE(1n, MARKET_GROUP_OFF + 517);
  data.writeBigUInt64LE(1n, MARKET_GROUP_OFF + 525);
  data.writeBigUInt64LE(1n, MARKET_GROUP_OFF + 557);
  data.writeBigUInt64LE(1n, MARKET_GROUP_OFF + 565);
  data.writeBigUInt64LE(1000n, MARKET_GROUP_OFF + 573);
  data.writeBigUInt64LE(1000n, MARKET_GROUP_OFF + 581);
  data.writeUInt8(input.lossStale ? 1 : 0, MARKET_GROUP_OFF + 591);
  data.writeBigUInt64LE(1000n, 168);
  data.writeUInt8(2, ENGINE_BASE + 16);
  data.writeBigUInt64LE(1000n, ENGINE_BASE + 41);
  writeU128(data, ENGINE_BASE + 49, ADL_ONE);
  writeU128(data, ENGINE_BASE + 65, ADL_ONE);
  const longBudget = domainInsurance / 2n;
  writeU128(data, ENGINE_BASE + 499, longBudget);
  writeU128(data, ENGINE_BASE + 515, domainInsurance - longBudget);
  writeU128(data, ENGINE_BASE + 579 + 160, CREDIT_RATE_ONE);
  writeU128(data, ENGINE_BASE + 763 + 160, CREDIT_RATE_ONE);
  data.writeBigUInt64LE(2000n, ENGINE_BASE + 947 + 88);
  data.writeBigUInt64LE(2000n, ENGINE_BASE + 1044 + 88);
  data.writeUInt8(1, ENGINE_BASE + 947 + 96);
  data.writeUInt8(1, ENGINE_BASE + 1044 + 96);
  return data;
}

function lpFixture(input: {
  capital?: bigint;
  pnl?: bigint;
  feeCredits?: bigint;
  activeBitmap?: bigint;
  certValid?: boolean;
  certifiedEquity?: bigint;
  initialRequirement?: bigint;
  maintenanceRequirement?: bigint;
} = {}): Buffer {
  const data = Buffer.alloc(9411);
  data.writeBigUInt64LE(MAGIC, 0);
  data.writeUInt16LE(16, 8);
  data.writeUInt8(2, 10);
  data.set(MARKET_ID, 16);
  data.set(LP_ID, 48);
  writeU128(data, 148, input.capital ?? 50_000_000_000n);
  writeI128(data, 164, input.pnl ?? 0n);
  writeI128(data, 308, input.feeCredits ?? 0n);
  data.writeBigUInt64LE(input.activeBitmap ?? 1n, 348);
  writeI128(data, 8932, input.certifiedEquity ?? 48_000_000_000n);
  writeU128(data, 8948, input.initialRequirement ?? 10_000_000_000n);
  writeU128(data, 8964, input.maintenanceRequirement ?? 5_000_000_000n);
  data.writeBigUInt64LE(1n, 9012);
  data.writeBigUInt64LE(1n, 9020);
  data.writeBigUInt64LE(1n, 9028);
  data.writeBigUInt64LE(1n, 9036);
  data.writeUInt8(input.certValid === false ? 0 : 1, 9052);
  return data;
}

function snapshot(input: {
  custody?: bigint;
  market?: Parameters<typeof marketFixture>[0];
  lp?: Parameters<typeof lpFixture>[0];
  observedSlot?: bigint;
} = {}) {
  return readV16MarketHealthSnapshot({
    custodyBalance: input.custody ?? input.market?.vault ?? 120_000_000_000n,
    expectedLpPortfolio: LP_ID,
    expectedMarket: MARKET_ID,
    lpData: lpFixture(input.lp),
    marketData: marketFixture(input.market),
    observedClusterSlot: input.observedSlot ?? 1000n,
  });
}

function snapshotFromBuffers(
  marketData: Buffer,
  lpData = lpFixture(),
  observedClusterSlot = 1000n,
) {
  return readV16MarketHealthSnapshot({
    custodyBalance: readU128ForTest(marketData, MARKET_GROUP_OFF + 285),
    expectedLpPortfolio: LP_ID,
    expectedMarket: MARKET_ID,
    lpData,
    marketData,
    observedClusterSlot,
  });
}

function readU128ForTest(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset) | (data.readBigUInt64LE(offset + 8) << 64n);
}

test("healthy LP separates custody, aggregate capital, insurance, and matcher equity", () => {
  const health = assessV16MarketHealth(snapshot(), 10_000_000_000n);
  assert.equal(health.level, "healthy");
  assert.equal(health.lpCapital, 50_000_000_000n);
  assert.equal(health.lpRiskEquity, 50_000_000_000n);
  assert.equal(health.accountingResidual, 10_000_000_000n);
  assert.equal(health.custodyDelta, 0n);
  assert.deepEqual(health.reasons, []);
});

test("zero-capital negative-PnL matcher is critical even when custody is large", () => {
  const health = assessV16MarketHealth(snapshot({
    lp: { capital: 0n, pnl: -12_900_000_000n, certifiedEquity: -12_900_000_000n },
  }), 10_000_000_000n);
  assert.equal(health.level, "critical");
  assert.equal(health.lpBookEquity, -12_900_000_000n);
  assert.equal(health.lpRiskEquity, -12_900_000_000n);
  assert.ok(health.reasons.some((reason) => reason.includes("non-positive")));
  assert.ok(health.reasons.some((reason) => reason.includes("operating floor")));
  const rendered = formatV16MarketHealth(health);
  assert.match(rendered, /LP HEALTH CRITICAL/);
  assert.match(rendered, /capital \$0\.00/);
  assert.match(rendered, /pnl -\$12,900\.00/);
  assert.match(rendered, /custody \$120,000\.00/);
});

test("negative PnL and fee debt reduce conservative risk equity", () => {
  const health = assessV16MarketHealth(snapshot({
    lp: { capital: 50_000_000_000n, pnl: -8_000_000_000n, feeCredits: 2_000_000_000n },
  }), 10_000_000_000n);
  assert.equal(health.level, "warning");
  assert.equal(health.lpRiskEquity, 40_000_000_000n);
  assert.ok(health.reasons.some((reason) => reason.includes("negative released PnL")));
});

test("custody/accounting mismatch and an impossible senior stack fail invalid", () => {
  const custodyMismatch = assessV16MarketHealth(snapshot({ custody: 119_000_000_000n }), 0n);
  assert.equal(custodyMismatch.level, "invalid");
  assert.equal(custodyMismatch.custodyDelta, -1_000_000_000n);
  assert.ok(custodyMismatch.invalidReasons.some((reason) => reason.includes("custody")));

  const seniorDeficit = assessV16MarketHealth(snapshot({
    market: { vault: 100n, capital: 90n, insurance: 20n },
    custody: 100n,
  }), 0n);
  assert.equal(seniorDeficit.level, "invalid");
  assert.equal(seniorDeficit.accountingResidual, null);
});

test("loss-stale and maintenance deficits are critical; invalid certificates stay explicit", () => {
  assert.equal(assessV16MarketHealth(snapshot({ market: { lossStale: true } }), 0n).level, "critical");
  const underMaintenance = assessV16MarketHealth(snapshot({
    lp: { certifiedEquity: 4_000_000_000n, maintenanceRequirement: 5_000_000_000n },
  }), 0n);
  assert.equal(underMaintenance.level, "critical");
  assert.ok(underMaintenance.criticalReasons.some((reason) => reason.includes("maintenance")));

  const unavailable = assessV16MarketHealth(snapshot({ lp: { certValid: false, activeBitmap: 3n } }), 0n);
  assert.equal(unavailable.level, "critical");
  assert.equal(unavailable.lpCertifiedEquity, null);
  assert.ok(unavailable.reasons.some((reason) => reason.includes("without a current health certificate")));
});

test("zero-OI residue, reset mode, and non-unit A are critical", () => {
  const market = marketFixture();
  writeU128(market, ENGINE_BASE + 353, 1n);
  market.writeBigUInt64LE(1n, ENGINE_BASE + 305);
  writeU128(market, ENGINE_BASE + 49, ADL_ONE - 1n);
  market.writeUInt8(2, ENGINE_BASE + 497);
  const health = assessV16MarketHealth(snapshotFromBuffers(market), 0n);
  assert.equal(health.level, "critical");
  assert.ok(health.reasons.some((reason) => reason.includes("zero-OI residue")));
  assert.ok(health.reasons.some((reason) => reason.includes("zero OI with non-unit A")));
  assert.ok(health.reasons.some((reason) => reason.includes("not in normal mode")));
});

test("open interest with a non-unit A is critical", () => {
  const market = marketFixture();
  writeU128(market, ENGINE_BASE + 273, 500_000n);
  writeU128(market, ENGINE_BASE + 353, 500_000n);
  market.writeBigUInt64LE(1n, ENGINE_BASE + 305);
  writeU128(market, ENGINE_BASE + 49, ADL_ONE - 1n);
  const health = assessV16MarketHealth(snapshotFromBuffers(market), 0n);
  assert.equal(health.level, "critical");
  assert.ok(health.reasons.some((reason) => reason.includes("open interest with non-unit A")));
});

test("insurance-domain accounting fails closed and stale backing is critical", () => {
  const inconsistent = marketFixture();
  writeU128(inconsistent, MARKET_GROUP_OFF + 461, 9_000_000_000n);
  const accounting = assessV16MarketHealth(snapshotFromBuffers(inconsistent), 0n);
  assert.equal(accounting.level, "invalid");
  assert.ok(accounting.reasons.some((reason) => reason.includes("does not sum")));

  const stale = marketFixture();
  stale.writeUInt8(0, ENGINE_BASE + 947 + 96);
  writeU128(stale, ENGINE_BASE + 763 + 160, CREDIT_RATE_ONE - 1n);
  const backing = assessV16MarketHealth(snapshotFromBuffers(stale), 0n);
  assert.equal(backing.level, "critical");
  assert.ok(backing.reasons.some((reason) => reason.includes("backing is not fresh")));
  assert.ok(backing.reasons.some((reason) => reason.includes("credit rate is not 1")));
});

test("clock lag and stale LP certificate epochs are critical", () => {
  const lagged = assessV16MarketHealth(snapshot({ observedSlot: 1301n }), 0n, {
    maxClockLagSlots: 300n,
  });
  assert.equal(lagged.level, "critical");
  assert.ok(lagged.reasons.some((reason) => reason.includes("clock exceeds")));

  const lp = lpFixture();
  lp.writeBigUInt64LE(2n, 9012);
  const staleCert = assessV16MarketHealth(snapshotFromBuffers(marketFixture(), lp), 0n);
  assert.equal(staleCert.level, "critical");
  assert.equal(staleCert.lpCertCurrent, false);
  assert.ok(staleCert.reasons.some((reason) => reason.includes("current health certificate")));
});

test("only Active and DrainOnly assets require live clock bounds", () => {
  for (const lifecycle of [2, 3]) {
    const market = marketFixture();
    market.writeUInt8(lifecycle, ENGINE_BASE + 16);
    market.writeBigUInt64LE(1n, ENGINE_BASE + 41);
    market.writeBigUInt64LE(1n, 168);
    const health = assessV16MarketHealth(snapshotFromBuffers(market), 0n, {
      maxClockLagSlots: 300n,
    });
    assert.equal(health.level, "critical");
    assert.ok(health.criticalReasons.includes("asset 0 state clock exceeds the configured lag limit"));
    assert.ok(health.criticalReasons.includes("asset 0 oracle clock exceeds the configured lag limit"));
  }

  for (const lifecycle of [1, 5]) {
    const market = marketFixture();
    market.writeUInt8(lifecycle, ENGINE_BASE + 16);
    market.writeBigUInt64LE(1n, ENGINE_BASE + 41);
    market.writeBigUInt64LE(1n, 168);
    const health = assessV16MarketHealth(snapshotFromBuffers(market), 0n, {
      maxClockLagSlots: 300n,
    });
    assert.equal(health.level, "healthy");
    assert.equal(health.assets[0]?.lifecycle, lifecycle);
    assert.equal(health.assets[0]?.sideStateLag, 999n);
    assert.equal(health.assets[0]?.oracleLag, 999n);
  }
});

test("Recovery assets retain financial, residue, backing, and authority checks", () => {
  const market = marketFixture();
  market.writeUInt8(5, ENGINE_BASE + 16);
  market.writeBigUInt64LE(1n, ENGINE_BASE + 41);
  market.writeBigUInt64LE(1n, 168);
  writeU128(market, ENGINE_BASE + 353, 1n);
  market.writeBigUInt64LE(1n, ENGINE_BASE + 305);
  market.writeUInt8(0, ENGINE_BASE + 947 + 96);
  const health = assessV16MarketHealth(snapshotFromBuffers(market), 0n, {
    maxClockLagSlots: 300n,
    requireAuthorityParity: true,
  });
  assert.equal(health.level, "critical");
  assert.ok(health.criticalReasons.includes("asset 0 long has zero-OI residue"));
  assert.ok(health.criticalReasons.includes("insurance domain 0 backing is not fresh"));
  assert.ok(!health.criticalReasons.some((reason) => reason.includes("asset 0 state clock")));
  assert.ok(!health.criticalReasons.some((reason) => reason.includes("asset 0 oracle clock")));
});

test("unknown lifecycle encodings fail closed", () => {
  const market = marketFixture();
  market.writeUInt8(6, ENGINE_BASE + 16);
  assert.throws(() => snapshotFromBuffers(market), /invalid lifecycle encoding/);
});

test("recovered target is healthy only with certified risk equity and exact insurance", () => {
  const health = assessV16MarketHealth(snapshot({
    market: {
      vault: 200_000_000_000n,
      capital: 100_000_000_000n,
      insurance: 100_000_000_000n,
      domainInsurance: 100_000_000_000n,
    },
    lp: {
      capital: 100_000_000_000n,
      certifiedEquity: 100_000_000_000n,
    },
  }), 0n, {
    expectedDomainInsurance: 100_000_000_000n,
    maxClockLagSlots: 300n,
    minimumLpRiskEquity: 100_000_000_000n,
    requireAuthorityParity: true,
  });
  assert.equal(health.level, "healthy");
  assert.equal(health.lpRiskEquity, 100_000_000_000n);
  assert.equal(health.lpCertCurrent, true);
  assert.equal(health.domainInsurance, 100_000_000_000n);
});

test("operational floors allow bounded credit haircuts without hiding financial failures", () => {
  const market = marketFixture();
  writeU128(market, ENGINE_BASE + 579 + 160, CREDIT_RATE_ONE / 2n);
  const health = assessV16MarketHealth(snapshotFromBuffers(market), 0n, {
    maxClockLagSlots: 300n,
    minimumDomainInsurance: 9_000_000_000n,
    minimumLpRiskEquity: 40_000_000_000n,
    requireAuthorityParity: true,
    requireFullSourceCredit: false,
  });
  assert.equal(health.level, "warning");
  assert.ok(health.warningReasons.includes("insurance domain 0 source credit rate is not 1"));
  assert.equal(health.criticalReasons.length, 0);

  const underinsured = assessV16MarketHealth(snapshot(), 0n, {
    minimumDomainInsurance: 11_000_000_000n,
    requireFullSourceCredit: false,
  });
  assert.equal(underinsured.level, "critical");
  assert.ok(underinsured.criticalReasons.includes(
    "domain insurance is below the configured operational floor",
  ));
});

test("a source credit rate above one is invalid in every audit profile", () => {
  const market = marketFixture();
  writeU128(market, ENGINE_BASE + 579 + 160, CREDIT_RATE_ONE + 1n);
  const health = assessV16MarketHealth(snapshotFromBuffers(market), 0n, {
    requireFullSourceCredit: false,
  });
  assert.equal(health.level, "invalid");
  assert.ok(health.invalidReasons.includes("insurance domain 0 source credit rate exceeds 1"));
});

test("identity, boolean, and operating-floor parsing fail closed", () => {
  const wrongLp = lpFixture();
  wrongLp.fill(9, 48, 80);
  assert.throws(() => readV16MarketHealthSnapshot({
    custodyBalance: 0n,
    expectedLpPortfolio: LP_ID,
    expectedMarket: MARKET_ID,
    lpData: wrongLp,
    marketData: marketFixture(),
  }), /identity/);

  const oversizedLp = Buffer.concat([lpFixture(), Buffer.from([0])]);
  assert.throws(() => readV16MarketHealthSnapshot({
    custodyBalance: 0n,
    expectedLpPortfolio: LP_ID,
    expectedMarket: MARKET_ID,
    lpData: oversizedLp,
    marketData: marketFixture(),
  }), /wrong length/);

  const wrongMarket = marketFixture();
  wrongMarket.fill(8, MARKET_GROUP_OFF, MARKET_GROUP_OFF + 32);
  assert.throws(
    () => readV16MarketCollateralMint(wrongMarket, MARKET_ID),
    /market account identity/,
  );

  const malformed = marketFixture();
  malformed.writeUInt8(2, MARKET_GROUP_OFF + 591);
  assert.throws(() => readV16MarketHealthSnapshot({
    custodyBalance: 0n,
    expectedLpPortfolio: LP_ID,
    expectedMarket: MARKET_ID,
    lpData: lpFixture(),
    marketData: malformed,
  }), /boolean/);

  assert.equal(parseUsdcFloor(undefined), 10_000_000_000n);
  assert.equal(parseUsdcFloor("1250.5"), 1_250_500_000n);
  assert.throws(() => parseUsdcFloor("-1"), /LP_MIN_CAPITAL_USDC/);
  assert.equal(parseUsdcAmount(undefined, 100_000, "TARGET"), 100_000_000_000n);
  assert.throws(() => parseUsdcAmount("1.0000001", 0, "TARGET"), /TARGET/);
});
