const V16_MAGIC = 0x5045_5243_5631_3600n;
const V16_VERSION = 16;
const KIND_MARKET = 1;
const KIND_PORTFOLIO = 2;
const HEADER_LEN = 16;
const MARKET_GROUP_OFF = HEADER_LEN + 448;
const MARKET_GROUP_HEADER_LEN = 726;
const MARKET_MIN_LEN = MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN;
const ASSET_ORACLE_WRAPPER_LEN = 512;
const ASSET_SLOT_LEN = 1797;
const ENGINE_ASSET_OFF = ASSET_ORACLE_WRAPPER_LEN;
const MARKET_ID_OFF = MARKET_GROUP_OFF;
const COLLATERAL_MINT_OFF = HEADER_LEN + 32;
const MARKET_AUTHORITY_OFF = HEADER_LEN;
const MARKET_ASSET_CAPACITY_OFF = MARKET_GROUP_OFF + 281;
const MARKET_VAULT_OFF = MARKET_GROUP_OFF + 285;
const MARKET_INSURANCE_OFF = MARKET_GROUP_OFF + 301;
const MARKET_C_TOT_OFF = MARKET_GROUP_OFF + 317;
const MARKET_DOMAIN_INSURANCE_OFF = MARKET_GROUP_OFF + 461;
const MARKET_NEGATIVE_PNL_ACCOUNTS_OFF = MARKET_GROUP_OFF + 509;
const MARKET_RISK_EPOCH_OFF = MARKET_GROUP_OFF + 517;
const MARKET_ASSET_SET_EPOCH_OFF = MARKET_GROUP_OFF + 525;
const MARKET_ORACLE_EPOCH_OFF = MARKET_GROUP_OFF + 557;
const MARKET_FUNDING_EPOCH_OFF = MARKET_GROUP_OFF + 565;
const MARKET_SLOT_LAST_OFF = MARKET_GROUP_OFF + 573;
const MARKET_CURRENT_SLOT_OFF = MARKET_GROUP_OFF + 581;
const MARKET_BANKRUPTCY_HLOCK_OFF = MARKET_GROUP_OFF + 589;
const MARKET_THRESHOLD_STRESS_OFF = MARKET_GROUP_OFF + 590;
const MARKET_LOSS_STALE_OFF = MARKET_GROUP_OFF + 591;

const ASSET_LIFECYCLE_OFF = 16;
const ASSET_SLOT_LAST_OFF = 41;
const ASSET_A_LONG_OFF = 49;
const ASSET_A_SHORT_OFF = 65;
const ASSET_OI_LONG_OFF = 273;
const ASSET_OI_SHORT_OFF = 289;
const ASSET_STORED_LONG_OFF = 305;
const ASSET_STORED_SHORT_OFF = 313;
const ASSET_STALE_LONG_OFF = 321;
const ASSET_STALE_SHORT_OFF = 329;
const ASSET_PENDING_LONG_OFF = 337;
const ASSET_PENDING_SHORT_OFF = 345;
const ASSET_WEIGHT_LONG_OFF = 353;
const ASSET_WEIGHT_SHORT_OFF = 369;
const ASSET_EPOCH_LONG_OFF = 481;
const ASSET_EPOCH_SHORT_OFF = 489;
const ASSET_MODE_LONG_OFF = 497;
const ASSET_MODE_SHORT_OFF = 498;

const AOP_INSURANCE_AUTHORITY_OFF = 24;
const AOP_INSURANCE_OPERATOR_OFF = 56;
const AOP_BACKING_AUTHORITY_OFF = 88;
const AOP_ORACLE_AUTHORITY_OFF = 120;
const AOP_LAST_GOOD_ORACLE_SLOT_OFF = 216;
const WRAPPER_LAST_GOOD_ORACLE_SLOT_OFF = HEADER_LEN + 152;

const ENGINE_INSURANCE_BUDGET_LONG_OFF = 499;
const ENGINE_INSURANCE_BUDGET_SHORT_OFF = 515;
const ENGINE_INSURANCE_SPENT_LONG_OFF = 531;
const ENGINE_INSURANCE_SPENT_SHORT_OFF = 547;
const ENGINE_SOURCE_LONG_OFF = 579;
const ENGINE_SOURCE_SHORT_OFF = 763;
const SOURCE_CREDIT_RATE_OFF = 160;
const ENGINE_BACKING_LONG_OFF = 947;
const ENGINE_BACKING_SHORT_OFF = 1044;
const BACKING_EXPIRY_OFF = 88;
const BACKING_STATUS_OFF = 96;

const ADL_ONE = 1_000_000_000_000_000n;
const CREDIT_RATE_ONE = 1_000_000_000_000n;
const BACKING_FRESH = 1;
const LIFECYCLE_UNINITIALIZED = 0;
const LIFECYCLE_ACTIVE = 2;
const LIFECYCLE_DRAIN_ONLY = 3;
const LIFECYCLE_RETIRED = 4;
const LIFECYCLE_RECOVERY = 5;

const PORTFOLIO_STATE_OFF = HEADER_LEN;
const PORTFOLIO_MIN_LEN = 9411;
const PORTFOLIO_MARKET_OFF = PORTFOLIO_STATE_OFF;
const PORTFOLIO_ID_OFF = PORTFOLIO_STATE_OFF + 32;
const PORTFOLIO_CAPITAL_OFF = PORTFOLIO_STATE_OFF + 132;
const PORTFOLIO_PNL_OFF = PORTFOLIO_STATE_OFF + 148;
const PORTFOLIO_FEE_CREDITS_OFF = PORTFOLIO_STATE_OFF + 292;
const PORTFOLIO_ACTIVE_BITMAP_OFF = PORTFOLIO_STATE_OFF + 332;

// PortfolioAccountV16Account.health_cert follows 16 legs and 32 source-domain
// records. These offsets are guarded by the deployed v16 layout discriminator.
const HEALTH_CERT_OFF = PORTFOLIO_STATE_OFF + 8916;
const CERTIFIED_EQUITY_OFF = HEALTH_CERT_OFF;
const CERTIFIED_INITIAL_REQ_OFF = HEALTH_CERT_OFF + 16;
const CERTIFIED_MAINTENANCE_REQ_OFF = HEALTH_CERT_OFF + 32;
const CERTIFIED_ORACLE_EPOCH_OFF = HEALTH_CERT_OFF + 80;
const CERTIFIED_FUNDING_EPOCH_OFF = HEALTH_CERT_OFF + 88;
const CERTIFIED_RISK_EPOCH_OFF = HEALTH_CERT_OFF + 96;
const CERTIFIED_ASSET_SET_EPOCH_OFF = HEALTH_CERT_OFF + 104;
const HEALTH_CERT_VALID_OFF = HEALTH_CERT_OFF + 120;

function fail(message: string): never {
  throw new Error(message);
}

function u128(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset) | (data.readBigUInt64LE(offset + 8) << 64n);
}

function i128(data: Buffer, offset: number): bigint {
  const value = u128(data, offset);
  return value < (1n << 127n) ? value : value - (1n << 128n);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertHeader(data: Buffer, kind: number, label: string): void {
  if (data.length < HEADER_LEN) fail(`${label} account is too short`);
  if (data.readBigUInt64LE(0) !== V16_MAGIC
    || data.readUInt16LE(8) !== V16_VERSION
    || data.readUInt8(10) !== kind) {
    fail(`${label} account is not the expected v16 account kind`);
  }
}

function strictBool(data: Buffer, offset: number, label: string): boolean {
  const value = data.readUInt8(offset);
  if (value === 0) return false;
  if (value === 1) return true;
  return fail(`${label} has an invalid boolean encoding`);
}

function lifecycleRequiresLiveClock(lifecycle: number): boolean {
  return lifecycle === LIFECYCLE_ACTIVE || lifecycle === LIFECYCLE_DRAIN_ONLY;
}

function assertKnownLifecycle(lifecycle: number, asset: number): void {
  if (lifecycle < LIFECYCLE_UNINITIALIZED || lifecycle > LIFECYCLE_RECOVERY) {
    fail(`asset ${asset} has an invalid lifecycle encoding`);
  }
}

export interface V16SideHealthSnapshot {
  a: bigint;
  epoch: bigint;
  mode: number;
  oi: bigint;
  pending: bigint;
  side: "long" | "short";
  stale: bigint;
  stored: bigint;
  weight: bigint;
}

export interface V16AssetHealthSnapshot {
  asset: number;
  authorityParity: boolean;
  lifecycle: number;
  oracleLag: bigint;
  oracleSlot: bigint;
  sideStateLag: bigint;
  slotLast: bigint;
  sides: [V16SideHealthSnapshot, V16SideHealthSnapshot];
}

export interface V16DomainHealthSnapshot {
  asset: number;
  backingExpiry: bigint;
  backingStatus: number;
  budget: bigint;
  creditRate: bigint;
  domain: number;
  remaining: bigint;
  side: "long" | "short";
  spent: bigint;
}

export interface V16MarketHealthSnapshot {
  accountedVault: bigint;
  aggregateCapital: bigint;
  assets: V16AssetHealthSnapshot[];
  bankruptcyHlock: boolean;
  collateralMint: Uint8Array;
  custodyBalance: bigint;
  domainInsurance: bigint;
  domains: V16DomainHealthSnapshot[];
  insurance: bigint;
  lossStaleActive: boolean;
  lpActiveLegs: number;
  lpBookEquity: bigint;
  lpCapital: bigint;
  lpCertCurrent: boolean;
  lpCertifiedEquity: bigint | null;
  lpCertifiedInitialRequirement: bigint | null;
  lpCertifiedMaintenanceRequirement: bigint | null;
  lpFeeCredits: bigint;
  lpPnl: bigint;
  lpRiskEquity: bigint;
  marketAssetSetEpoch: bigint;
  marketClockLag: bigint;
  marketCurrentSlot: bigint;
  marketFundingEpoch: bigint;
  marketOracleEpoch: bigint;
  marketRiskEpoch: bigint;
  marketSlotLast: bigint;
  negativePnlAccounts: bigint;
  observedClusterSlot: bigint;
  thresholdStress: boolean;
}

export type V16MarketHealthLevel = "healthy" | "warning" | "critical" | "invalid";

export interface V16MarketHealthAssessment extends V16MarketHealthSnapshot {
  accountingResidual: bigint | null;
  criticalReasons: string[];
  custodyDelta: bigint;
  invalidReasons: string[];
  level: V16MarketHealthLevel;
  minimumLpCapital: bigint;
  reasons: string[];
  warningReasons: string[];
}

export interface V16MarketHealthOptions {
  expectedDomainInsurance?: bigint;
  maxClockLagSlots?: bigint;
  minimumDomainInsurance?: bigint;
  minimumLpRiskEquity?: bigint;
  requireAuthorityParity?: boolean;
  requireFullSourceCredit?: boolean;
}

function assetBase(asset: number): number {
  return MARKET_GROUP_OFF + MARKET_GROUP_HEADER_LEN + asset * ASSET_SLOT_LEN;
}

function engineAssetBase(asset: number): number {
  return assetBase(asset) + ENGINE_ASSET_OFF;
}

function sideSnapshot(data: Buffer, asset: number, side: "long" | "short"): V16SideHealthSnapshot {
  const base = engineAssetBase(asset);
  const long = side === "long";
  return {
    a: u128(data, base + (long ? ASSET_A_LONG_OFF : ASSET_A_SHORT_OFF)),
    epoch: data.readBigUInt64LE(base + (long ? ASSET_EPOCH_LONG_OFF : ASSET_EPOCH_SHORT_OFF)),
    mode: data.readUInt8(base + (long ? ASSET_MODE_LONG_OFF : ASSET_MODE_SHORT_OFF)),
    oi: u128(data, base + (long ? ASSET_OI_LONG_OFF : ASSET_OI_SHORT_OFF)),
    pending: data.readBigUInt64LE(base + (long ? ASSET_PENDING_LONG_OFF : ASSET_PENDING_SHORT_OFF)),
    side,
    stale: data.readBigUInt64LE(base + (long ? ASSET_STALE_LONG_OFF : ASSET_STALE_SHORT_OFF)),
    stored: data.readBigUInt64LE(base + (long ? ASSET_STORED_LONG_OFF : ASSET_STORED_SHORT_OFF)),
    weight: u128(data, base + (long ? ASSET_WEIGHT_LONG_OFF : ASSET_WEIGHT_SHORT_OFF)),
  };
}

function allAuthoritiesMatch(data: Buffer, asset: number, marketAuthority: Uint8Array): boolean {
  if (asset === 0) return true;
  const base = assetBase(asset);
  return [
    AOP_INSURANCE_AUTHORITY_OFF,
    AOP_INSURANCE_OPERATOR_OFF,
    AOP_BACKING_AUTHORITY_OFF,
    AOP_ORACLE_AUTHORITY_OFF,
  ].every((offset) => sameBytes(data.subarray(base + offset, base + offset + 32), marketAuthority));
}

export function readV16MarketCollateralMint(
  marketData: Buffer,
  expectedMarket: Uint8Array,
): Uint8Array {
  assertHeader(marketData, KIND_MARKET, "market");
  if (marketData.length < MARKET_MIN_LEN) fail("market account is too short for the v16 header");
  if (!sameBytes(marketData.subarray(MARKET_ID_OFF, MARKET_ID_OFF + 32), expectedMarket)) {
    fail("market account identity does not match the configured market");
  }
  return Uint8Array.from(marketData.subarray(COLLATERAL_MINT_OFF, COLLATERAL_MINT_OFF + 32));
}

export function readV16MarketHealthSnapshot(input: {
  custodyBalance: bigint;
  expectedLpPortfolio: Uint8Array;
  expectedMarket: Uint8Array;
  lpData: Buffer;
  marketData: Buffer;
  observedClusterSlot?: bigint;
}): V16MarketHealthSnapshot {
  const { lpData, marketData } = input;
  assertHeader(lpData, KIND_PORTFOLIO, "LP portfolio");
  if (lpData.length !== PORTFOLIO_MIN_LEN) fail("LP portfolio account has the wrong length");
  const collateralMint = readV16MarketCollateralMint(marketData, input.expectedMarket);
  if (!sameBytes(lpData.subarray(PORTFOLIO_MARKET_OFF, PORTFOLIO_MARKET_OFF + 32), input.expectedMarket)) {
    fail("LP portfolio belongs to a different market");
  }
  if (!sameBytes(lpData.subarray(PORTFOLIO_ID_OFF, PORTFOLIO_ID_OFF + 32), input.expectedLpPortfolio)) {
    fail("LP portfolio identity does not match the configured portfolio");
  }
  if (input.custodyBalance < 0n) fail("custody balance cannot be negative");

  const assetCapacity = marketData.readUInt32LE(MARKET_ASSET_CAPACITY_OFF);
  const expectedMarketLength = MARKET_MIN_LEN + assetCapacity * ASSET_SLOT_LEN;
  if (marketData.length !== expectedMarketLength) {
    fail("market account length does not match its v16 asset-slot capacity");
  }

  const marketAuthority = marketData.subarray(MARKET_AUTHORITY_OFF, MARKET_AUTHORITY_OFF + 32);
  const marketCurrentSlot = marketData.readBigUInt64LE(MARKET_CURRENT_SLOT_OFF);
  const observedClusterSlot = input.observedClusterSlot ?? marketCurrentSlot;
  const assets: V16AssetHealthSnapshot[] = [];
  const domains: V16DomainHealthSnapshot[] = [];
  for (let asset = 0; asset < assetCapacity; asset += 1) {
    const base = assetBase(asset);
    const engineBase = engineAssetBase(asset);
    const lifecycle = marketData.readUInt8(engineBase + ASSET_LIFECYCLE_OFF);
    assertKnownLifecycle(lifecycle, asset);
    if (lifecycle === LIFECYCLE_UNINITIALIZED || lifecycle === LIFECYCLE_RETIRED) continue;
    const slotLast = marketData.readBigUInt64LE(engineBase + ASSET_SLOT_LAST_OFF);
    const oracleSlot = marketData.readBigUInt64LE(
      asset === 0 ? WRAPPER_LAST_GOOD_ORACLE_SLOT_OFF : base + AOP_LAST_GOOD_ORACLE_SLOT_OFF,
    );
    assets.push({
      asset,
      authorityParity: allAuthoritiesMatch(marketData, asset, marketAuthority),
      lifecycle,
      oracleLag: marketCurrentSlot - oracleSlot,
      oracleSlot,
      sideStateLag: marketCurrentSlot - slotLast,
      slotLast,
      sides: [sideSnapshot(marketData, asset, "long"), sideSnapshot(marketData, asset, "short")],
    });
    for (const [sideIndex, side] of ["long", "short"].entries()) {
      const long = sideIndex === 0;
      const budget = u128(
        marketData,
        engineBase + (long ? ENGINE_INSURANCE_BUDGET_LONG_OFF : ENGINE_INSURANCE_BUDGET_SHORT_OFF),
      );
      const spent = u128(
        marketData,
        engineBase + (long ? ENGINE_INSURANCE_SPENT_LONG_OFF : ENGINE_INSURANCE_SPENT_SHORT_OFF),
      );
      if (spent > budget) fail(`insurance domain ${asset * 2 + sideIndex} spent exceeds its budget`);
      const source = engineBase + (long ? ENGINE_SOURCE_LONG_OFF : ENGINE_SOURCE_SHORT_OFF);
      const backing = engineBase + (long ? ENGINE_BACKING_LONG_OFF : ENGINE_BACKING_SHORT_OFF);
      domains.push({
        asset,
        backingExpiry: marketData.readBigUInt64LE(backing + BACKING_EXPIRY_OFF),
        backingStatus: marketData.readUInt8(backing + BACKING_STATUS_OFF),
        budget,
        creditRate: u128(marketData, source + SOURCE_CREDIT_RATE_OFF),
        domain: asset * 2 + sideIndex,
        remaining: budget - spent,
        side: side as "long" | "short",
        spent,
      });
    }
  }

  const lpCapital = u128(lpData, PORTFOLIO_CAPITAL_OFF);
  const lpPnl = i128(lpData, PORTFOLIO_PNL_OFF);
  const lpFeeCredits = i128(lpData, PORTFOLIO_FEE_CREDITS_OFF);
  const feeDebt = lpFeeCredits < 0n ? -lpFeeCredits : lpFeeCredits;
  const certValid = strictBool(lpData, HEALTH_CERT_VALID_OFF, "LP health certificate");
  const marketOracleEpoch = marketData.readBigUInt64LE(MARKET_ORACLE_EPOCH_OFF);
  const marketFundingEpoch = marketData.readBigUInt64LE(MARKET_FUNDING_EPOCH_OFF);
  const marketRiskEpoch = marketData.readBigUInt64LE(MARKET_RISK_EPOCH_OFF);
  const marketAssetSetEpoch = marketData.readBigUInt64LE(MARKET_ASSET_SET_EPOCH_OFF);
  const lpCertCurrent = certValid
    && lpData.readBigUInt64LE(CERTIFIED_ORACLE_EPOCH_OFF) === marketOracleEpoch
    && lpData.readBigUInt64LE(CERTIFIED_FUNDING_EPOCH_OFF) === marketFundingEpoch
    && lpData.readBigUInt64LE(CERTIFIED_RISK_EPOCH_OFF) === marketRiskEpoch
    && lpData.readBigUInt64LE(CERTIFIED_ASSET_SET_EPOCH_OFF) === marketAssetSetEpoch;
  const activeBitmap = lpData.readBigUInt64LE(PORTFOLIO_ACTIVE_BITMAP_OFF);
  let lpActiveLegs = 0;
  for (let bitmap = activeBitmap; bitmap !== 0n; bitmap >>= 1n) {
    lpActiveLegs += Number(bitmap & 1n);
  }

  return {
    accountedVault: u128(marketData, MARKET_VAULT_OFF),
    aggregateCapital: u128(marketData, MARKET_C_TOT_OFF),
    assets,
    bankruptcyHlock: strictBool(marketData, MARKET_BANKRUPTCY_HLOCK_OFF, "market bankruptcy lock"),
    collateralMint,
    custodyBalance: input.custodyBalance,
    domainInsurance: u128(marketData, MARKET_DOMAIN_INSURANCE_OFF),
    domains,
    insurance: u128(marketData, MARKET_INSURANCE_OFF),
    lossStaleActive: strictBool(marketData, MARKET_LOSS_STALE_OFF, "market loss-stale flag"),
    lpActiveLegs,
    lpBookEquity: lpCapital + lpPnl - feeDebt,
    lpCapital,
    lpCertCurrent,
    lpCertifiedEquity: certValid ? i128(lpData, CERTIFIED_EQUITY_OFF) : null,
    lpCertifiedInitialRequirement: certValid ? u128(lpData, CERTIFIED_INITIAL_REQ_OFF) : null,
    lpCertifiedMaintenanceRequirement: certValid ? u128(lpData, CERTIFIED_MAINTENANCE_REQ_OFF) : null,
    lpFeeCredits,
    lpPnl,
    // Positive released PnL is not safe margin support under a locked lane.
    lpRiskEquity: lpCapital + (lpPnl < 0n ? lpPnl : 0n) - feeDebt,
    marketAssetSetEpoch,
    marketClockLag: observedClusterSlot - marketCurrentSlot,
    marketCurrentSlot,
    marketFundingEpoch,
    marketOracleEpoch,
    marketRiskEpoch,
    marketSlotLast: marketData.readBigUInt64LE(MARKET_SLOT_LAST_OFF),
    negativePnlAccounts: marketData.readBigUInt64LE(MARKET_NEGATIVE_PNL_ACCOUNTS_OFF),
    observedClusterSlot,
    thresholdStress: strictBool(marketData, MARKET_THRESHOLD_STRESS_OFF, "market threshold-stress flag"),
  };
}

export function assessV16MarketHealth(
  snapshot: V16MarketHealthSnapshot,
  minimumLpCapital: bigint,
  options: V16MarketHealthOptions = {},
): V16MarketHealthAssessment {
  if (minimumLpCapital < 0n) fail("minimum LP capital cannot be negative");
  if (options.minimumLpRiskEquity !== undefined && options.minimumLpRiskEquity < 0n) {
    fail("minimum LP risk equity cannot be negative");
  }
  if (options.expectedDomainInsurance !== undefined && options.expectedDomainInsurance < 0n) {
    fail("expected domain insurance cannot be negative");
  }
  if (options.minimumDomainInsurance !== undefined && options.minimumDomainInsurance < 0n) {
    fail("minimum domain insurance cannot be negative");
  }
  if (options.maxClockLagSlots !== undefined && options.maxClockLagSlots < 0n) {
    fail("maximum clock lag cannot be negative");
  }
  const custodyDelta = snapshot.custodyBalance - snapshot.accountedVault;
  const seniorTotal = snapshot.aggregateCapital + snapshot.insurance;
  const accountingResidual = snapshot.accountedVault >= seniorTotal
    ? snapshot.accountedVault - seniorTotal
    : null;
  const invalidReasons: string[] = [];
  const criticalReasons: string[] = [];
  const warningReasons: string[] = [];

  if (custodyDelta !== 0n) invalidReasons.push("token custody does not equal the market's accounted vault");
  if (accountingResidual === null) invalidReasons.push("accounted vault is below aggregate capital plus insurance");
  const domainInsuranceSum = snapshot.domains.reduce((sum, domain) => sum + domain.remaining, 0n);
  if (domainInsuranceSum !== snapshot.domainInsurance) {
    invalidReasons.push("per-domain insurance does not sum to the market header aggregate");
  }
  if (snapshot.domainInsurance > snapshot.insurance) {
    invalidReasons.push("domain insurance exceeds global insurance");
  }
  if (snapshot.marketClockLag < 0n || snapshot.marketCurrentSlot < snapshot.marketSlotLast) {
    invalidReasons.push("market clocks are ahead of their observed parent clock");
  }
  for (const asset of snapshot.assets) {
    if (lifecycleRequiresLiveClock(asset.lifecycle)
      && (asset.sideStateLag < 0n || asset.oracleLag < 0n)) {
      invalidReasons.push(`asset ${asset.asset} clocks are ahead of the market clock`);
    }
  }
  if (snapshot.lpRiskEquity <= 0n) criticalReasons.push("LP no-positive-credit risk equity is non-positive");
  if (snapshot.lpCertifiedEquity !== null
    && snapshot.lpCertifiedMaintenanceRequirement !== null
    && snapshot.lpCertifiedEquity < snapshot.lpCertifiedMaintenanceRequirement) {
    criticalReasons.push("LP certified equity is below maintenance requirement");
  }
  if (snapshot.lossStaleActive) criticalReasons.push("market loss-stale lock is active");
  if (snapshot.bankruptcyHlock) criticalReasons.push("market bankruptcy lock is active");
  if (snapshot.thresholdStress) criticalReasons.push("market threshold-stress flag is active");
  if (snapshot.negativePnlAccounts !== 0n) criticalReasons.push("market has negative-PnL accounts");
  if (snapshot.lpActiveLegs > 0 && !snapshot.lpCertCurrent) {
    criticalReasons.push("LP has open legs without a current health certificate");
  }
  if (options.minimumLpRiskEquity !== undefined) {
    if (snapshot.lpRiskEquity < options.minimumLpRiskEquity) {
      criticalReasons.push("LP conservative risk equity is below the configured target");
    }
    if (!snapshot.lpCertCurrent || snapshot.lpCertifiedEquity === null) {
      criticalReasons.push("LP health certificate is not current for the configured target");
    } else if (snapshot.lpCertifiedEquity < options.minimumLpRiskEquity) {
      criticalReasons.push("LP certified equity is below the configured target");
    }
  }
  if (options.expectedDomainInsurance !== undefined
    && snapshot.domainInsurance !== options.expectedDomainInsurance) {
    criticalReasons.push("domain insurance does not equal the configured target");
  }
  if (options.minimumDomainInsurance !== undefined
    && snapshot.domainInsurance < options.minimumDomainInsurance) {
    criticalReasons.push("domain insurance is below the configured operational floor");
  }
  for (const asset of snapshot.assets) {
    if (options.requireAuthorityParity && !asset.authorityParity) {
      criticalReasons.push(`asset ${asset.asset} delegated authorities do not match market authority`);
    }
    if (options.maxClockLagSlots !== undefined && lifecycleRequiresLiveClock(asset.lifecycle)) {
      if (asset.sideStateLag > options.maxClockLagSlots) {
        criticalReasons.push(`asset ${asset.asset} state clock exceeds the configured lag limit`);
      }
      if (asset.oracleLag > options.maxClockLagSlots) {
        criticalReasons.push(`asset ${asset.asset} oracle clock exceeds the configured lag limit`);
      }
    }
    for (const side of asset.sides) {
      const label = `asset ${asset.asset} ${side.side}`;
      if (side.mode !== 0) criticalReasons.push(`${label} is not in normal mode`);
      if (side.stale !== 0n || side.pending !== 0n) {
        criticalReasons.push(`${label} has stale or pending obligations`);
      }
      if (side.oi === 0n) {
        if (side.weight !== 0n || side.stored !== 0n) {
          criticalReasons.push(`${label} has zero-OI residue`);
        }
        if (side.a !== ADL_ONE) criticalReasons.push(`${label} has zero OI with non-unit A`);
      } else {
        if (side.weight === 0n || side.stored === 0n) {
          criticalReasons.push(`${label} has open interest without weight or stored positions`);
        }
        if (side.a !== ADL_ONE) criticalReasons.push(`${label} has open interest with non-unit A`);
      }
    }
  }
  for (const domain of snapshot.domains) {
    if (domain.backingStatus !== BACKING_FRESH || domain.backingExpiry <= snapshot.marketCurrentSlot) {
      criticalReasons.push(`insurance domain ${domain.domain} backing is not fresh`);
    }
    if (domain.creditRate > CREDIT_RATE_ONE) {
      invalidReasons.push(`insurance domain ${domain.domain} source credit rate exceeds 1`);
    } else if (domain.creditRate !== CREDIT_RATE_ONE) {
      const reason = `insurance domain ${domain.domain} source credit rate is not 1`;
      if (options.requireFullSourceCredit ?? true) criticalReasons.push(reason);
      else warningReasons.push(reason);
    }
  }
  if (options.maxClockLagSlots !== undefined) {
    if (snapshot.marketClockLag > options.maxClockLagSlots
      || snapshot.marketCurrentSlot - snapshot.marketSlotLast > options.maxClockLagSlots) {
      criticalReasons.push("market clock exceeds the configured lag limit");
    }
  }
  if (snapshot.lpCapital < minimumLpCapital) warningReasons.push("LP capital is below the configured operating floor");
  if (snapshot.lpPnl < 0n) warningReasons.push("LP has negative released PnL");
  if (snapshot.lpCertifiedEquity !== null
    && snapshot.lpCertifiedInitialRequirement !== null
    && snapshot.lpCertifiedEquity < snapshot.lpCertifiedInitialRequirement) {
    warningReasons.push("LP certified equity is below initial requirement");
  }
  const reasons = invalidReasons.length
    ? invalidReasons
    : criticalReasons.length
      ? [...criticalReasons, ...warningReasons]
      : warningReasons;
  const level: V16MarketHealthLevel = invalidReasons.length
    ? "invalid"
    : criticalReasons.length
      ? "critical"
      : warningReasons.length
        ? "warning"
        : "healthy";
  return {
    ...snapshot,
    accountingResidual,
    criticalReasons,
    custodyDelta,
    invalidReasons,
    level,
    minimumLpCapital,
    reasons,
    warningReasons,
  };
}

export function parseUsdcAmount(
  input: string | undefined,
  fallbackUsdc: number,
  label: string,
): bigint {
  const value = input?.trim() || String(fallbackUsdc);
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) {
    fail(`${label} must be a non-negative decimal with at most 6 places`);
  }
  const [whole, fractional = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fractional + "000000").slice(0, 6));
}

export function parseUsdcFloor(input: string | undefined, fallbackUsdc = 10_000): bigint {
  return parseUsdcAmount(input, fallbackUsdc, "LP_MIN_CAPITAL_USDC");
}

function formatAtoms(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const fractional = (absolute % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${sign}$${whole.toLocaleString("en-US")}.${fractional}`;
}

export function formatV16MarketHealth(assessment: V16MarketHealthAssessment): string {
  const cert = assessment.lpCertifiedEquity === null
    ? "cert unavailable"
    : `cert equity ${formatAtoms(assessment.lpCertifiedEquity)} / maint ${formatAtoms(assessment.lpCertifiedMaintenanceRequirement ?? 0n)}`;
  const residual = assessment.accountingResidual === null
    ? "invalid"
    : formatAtoms(assessment.accountingResidual);
  const reason = assessment.reasons.length ? ` | ${assessment.reasons.join("; ")}` : "";
  const clock = `clock ${assessment.marketCurrentSlot.toString()} / observed ${assessment.observedClusterSlot.toString()} / lag ${assessment.marketClockLag.toString()}`;
  const assetSummary = assessment.assets.map((asset) => {
    const sides = asset.sides.map((side) => (
      `${side.side[0]}:oi=${side.oi},w=${side.weight},n=${side.stored},stale=${side.stale},pending=${side.pending},A=${side.a},mode=${side.mode}`
    )).join(" ");
    return `asset ${asset.asset}[stateLag=${asset.sideStateLag},oracleLag=${asset.oracleLag} ${sides}]`;
  }).join(" ");
  return [
    `LP HEALTH ${assessment.level.toUpperCase()}`,
    `capital ${formatAtoms(assessment.lpCapital)}`,
    `pnl ${formatAtoms(assessment.lpPnl)}`,
    `risk equity ${formatAtoms(assessment.lpRiskEquity)}`,
    cert,
    `custody ${formatAtoms(assessment.custodyBalance)}`,
    `accounted vault ${formatAtoms(assessment.accountedVault)}`,
    `aggregate capital ${formatAtoms(assessment.aggregateCapital)}`,
    `insurance ${formatAtoms(assessment.insurance)}`,
    `domain insurance ${formatAtoms(assessment.domainInsurance)}`,
    `other accounted pools/residual ${residual}`,
    clock,
    `locks bankruptcy=${assessment.bankruptcyHlock} lossStale=${assessment.lossStaleActive} stress=${assessment.thresholdStress} negativePnl=${assessment.negativePnlAccounts}`,
    `cert current=${assessment.lpCertCurrent}`,
    assetSummary,
  ].filter(Boolean).join(" | ") + reason;
}
