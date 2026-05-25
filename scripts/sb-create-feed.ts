/**
 * Create a Switchboard On-Demand feed on devnet with a custom job definition.
 *
 * Run once. Save the printed pubkey — that's the feed account the bounty-5
 * smoke will reference in `ConfigureHybridOracle` leg slots.
 *
 * Job: a simple HTTP+JSON task that fetches an external numeric value.
 * Default: CoinGecko SOL/USD spot price (a stand-in for any "complex price").
 * For bounty-5 prediction markets, swap the URL/JSON path to point at the
 * real prediction-market oracle (e.g., Polymarket /markets/<id>).
 */
import { Connection, Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor-31";
import * as sb from "@switchboard-xyz/on-demand";
import { OracleJob } from "@switchboard-xyz/common";
import * as fs from "fs";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH = process.env.SB_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))));
  const wallet = new Wallet(kp);
  const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });
  console.log("payer:", kp.publicKey.toBase58());

  // Load the On-Demand program (auto-detects devnet from connection).
  const program = await sb.AnchorUtils.loadProgramFromConnection(conn, wallet);
  console.log("sb program:", program.programId.toBase58());

  // Devnet default queue.
  const queue = await sb.Queue.loadDefault(program);
  console.log("queue:", queue.pubkey.toBase58());

  // Job: GET https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd
  //      parse $.solana.usd as a float
  const job = OracleJob.fromObject({
    tasks: [
      { httpTask: { url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd" } },
      { jsonParseTask: { path: "$.solana.usd" } },
    ],
  });
  const jobs = [job];

  // Build the init ix ourselves (PullFeed.initTx has a payer-forwarding bug).
  const [feed, feedKp] = sb.PullFeed.generate(program);
  const initIx = await feed.initIx({
    name: "bounty5-sol-spot",
    queue: queue.pubkey,
    maxVariance: 1.0,
    minResponses: 1,
    minSampleSize: 1,
    maxStaleness: 100,
    payer: kp.publicKey,
    jobs,
  });
  console.log("feed (planned pubkey):", feed.pubkey.toBase58());

  const blockhash = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      initIx,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp, feedKp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, ...blockhash }, "confirmed");
  console.log("init sig:", sig);

  console.log("\n=== feed created ===");
  console.log("pubkey:", feed.pubkey.toBase58());
  console.log("Use this as a leg feed in encConfigureHybridOracle.");
  console.log("Run scripts/sb-push-feed.ts <pubkey> to push fresh data.");
}

main().catch(e => { console.error("FATAL:", e); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
