import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import * as fs from "fs";
import { encWithdrawBackingBucket } from "../src/v16/instructions.js";

const PROG = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`,"utf8"))));
const market = new PublicKey(process.argv[2] ?? "9msm89WLgeRBBU3VRN7ngPoZFbx8NXNNM7weoPHNjo9f");
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROG);
const sourceAta = getAssociatedTokenAddressSync(NATIVE_MINT, admin.publicKey);
const vaultAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultAuth, true);

async function main() {
  console.log("market:", market.toBase58());
  for (const dom of [0, 1, 2, 3, 4, 5, 6, 7]) {
    try {
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        .add(ComputeBudgetProgram.requestHeapFrame({ bytes: 256*1024 }))
        .add(new TransactionInstruction({ programId: PROG, keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: false },
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: sourceAta, isSigner: false, isWritable: true },
          { pubkey: vaultAta, isSigner: false, isWritable: true },
          { pubkey: vaultAuth, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ], data: encWithdrawBackingBucket({ domain: dom, amount: 20_000_000n }) }));
      const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed", skipPreflight: true });
      console.log(`domain=${dom} ✅ ${sig.slice(0,16)}…`);
      return;
    } catch (e: any) {
      const m = (e.message||"").match(/custom program error: (0x[0-9a-f]+)/);
      console.log(`domain=${dom} ❌ ${m ? m[1] : (e.message||"").slice(0,120)}`);
    }
  }
}
main();
