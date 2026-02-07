/**
 * Credibility Update Bot
 *
 * Periodically updates the credibility matcher's view of the market state.
 * This is permissionless — anyone can run this bot.
 *
 * The bot sends the UpdateCredibility instruction (tag 0x03) to the matcher
 * program, which reads the slab's insurance fund balance, total OI, and
 * admin status, then stores snapshots in the matcher context.
 *
 * Usage:
 *   npx tsx scripts/credibility-update-bot.ts [interval_seconds]
 *
 * Default interval: 30 seconds
 */
import "dotenv/config";
import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import * as fs from "fs";

const marketInfo = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const SLAB = new PublicKey(marketInfo.slab);

const credLp = marketInfo.credibilityLp;
if (!credLp) {
  console.error("ERROR: No credibilityLp in devnet-market.json. Run deploy-credibility-matcher.ts first.");
  process.exit(1);
}

const MATCHER_PROGRAM_ID = new PublicKey(credLp.matcherProgram);
const MATCHER_CTX = new PublicKey(credLp.matcherContext);

const INTERVAL_SECS = parseInt(process.argv[2] || "30", 10);

const conn = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  "confirmed"
);
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf-8")
    )
  )
);

function encodeUpdateCredibility(): Buffer {
  return Buffer.from([0x03]); // Tag only
}

async function updateOnce(): Promise<void> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    {
      programId: MATCHER_PROGRAM_ID,
      keys: [
        { pubkey: MATCHER_CTX, isSigner: false, isWritable: true },
        { pubkey: SLAB, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: encodeUpdateCredibility(),
    }
  );

  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed",
  });
  const now = new Date().toISOString();
  console.log(`[${now}] Updated credibility snapshots — tx: ${sig}`);
}

async function main() {
  console.log("Credibility Update Bot");
  console.log("  Slab:    ", SLAB.toBase58());
  console.log("  Matcher: ", MATCHER_PROGRAM_ID.toBase58());
  console.log("  Context: ", MATCHER_CTX.toBase58());
  console.log("  Interval:", INTERVAL_SECS, "seconds");
  console.log("");

  // Run once immediately
  await updateOnce();

  // Then loop
  setInterval(async () => {
    try {
      await updateOnce();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Update failed:`, err);
    }
  }, INTERVAL_SECS * 1000);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
