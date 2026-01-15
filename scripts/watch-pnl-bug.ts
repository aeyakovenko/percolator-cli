/**
 * Targeted monitoring for PnL overflow bug
 * Watches for suspicious values that suggest integer overflow
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { fetchSlab, parseEngine, parseParams, parseUsedIndices, parseAccount, AccountKind } from '../src/solana/slab.js';

const SLAB = new PublicKey('Auh2xxbcg6zezP1CvLqZykGaTqwbjXfTaMHmMwGDYK89');
const ORACLE = new PublicKey('99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR');
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

// Overflow detection thresholds
const SUSPICIOUS_PNL_THRESHOLD = 1_000_000_000_000n; // 1000 SOL is already suspicious
const MAX_REASONABLE_PNL = 100_000_000_000n; // 100 SOL max reasonable PnL

async function getChainlinkPrice(oracle: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(oracle);
  if (!info) throw new Error("Oracle not found");
  const decimals = info.data.readUInt8(138);
  const answer = info.data.readBigInt64LE(216);
  const rawE6 = answer * 1_000_000n / BigInt(10 ** decimals);
  return 1_000_000_000_000n / rawE6; // inverted
}

let prevLiquidations = 0n;
let checkCount = 0;

async function check() {
  checkCount++;
  const data = await fetchSlab(connection, SLAB);
  const engine = parseEngine(data);
  const indices = parseUsedIndices(data);
  const oraclePrice = await getChainlinkPrice(ORACLE);

  const now = new Date().toLocaleTimeString();

  // Check for liquidation counter change
  if (prevLiquidations > 0n && engine.lifetimeLiquidations > prevLiquidations) {
    console.log(`\n[${now}] 🔴 LIQUIDATION DETECTED! Count: ${prevLiquidations} -> ${engine.lifetimeLiquidations}`);
  }

  let foundBug = false;
  let totalPnl = 0n;

  for (const idx of indices) {
    const acc = parseAccount(data, idx);
    if (!acc) continue;

    // Check for suspicious PnL values
    const absPnl = acc.pnl < 0n ? -acc.pnl : acc.pnl;
    totalPnl += acc.pnl;

    if (absPnl > SUSPICIOUS_PNL_THRESHOLD) {
      foundBug = true;
      const label = acc.kind === AccountKind.LP ? 'LP' : `Trader ${idx}`;
      console.log(`\n[${now}] ⚠️  SUSPICIOUS PNL DETECTED!`);
      console.log(`  Account: ${label} (index ${idx})`);
      console.log(`  Raw PnL (bigint): ${acc.pnl.toString()}`);
      console.log(`  PnL as SOL: ${Number(acc.pnl) / 1e9}`);
      console.log(`  Is close to 2^64: ${Math.abs(Number(acc.pnl) - Math.pow(2, 64)) < 1e15}`);

      // Log the hex representation
      console.log(`  PnL hex: 0x${(acc.pnl >= 0n ? acc.pnl : (1n << 128n) + acc.pnl).toString(16)}`);
    }

    // Also check capital for sanity
    if (acc.capital > 100_000_000_000_000n) { // > 100,000 SOL is suspicious
      console.log(`\n[${now}] ⚠️  SUSPICIOUS CAPITAL: Account ${idx} has ${Number(acc.capital) / 1e9} SOL capital`);
    }
  }

  // Log every 5 checks or on any anomaly
  if (checkCount % 5 === 1 || foundBug) {
    const totalPnlSol = Number(totalPnl) / 1e9;
    const pnlStatus = Math.abs(totalPnlSol) > 1000 ? '⚠️ SUSPICIOUS' : '✓';
    console.log(`[${now}] Check #${checkCount} | Liquidations: ${engine.lifetimeLiquidations} | Total PnL: ${totalPnlSol.toFixed(6)} SOL ${pnlStatus}`);
  }

  prevLiquidations = engine.lifetimeLiquidations;
}

async function main() {
  console.log('=== PnL Overflow Bug Monitor ===');
  console.log('Watching for suspicious PnL values (> 1000 SOL)');
  console.log('Press Ctrl+C to stop\n');

  // Initial state
  const data = await fetchSlab(connection, SLAB);
  const engine = parseEngine(data);
  prevLiquidations = engine.lifetimeLiquidations;
  console.log(`Starting liquidation count: ${prevLiquidations}\n`);

  // Run check loop
  while (true) {
    try {
      await check();
    } catch (err: any) {
      console.error(`[ERROR] ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 15000)); // Check every 15 seconds
  }
}

main().catch(console.error);
