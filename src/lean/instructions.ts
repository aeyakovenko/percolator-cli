/**
 * percolator-lean v2 instruction builders (percolator core + matcher + oracle_adapter).
 *
 * PINNED to percolator-lean `2dc4d21`. Data layouts and account orders mirror the
 * `ix_*` builders in percolator-lean/svm-runner/src/main.rs at that commit (verified
 * end-to-end on devnet by lean-devnet/runner) and the Lean handlers.
 */
import { PublicKey, TransactionInstruction, AccountMeta } from "@solana/web3.js";
import {
  IX, MATCHER_IX, ADAPTER_IX, REWARD_IX, SEED, TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID,
  SPL_TOKEN_ACCOUNT_RENT, MARKET_AUTH_ROLE, TRADE_MODE, COLLATERAL_DECIMALS,
} from "./constants.js";

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

function data(len: number, op: number): Buffer {
  const b = Buffer.alloc(len);
  b.writeUInt8(op, 0);
  return b;
}
const ix = (programId: PublicKey, keys: AccountMeta[], d: Buffer) =>
  new TransactionInstruction({ programId, keys, data: d });

// ---------------------------------------------------------------- PDAs
export function deriveDexVault(programId: PublicKey, dex: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.DEX_VAULT, dex.toBuffer()], programId);
}
export function deriveLpAuth(matcherProgram: PublicKey, matcherCfg: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.LP_AUTH, matcherCfg.toBuffer()], matcherProgram);
}
export function deriveRewAuth(rewardProgram: PublicKey, rewardCfg: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.REW_AUTH, rewardCfg.toBuffer()], rewardProgram);
}
export function deriveOracleAuth(adapterProgram: PublicKey, adapterCfg: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED.ORACLE_AUTH, adapterCfg.toBuffer()], adapterProgram);
}

// ---------------------------------------------------------------- shared token accounts
export interface VaultAccounts {
  dex: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  tokenProgram?: PublicKey;
}
const tok = (v: VaultAccounts) => v.tokenProgram ?? TOKEN_PROGRAM_ID;

// ================================================================= percolator core
/** op 0. `dex` must be a fresh DEX_SIZE account owned by the program. Admin pays vault rent top-up. */
export function initDex(p: PublicKey, a: {
  dex: PublicKey; admin: PublicKey; mint: PublicKey; feeVault: PublicKey;
  decimals: number; createFee: bigint; rentLamports?: bigint; allowFreeze?: 0 | 1; // a056eee: 1 = allow a blessed freeze-authority mint (e.g. real USDC)
  vaultBump?: number; vault?: PublicKey; tokenProgram?: PublicKey; systemProgram?: PublicKey;
}): TransactionInstruction {
  if (a.decimals !== COLLATERAL_DECIMALS)
    throw new Error(`initDex: collateral must be ${COLLATERAL_DECIMALS}-decimal (the DEX stores E6 accounting as raw token base units); got decimals=${a.decimals}`);
  const [vault, bump] = a.vault && a.vaultBump !== undefined ? [a.vault, a.vaultBump] : deriveDexVault(p, a.dex);
  const d = data(20, IX.InitDex);
  d.writeUInt8(bump, 1);
  d.writeUInt8(a.decimals, 2);
  d.writeUInt8(a.allowFreeze ?? 0, 3);
  d.writeBigUInt64LE(a.createFee, 4);
  d.writeBigUInt64LE(a.rentLamports ?? SPL_TOKEN_ACCOUNT_RENT, 12);
  return ix(p, [
    w(a.dex), w(a.admin, true), r(a.mint), w(vault), r(a.feeVault),
    r(a.tokenProgram ?? TOKEN_PROGRAM_ID), r(a.systemProgram ?? SYSTEM_PROGRAM_ID),
  ], d);
}

/** op 1. Optional `newAdmin` rotates the DEX admin. */
export function updateCreateFee(p: PublicKey, a: { dex: PublicKey; admin: PublicKey; newFee: bigint; newAdmin?: PublicKey }) {
  const d = data(9, IX.UpdateCreateFee);
  d.writeBigUInt64LE(a.newFee, 1);
  const keys = [w(a.dex), r(a.admin, true)];
  if (a.newAdmin) keys.push(r(a.newAdmin));
  return ix(p, keys, d);
}

export interface MarketParams {
  initPrice: bigint;       // E6
  exitWindow: bigint;      // slots, >= MIN_EXIT_WINDOW
  maxStaleness: bigint;    // slots
  warmupSlots: bigint;     // must be 0 for profit to realize at 2dc4d21
  imBps: bigint; mmBps: bigint; liqFeeBps: bigint; tradeFeeBps: bigint;
  maxMoveBps: bigint;      // a056eee: maxMoveBps<=2500, 4*mm+(mm^2+999)/1000+liqFee<=mmBps, mmBps+maxMove<=imBps
  maxInsDrawBps: bigint;
  maxOi: bigint;           // E6
  minMm?: bigint;          // E6 floor, default 0
  maxFrontBps?: bigint;    // a056eee: bps of I_m usable for I_m-contained cross-PnL fronting (default 0); <= maxInsDrawBps
  rewardBps?: bigint;      // ee69211: bps of trade fee routed to this market's reward module (default 0); <= 10000
  rewardRecipient?: PublicKey; // ee69211: reward-module auth PDA = deriveRewAuth(rewardProg, rewardCfg); required iff rewardBps>0
}

/** op 2. `market` must be a fresh MARKET_SIZE account owned by the program. Creator pays the DEX create fee in quote tokens. */
export function createMarket(p: PublicKey, a: {
  dex: PublicKey; market: PublicKey; mint: PublicKey; oracleAuth: PublicKey;
  creator: PublicKey; creatorToken: PublicKey; feeVault: PublicKey; params: MarketParams;
  tokenProgram?: PublicKey;
}) {
  const m = a.params;
  const useReward = (m.rewardBps ?? 0n) > 0n;
  const d = data(useReward ? 140 : 100, IX.CreateMarket); // ee69211: +rewardBps@100 +rewardRecipient@108
  d.writeUInt16LE(Number(m.maxFrontBps ?? 0n), 2); // a056eee: maxFrontBps u16 at offset 2
  [m.initPrice, m.exitWindow, m.maxStaleness, m.warmupSlots, m.imBps, m.mmBps, m.liqFeeBps,
    m.tradeFeeBps, m.maxMoveBps, m.maxInsDrawBps, m.maxOi, m.minMm ?? 0n]
    .forEach((v, i) => d.writeBigUInt64LE(v, 4 + 8 * i));
  if (useReward) {
    d.writeBigUInt64LE(m.rewardBps ?? 0n, 100);
    (m.rewardRecipient ?? PublicKey.default).toBuffer().copy(d, 108);
  }
  return ix(p, [
    w(a.dex), w(a.market), r(a.mint), r(a.oracleAuth), r(a.creator, true),
    w(a.creatorToken), w(a.feeVault), r(a.tokenProgram ?? TOKEN_PROGRAM_ID),
  ], d);
}

/** op 3 role 0 with a new key: transfer market admin. */
export function transferMarketAdmin(p: PublicKey, a: { market: PublicKey; admin: PublicKey; newAdmin: PublicKey }) {
  return ix(p, [w(a.market), r(a.admin, true), r(a.newAdmin)], Buffer.from([IX.UpdateMarketAuth, MARKET_AUTH_ROLE.ADMIN]));
}
/** op 3 role 0 without a new key: burn market admin (irreversible). */
export function burnMarketAdmin(p: PublicKey, a: { market: PublicKey; admin: PublicKey }) {
  return ix(p, [w(a.market), r(a.admin, true)], Buffer.from([IX.UpdateMarketAuth, MARKET_AUTH_ROLE.ADMIN]));
}
/** op 3 role 1: rotate oracle authority. */
export function rotateOracleAuth(p: PublicKey, a: { market: PublicKey; admin: PublicKey; newOracle: PublicKey }) {
  return ix(p, [w(a.market), r(a.admin, true), r(a.newOracle)], Buffer.from([IX.UpdateMarketAuth, MARKET_AUTH_ROLE.ORACLE]));
}

/** op 4. |newPrice - mark| + fundingE6 must be <= mark * maxMoveBps; one update per slot. fundingSign 0 = longs pay. */
export function updateOracle(p: PublicKey, a: { market: PublicKey; oracleAuth: PublicKey; price: bigint; fundingSign?: 0 | 1; fundingE6?: bigint }) {
  const d = data(18, IX.UpdateOracle);
  d.writeBigUInt64LE(a.price, 1);
  d.writeUInt8(a.fundingSign ?? 0, 9);
  d.writeBigUInt64LE(a.fundingE6 ?? 0n, 10);
  return ix(p, [w(a.market), r(a.oracleAuth, true)], d);
}

/** op 5. `portfolio` must be a fresh PORTFOLIO_SIZE account owned by the program. */
export function initPortfolio(p: PublicKey, a: { dex: PublicKey; portfolio: PublicKey; owner: PublicKey }) {
  return ix(p, [w(a.dex), w(a.portfolio), r(a.owner, true)], Buffer.from([IX.InitPortfolio]));
}

/** op 6. Anyone (`depositor`) may fund any portfolio. */
export function depositCollateral(p: PublicKey, v: VaultAccounts, a: { portfolio: PublicKey; depositor: PublicKey; sourceToken: PublicKey; amount: bigint }) {
  const d = data(9, IX.DepositCollateral);
  d.writeBigUInt64LE(a.amount, 1);
  return ix(p, [w(v.dex), w(a.portfolio), r(a.depositor, true), w(a.sourceToken), r(v.mint), w(v.vault), r(tok(v))], d);
}

/** op 7. Requires every open leg refreshed in the same slot — wrap with `withLegRefresh`. */
export function withdrawCollateral(p: PublicKey, v: VaultAccounts, a: { portfolio: PublicKey; owner: PublicKey; destToken: PublicKey; amount: bigint }) {
  const d = data(9, IX.WithdrawCollateral);
  d.writeBigUInt64LE(a.amount, 1);
  return ix(p, [w(v.dex), w(a.portfolio), r(a.owner, true), w(a.destToken), r(v.mint), w(v.vault), r(tok(v))], d);
}

/** op 8. `receipt` is a fresh INS_RECEIPT_SIZE account (or existing receipt of `lp`). donate=true mints no shares. */
export function depositInsurance(p: PublicKey, v: VaultAccounts, a: { market: PublicKey; receipt: PublicKey; lp: PublicKey; sourceToken: PublicKey; amount: bigint; donate?: boolean }) {
  const d = data(10, IX.DepositInsurance);
  d.writeBigUInt64LE(a.amount, 1);
  d.writeUInt8(a.donate ? 1 : 0, 9);
  return ix(p, [w(v.dex), w(a.market), w(a.receipt), r(a.lp, true), w(a.sourceToken), r(v.mint), w(v.vault), r(tok(v))], d);
}

/** op 9. Only when the market has zero OI. */
export function withdrawInsurance(p: PublicKey, v: VaultAccounts, a: { market: PublicKey; receipt: PublicKey; lp: PublicKey; destToken: PublicKey; burnShares: bigint }) {
  const d = data(9, IX.WithdrawInsurance);
  d.writeBigUInt64LE(a.burnShares, 1);
  return ix(p, [w(v.dex), w(a.market), w(a.receipt), r(a.lp, true), w(a.destToken), r(v.mint), w(v.vault), r(tok(v))], d);
}

/** op 10. Permissionless. forceHaircut realizes posPnl pro-rata even when R_m < P+_m. */
export function refreshLeg(p: PublicKey, a: { dex: PublicKey; market: PublicKey; portfolio: PublicKey; forceHaircut?: boolean }) {
  return ix(p, [w(a.dex), w(a.market), w(a.portfolio)], Buffer.from([IX.RefreshLeg, a.forceHaircut ? 1 : 0]));
}

/**
 * op 11. Bilateral: both owners sign. mode OPEN = both increase (L long, S short);
 * CLOSE = both reduce. execPrice 0 = at mark; otherwise within maxMoveBps of mark.
 * OPEN requires every open leg of both portfolios refreshed this slot — wrap with `withLegRefresh`.
 */
export function trade(p: PublicKey, a: {
  dex: PublicKey; market: PublicKey; longPortfolio: PublicKey; longOwner: PublicKey;
  shortPortfolio: PublicKey; shortOwner: PublicKey; mode: number; qty: bigint; execPrice?: bigint;
}) {
  const d = data(18, IX.Trade);
  d.writeUInt8(a.mode, 1);
  d.writeBigUInt64LE(a.qty, 2);
  d.writeBigUInt64LE(a.execPrice ?? 0n, 10);
  return ix(p, [w(a.dex), w(a.market), w(a.longPortfolio), r(a.longOwner, true), w(a.shortPortfolio), r(a.shortOwner, true)], d);
}
export const tradeOpen = (p: PublicKey, a: Omit<Parameters<typeof trade>[1], "mode">) => trade(p, { ...a, mode: TRADE_MODE.OPEN });
export const tradeClose = (p: PublicKey, a: Omit<Parameters<typeof trade>[1], "mode">) => trade(p, { ...a, mode: TRADE_MODE.CLOSE });

/** op 12. Permissionless; fee goes to `liquidatorToken`. */
export function liquidate(p: PublicKey, v: VaultAccounts, a: { market: PublicKey; portfolio: PublicKey; liquidatorToken: PublicKey }) {
  return ix(p, [w(v.dex), w(a.market), w(a.portfolio), w(a.liquidatorToken), r(v.mint), w(v.vault), r(tok(v))], Buffer.from([IX.Liquidate]));
}

/** op 13. Permissionless; only when that side's OI is 0. */
export function clearDeadLeg(p: PublicKey, a: { dex: PublicKey; market: PublicKey; portfolio: PublicKey }) {
  return ix(p, [w(a.dex), w(a.market), w(a.portfolio)], Buffer.from([IX.ClearDeadLeg]));
}

/** op 14. Market admin anytime; anyone once oracle age > maxStaleness. */
export function startWindDown(p: PublicKey, a: { market: PublicKey; caller: PublicKey }) {
  return ix(p, [w(a.market), r(a.caller, true)], Buffer.from([IX.StartWindDown]));
}

/** op 15. Permissionless after windDownSlot + exitWindow. */
export function forceClosePair(p: PublicKey, a: { dex: PublicKey; market: PublicKey; longPortfolio: PublicKey; shortPortfolio: PublicKey }) {
  return ix(p, [w(a.dex), w(a.market), w(a.longPortfolio), w(a.shortPortfolio)], Buffer.from([IX.ForceClosePair]));
}

/** op 16 (35cd13c: + dex for resolved-dust sweep). Permissionless once OI, raw basis and active legs are all 0. */
export function resolveMarket(p: PublicKey, a: { dex: PublicKey; market: PublicKey }) {
  return ix(p, [w(a.dex), w(a.market)], Buffer.from([IX.ResolveMarket]));
}

/** op 17. Permissionless; pays a flat leg's posPnl at the resolved ratio. */
export function claimResolved(p: PublicKey, a: { dex: PublicKey; market: PublicKey; portfolio: PublicKey }) {
  return ix(p, [w(a.dex), w(a.market), w(a.portfolio)], Buffer.from([IX.ClaimResolved]));
}

/** op 18. Permissionless once resolved and fully drained. */
export function tombstoneMarket(p: PublicKey, a: { market: PublicKey }) {
  return ix(p, [w(a.market)], Buffer.from([IX.TombstoneMarket]));
}

/** op 19. Empty Portfolio (owner), empty InsReceipt (owner), or Tombstoned Market (admin, or anyone if burned). */
export function closeAccount(p: PublicKey, a: { account: PublicKey; authority: PublicKey; destination: PublicKey }) {
  return ix(p, [w(a.account), r(a.authority, true), w(a.destination)], Buffer.from([IX.CloseAccount]));
}

// ================================================================= matcher
/** matcher op 0. `cfg` = fresh MATCHER_CFG_SIZE account owned by the matcher; `lpPortfolio` = fresh PORTFOLIO_SIZE account owned by percolator. */
export function matcherInit(m: PublicKey, a: {
  cfg: PublicKey; owner: PublicKey; dex: PublicKey; lpPortfolio: PublicKey; percolator: PublicKey;
  market: PublicKey; // e1e4404: MatcherConfig pins the Market it may fill against
  halfSpreadBps: bigint; impactBps: bigint; maxFillQty: bigint;
}) {
  const [lpAuth, bump] = deriveLpAuth(m, a.cfg);
  const d = data(28, MATCHER_IX.Init);
  d.writeUInt8(bump, 1);
  d.writeBigUInt64LE(a.halfSpreadBps, 4);
  d.writeBigUInt64LE(a.impactBps, 12);
  d.writeBigUInt64LE(a.maxFillQty, 20);
  return ix(m, [w(a.cfg), r(a.owner, true), w(a.dex), w(a.lpPortfolio), r(lpAuth), r(a.percolator), r(a.market)], d);
}

/** matcher op 1. */
export function matcherUpdate(m: PublicKey, a: { cfg: PublicKey; owner: PublicKey; paused: boolean; halfSpreadBps: bigint; impactBps: bigint; maxFillQty: bigint }) {
  const d = data(28, MATCHER_IX.Update);
  d.writeUInt8(a.paused ? 1 : 0, 1);
  d.writeBigUInt64LE(a.halfSpreadBps, 4);
  d.writeBigUInt64LE(a.impactBps, 12);
  d.writeBigUInt64LE(a.maxFillQty, 20);
  return ix(m, [w(a.cfg), r(a.owner, true)], d);
}

/** matcher op 2. Single-signer taker fill against the LP portfolio. mode OPEN/CLOSE; limitPrice is the worst acceptable price. */
export function matcherFill(m: PublicKey, a: {
  cfg: PublicKey; dex: PublicKey; market: PublicKey; lpPortfolio: PublicKey;
  takerPortfolio: PublicKey; taker: PublicKey; percolator: PublicKey;
  mode: number; takerIsLong: boolean; qty: bigint; limitPrice: bigint;
}) {
  const [lpAuth] = deriveLpAuth(m, a.cfg);
  const d = data(19, MATCHER_IX.Fill);
  d.writeUInt8(a.mode, 1);
  d.writeUInt8(a.takerIsLong ? 1 : 0, 2);
  d.writeBigUInt64LE(a.qty, 3);
  d.writeBigUInt64LE(a.limitPrice, 11);
  return ix(m, [
    r(a.cfg), w(a.dex), w(a.market), w(a.lpPortfolio), r(lpAuth), w(a.takerPortfolio), r(a.taker, true), r(a.percolator),
  ], d);
}

/** matcher op 3. LP owner withdraws from the PDA-owned LP portfolio. */
export function matcherWithdrawLp(m: PublicKey, v: VaultAccounts, a: { cfg: PublicKey; owner: PublicKey; lpPortfolio: PublicKey; destToken: PublicKey; percolator: PublicKey; amount: bigint }) {
  const [lpAuth] = deriveLpAuth(m, a.cfg);
  const d = data(9, MATCHER_IX.WithdrawLp);
  d.writeBigUInt64LE(a.amount, 1);
  return ix(m, [
    r(a.cfg), r(a.owner, true), w(v.dex), w(a.lpPortfolio), r(lpAuth), w(a.destToken), r(v.mint), w(v.vault), r(tok(v)), r(a.percolator),
  ], d);
}

// ================================================================= oracle adapter
/**
 * adapter op 0 (f2b8b11). `cfg` = fresh ADAPTER_CFG_SIZE account owned by the adapter.
 * Create the market with oracleAuth = deriveOracleAuth(adapter, cfg). `feedType`:
 * 0=Custom FEED, 1=Pyth PriceUpdateV2, 2=Chainlink OCR2, 3=Switchboard. For a 2-leg
 * composite (base/quote, e.g. STOXX/SOL) pass `quoteFeed`/`quoteFeedType`. Optional
 * 32-byte `feedId`/`quoteFeedId` pin Pyth feed ids. maxFeedAge is seconds for Pyth,
 * slots otherwise. The feed account owner(s) are pinned at init.
 */
export function adapterInit(o: PublicKey, a: {
  cfg: PublicKey; admin: PublicKey; percolator: PublicKey; market: PublicKey; feed: PublicKey;
  feedType: number; maxFeedAge: bigint; maxConfBps: bigint; fundingBpsPerStep: bigint;
  feedId?: Buffer; quoteFeed?: PublicKey; quoteFeedType?: number; quoteFeedId?: Buffer;
}) {
  const [, bump] = deriveOracleAuth(o, a.cfg);
  // size: 28 base; +32 if feedId (pins base); +32 more if quoteFeedId
  let len = 28;
  if (a.feedId) len = 60;
  if (a.quoteFeedId) len = 92;
  const d = data(len, ADAPTER_IX.Init);
  d.writeUInt8(bump, 1);
  d.writeUInt8(a.feedType, 2);
  d.writeUInt8(a.quoteFeedType ?? 0, 3);
  d.writeBigUInt64LE(a.maxFeedAge, 4);
  d.writeBigUInt64LE(a.maxConfBps, 12);
  d.writeBigUInt64LE(a.fundingBpsPerStep, 20);
  if (a.feedId) { if (a.feedId.length !== 32) throw new Error("feedId must be 32 bytes"); a.feedId.copy(d, 28); }
  if (a.quoteFeedId) { if (a.quoteFeedId.length !== 32) throw new Error("quoteFeedId must be 32 bytes"); a.quoteFeedId.copy(d, 60); }
  const keys = [w(a.cfg), r(a.admin, true), r(a.percolator), r(a.market), r(a.feed)];
  if (a.quoteFeed) keys.push(r(a.quoteFeed)); // n>=6 → FLAG_HAS_QUOTE
  return ix(o, keys, d);
}

/** adapter op 1 (f2b8b11). Permissionless crank: feed(s) → clamped UpdateOracle CPI. Pass `quoteFeed` for a composite adapter. */
export function adapterCrank(o: PublicKey, a: { cfg: PublicKey; market: PublicKey; feed: PublicKey; percolator: PublicKey; quoteFeed?: PublicKey }) {
  const [oracAuth] = deriveOracleAuth(o, a.cfg);
  // cfg is writable: with EWMA enabled the crank updates ewmaPrice/lastEwmaSlot on it.
  const keys = [w(a.cfg), w(a.market), r(a.feed), r(oracAuth), r(a.percolator)];
  if (a.quoteFeed) keys.push(r(a.quoteFeed));
  return ix(o, keys, Buffer.from([ADAPTER_IX.Crank]));
}

/** adapter op 2 (f3b9fb9). One-shot immutable EWMA / Hybrid After-Hours config. alphaBps 1..10000 (0=pass-through, needs hybrid); initEwma 0 seeds on first crank. */
export function adapterInitEwma(o: PublicKey, a: { cfg: PublicKey; admin: PublicKey; hybridAfterHours: boolean; alphaBps: bigint; maxDevBps: bigint; initEwma: bigint }) {
  if (a.alphaBps < 0n || a.alphaBps > 10000n)
    throw new RangeError(`adapterInitEwma: alphaBps must be in 0..10000, got ${a.alphaBps}`);
  if (a.alphaBps === 0n && !a.hybridAfterHours)
    throw new Error("adapterInitEwma: alphaBps=0 (pass-through) only makes sense with hybridAfterHours=true");
  const d = data(26, ADAPTER_IX.InitEwma);
  d.writeUInt8(a.hybridAfterHours ? 1 : 0, 1);
  d.writeBigUInt64LE(a.alphaBps, 2);
  d.writeBigUInt64LE(a.maxDevBps, 10);
  d.writeBigUInt64LE(a.initEwma, 18);
  return ix(o, [w(a.cfg), r(a.admin, true)], d);
}

/** adapter op 3 (f3b9fb9). Admin nudges the carried EWMA base mark (after-hours), clamped ±ewmaMaxDevBps/slot. */
export function adapterPushEwmaMark(o: PublicKey, a: { cfg: PublicKey; admin: PublicKey; markE6: bigint }) {
  const d = data(9, ADAPTER_IX.PushEwmaMark);
  d.writeBigUInt64LE(a.markE6, 1);
  return ix(o, [w(a.cfg), r(a.admin, true)], d);
}

// ================================================================= reward module (161ed3c)
/** reward op 0 (InitReward). One-shot bind of a RewardCfg to a market's buy-and-burn.
 *  cfg = fresh REWARD_CFG_SIZE account owned by the reward program; quoteVault/targetEscrow(/burnSink
 *  for burnMode=1) = SPL token accounts owned by the rewm PDA, amount 0. mktAdmin signs (== mkt.marketAdmin). */
export function rewardInit(rm: PublicKey, a: {
  cfg: PublicKey; mktAdmin: PublicKey; percolator: PublicKey; dex: PublicKey; market: PublicKey;
  quoteMint: PublicKey; quoteVault: PublicKey; targetMint: PublicKey; targetEscrow: PublicKey;
  burnSink?: PublicKey; burnMode: 0 | 1; epochSlots: bigint; minBatchQuote: bigint; reserveRateE6: bigint;
  quoteTokProg?: PublicKey; targetTokProg?: PublicKey;
}): TransactionInstruction {
  const [rewAuth, bump] = deriveRewAuth(rm, a.cfg);
  const d = data(28, REWARD_IX.InitReward);
  d.writeUInt8(bump, 1); // InitReward reads the rewm-PDA bump from data byte 1
  d.writeUInt8(a.burnMode, 2);
  d.writeBigUInt64LE(a.epochSlots, 4);
  d.writeBigUInt64LE(a.minBatchQuote, 12);
  d.writeBigUInt64LE(a.reserveRateE6, 20);
  const keys: AccountMeta[] = [
    w(a.cfg), r(a.mktAdmin, true), r(a.percolator), r(a.dex), r(a.market), r(rewAuth),
    r(a.quoteMint), w(a.quoteVault), r(a.quoteTokProg ?? TOKEN_PROGRAM_ID),
    r(a.targetMint), w(a.targetEscrow), r(a.targetTokProg ?? TOKEN_PROGRAM_ID),
  ];
  if (a.burnMode === 1) keys.push(w(a.burnSink ?? a.targetEscrow));
  return ix(rm, keys, d);
}

/** reward op 1 (StartEpoch, permissionless): CPI-pulls market.rewardAccrued into a fresh epoch's quotePot. */
export function rewardStartEpoch(rm: PublicKey, a: {
  cfg: PublicKey; epochAcc: PublicKey; dex: PublicKey; market: PublicKey; quoteMint: PublicKey;
  dexVault: PublicKey; quoteVault: PublicKey; percolator: PublicKey; quoteTokProg?: PublicKey;
}): TransactionInstruction {
  const [rewAuth] = deriveRewAuth(rm, a.cfg);
  return ix(rm, [
    w(a.cfg), w(a.epochAcc), w(a.dex), w(a.market), r(rewAuth), r(a.quoteMint),
    w(a.dexVault), w(a.quoteVault), r(a.quoteTokProg ?? TOKEN_PROGRAM_ID), r(a.percolator),
  ], Buffer.from([REWARD_IX.StartEpoch]));
}
/** reward op 2 (SubmitBid, permissionless): bidder escrows `amount` target tokens (wSOL) into the epoch. */
export function rewardSubmitBid(rm: PublicKey, a: {
  cfg: PublicKey; epochAcc: PublicKey; bidReceipt: PublicKey; bidder: PublicKey; bidderTargetTok: PublicKey;
  targetEscrow: PublicKey; targetMint: PublicKey; amount: bigint; targetTokProg?: PublicKey;
}): TransactionInstruction {
  const d = data(9, REWARD_IX.SubmitBid);
  d.writeBigUInt64LE(a.amount, 1);
  return ix(rm, [
    w(a.cfg), w(a.epochAcc), w(a.bidReceipt), r(a.bidder, true), w(a.bidderTargetTok),
    w(a.targetEscrow), r(a.targetMint), r(a.targetTokProg ?? TOKEN_PROGRAM_ID),
  ], d);
}
/** reward op 3 (SettleEpoch, permissionless): clears xy=k, burns escrowed target (burnMode=1 -> dead-sink). */
export function rewardSettleEpoch(rm: PublicKey, a: {
  cfg: PublicKey; epochAcc: PublicKey; targetEscrow: PublicKey; targetMint: PublicKey;
  burnSink?: PublicKey; burnMode: 0 | 1; targetTokProg?: PublicKey;
}): TransactionInstruction {
  const [rewAuth] = deriveRewAuth(rm, a.cfg);
  const keys: AccountMeta[] = [
    w(a.cfg), w(a.epochAcc), r(rewAuth), w(a.targetEscrow), r(a.targetMint), r(a.targetTokProg ?? TOKEN_PROGRAM_ID),
  ];
  if (a.burnMode === 1) keys.push(w(a.burnSink ?? a.targetEscrow));
  return ix(rm, keys, Buffer.from([REWARD_IX.SettleEpoch]));
}
/** reward op 4 (ClaimQuote): bidder claims their pro-rata quote (USDC) payout from a settled epoch. */
export function rewardClaimQuote(rm: PublicKey, a: {
  cfg: PublicKey; epochAcc: PublicKey; bidReceipt: PublicKey; bidder: PublicKey; quoteVault: PublicKey;
  bidderQuoteTok: PublicKey; quoteMint: PublicKey; quoteTokProg?: PublicKey;
}): TransactionInstruction {
  const [rewAuth] = deriveRewAuth(rm, a.cfg);
  return ix(rm, [
    w(a.cfg), w(a.epochAcc), w(a.bidReceipt), w(a.bidder, true), r(rewAuth),
    w(a.quoteVault), w(a.bidderQuoteTok), r(a.quoteMint), r(a.quoteTokProg ?? TOKEN_PROGRAM_ID),
  ], Buffer.from([REWARD_IX.ClaimQuote]));
}
