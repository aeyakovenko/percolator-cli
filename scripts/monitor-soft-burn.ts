/**
 * Monitor Soft Burn Progress
 *
 * Tracks insurance fund growth and threshold adjustment over time.
 * Run alongside random-traders.ts to see the soft burn in action.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchSlab, parseParams, parseEngine } from "../src/solana/slab.js";
import * as fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

interface Snapshot {
  time: Date;
  insurance: bigint;
  threshold: bigint;
  lpSumAbs: bigint;
  totalOI: bigint;
}

const history: Snapshot[] = [];
let startSnapshot: Snapshot | null = null;

async function getSnapshot(): Promise<Snapshot> {
  const data = await fetchSlab(conn, SLAB);
  const engine = parseEngine(data);
  const params = parseParams(data);

  return {
    time: new Date(),
    insurance: BigInt(engine.insuranceFund?.balance || 0),
    threshold: BigInt(params.riskReductionThreshold || 0),
    lpSumAbs: BigInt(engine.lpSumAbs || 0),
    totalOI: BigInt(engine.totalOpenInterest || 0),
  };
}

function formatSol(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(6);
}

function formatChange(current: bigint, start: bigint): string {
  const diff = current - start;
  const sign = diff >= 0n ? '+' : '';
  return `${sign}${formatSol(diff)}`;
}

async function printStatus() {
  const snap = await getSnapshot();
  history.push(snap);

  if (!startSnapshot) {
    startSnapshot = snap;
    console.log('============================================================');
    console.log('SOFT BURN MONITOR - Tracking insurance growth');
    console.log('============================================================');
    console.log(`Started: ${snap.time.toISOString()}`);
    console.log(`Initial insurance: ${formatSol(snap.insurance)} SOL`);
    console.log(`Initial threshold: ${formatSol(snap.threshold)} SOL`);
    console.log('============================================================\n');
    return;
  }

  const elapsed = (snap.time.getTime() - startSnapshot.time.getTime()) / 1000;
  const elapsedMin = Math.floor(elapsed / 60);
  const elapsedSec = Math.floor(elapsed % 60);

  const insuranceChange = snap.insurance - startSnapshot.insurance;
  const thresholdChange = snap.threshold - startSnapshot.threshold;

  // Calculate rate per hour
  const hoursElapsed = elapsed / 3600;
  const insurancePerHour = hoursElapsed > 0 ? Number(insuranceChange) / hoursElapsed / 1e9 : 0;

  console.log(`[${elapsedMin}m ${elapsedSec}s] ` +
    `Insurance: ${formatSol(snap.insurance)} (${formatChange(snap.insurance, startSnapshot.insurance)}) | ` +
    `Threshold: ${formatSol(snap.threshold)} (${formatChange(snap.threshold, startSnapshot.threshold)}) | ` +
    `Rate: ${insurancePerHour.toFixed(4)} SOL/hr`);
}

async function main() {
  console.log('Monitoring soft burn progress...');
  console.log('Run random-traders.ts in another terminal to generate trading activity.\n');

  // Initial snapshot
  await printStatus();

  // Monitor every 30 seconds
  setInterval(async () => {
    try {
      await printStatus();
    } catch (e) {
      console.log(`Error: ${(e as Error).message}`);
    }
  }, 30000);
}

process.on('SIGINT', () => {
  console.log('\n\n============================================================');
  console.log('FINAL SUMMARY');
  console.log('============================================================');
  if (startSnapshot && history.length > 0) {
    const final = history[history.length - 1];
    const elapsed = (final.time.getTime() - startSnapshot.time.getTime()) / 1000 / 60;
    console.log(`Duration: ${elapsed.toFixed(1)} minutes`);
    console.log(`Insurance: ${formatSol(startSnapshot.insurance)} -> ${formatSol(final.insurance)}`);
    console.log(`Change: ${formatChange(final.insurance, startSnapshot.insurance)} SOL`);
    console.log(`Threshold: ${formatSol(startSnapshot.threshold)} -> ${formatSol(final.threshold)}`);
    console.log(`Change: ${formatChange(final.threshold, startSnapshot.threshold)} SOL`);
  }
  process.exit(0);
});

main().catch(console.error);
