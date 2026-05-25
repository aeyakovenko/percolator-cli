/**
 * Push a Pyth price update onto devnet (or any RPC). Uses Hermes for the price
 * data — works regardless of which chain you're pushing to.
 *
 * Usage:
 *   SOLANA_RPC_URL=... npx tsx scripts/pyth-push-devnet.ts <feed_id_hex> [shard]
 *
 * Common feed_ids (Pyth):
 *   SOL/USD : ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
 *   BTC/USD : e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43
 *   ETH/USD : ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
 */
import { Connection, Keypair } from "@solana/web3.js";
// @ts-expect-error CJS interop
import pkgAnchor from "@coral-xyz/anchor";
// @ts-expect-error CJS interop
import pkgPyth from "@pythnetwork/pyth-solana-receiver";
import { HermesClient } from "@pythnetwork/hermes-client";
import * as fs from "fs";
const { Wallet } = pkgAnchor;
const { PythSolanaReceiver } = pkgPyth;

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH = process.env.SB_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
const FEED_ID = process.argv[2] ?? "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const SHARD_ID = parseInt(process.argv[3] ?? "0", 10);

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))));
  const wallet = new Wallet(kp);
  const receiver = new PythSolanaReceiver({ connection, wallet });
  const hermes = new HermesClient("https://hermes.pyth.network");

  const upd = await hermes.getLatestPriceUpdates(["0x" + FEED_ID], { encoding: "base64" });
  const px = upd.parsed?.[0]?.price;
  console.log(`pyth feed_id: ${FEED_ID.slice(0, 16)}...`);
  console.log(`hermes price: ${px?.price} expo=${px?.expo} publish_time=${px?.publish_time}`);

  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addUpdatePriceFeed(upd.binary.data, SHARD_ID);
  const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 });
  const sigs = await receiver.provider.sendAll(txs, { skipPreflight: true });
  console.log(`pushed ${sigs.length} tx(s):`, sigs);

  // Derive the feed account pubkey for the wrapper.
  // PythSolanaReceiver exposes `getPriceFeedAccountAddress(shard, feed_id)`.
  const addr = receiver.getPriceFeedAccountAddress(SHARD_ID, "0x" + FEED_ID);
  console.log(`\nfeed account on devnet: ${addr.toBase58()}`);
  console.log(`(use this as oracleLegFeeds[i] in encConfigureHybridOracle)`);
}
main().catch(e => { console.error("FATAL:", e.message ?? e); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
