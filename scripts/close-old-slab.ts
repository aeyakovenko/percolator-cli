import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import { encodeCloseSlab } from "../src/abi/instructions.js";

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const wallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(os.homedir() + "/.config/solana/id.json", "utf-8")))
);
const market = JSON.parse(fs.readFileSync("devnet-market.json", "utf-8"));
const programId = new PublicKey(market.programId);
const slab = new PublicKey(market.slab);

async function main() {
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: slab, isSigner: false, isWritable: true },
    ],
    data: encodeCloseSlab(),
  });

  const tx = new Transaction().add(ix);
  const sig = await conn.sendTransaction(tx, [wallet]);
  await conn.confirmTransaction(sig, "confirmed");
  console.log("CloseSlab OK:", sig);
  const bal = await conn.getBalance(wallet.publicKey);
  console.log("Balance after close:", (bal / 1e9).toFixed(4), "SOL");
}
main().catch(console.error);
