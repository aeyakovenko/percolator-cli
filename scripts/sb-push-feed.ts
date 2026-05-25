/**
 * Push a fresh oracle update to a Switchboard On-Demand feed account.
 *
 * Usage:
 *   SOLANA_RPC_URL=... npx tsx scripts/sb-push-feed.ts <feed_pubkey> [--loop]
 *
 * One-shot mode (default): pushes once and exits. Use as a "fresh-up" step
 * right before `ConfigureHybridOracle` in the smoke.
 *
 * --loop mode: pushes every 20s. Use as a subprocess during longer runs.
 */
import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor-31";
import * as sb from "@switchboard-xyz/on-demand";
import { CrossbarNetwork } from "@switchboard-xyz/common";
import * as fs from "fs";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH = process.env.SB_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;

const FEED = new PublicKey(process.argv[2] ?? (() => { throw new Error("usage: sb-push-feed.ts <feed_pubkey> [--loop]"); })());
const LOOP = process.argv.includes("--loop");

async function pushOnce(conn: Connection, kp: Keypair, feed: sb.PullFeed): Promise<string> {
  const [updateIx, _responses, _ok, luts] = await feed.fetchUpdateIx({ numSignatures: 3 });
  if (!updateIx) throw new Error("fetchUpdateIx returned no instruction");

  const blockhash = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      updateIx,
    ],
  }).compileToV0Message(luts ?? []);
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, ...blockhash }, "confirmed");
  return sig;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"))));
  const wallet = new Wallet(kp);
  const program = await sb.AnchorUtils.loadProgramFromConnection(conn, wallet);
  const feed = new sb.PullFeed(program, FEED);
  feed.setNetwork(CrossbarNetwork.SolanaDevnet);
  console.log("payer:", kp.publicKey.toBase58());
  console.log("feed: ", FEED.toBase58());

  while (true) {
    try {
      const sig = await pushOnce(conn, kp, feed);
      // Read back the result.
      const data = await feed.loadData();
      const value = data?.result?.value?.toString() ?? "?";
      const updTs = data?.result?.slot?.toString() ?? "?";
      console.log(`[push] sig=${sig.slice(0,12)}…  value=${value}  slot=${updTs}`);
    } catch (e: any) {
      console.log("[push] error:", e?.message ?? e);
    }
    if (!LOOP) break;
    await new Promise(r => setTimeout(r, 20_000));
  }
}
main().catch(e => { console.error("FATAL:", e); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
