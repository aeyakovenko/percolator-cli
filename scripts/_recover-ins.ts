import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import { withdrawInsurance, type VaultAccounts } from "../src/lean/index.js";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const P = new PublicKey("6NeT5VYzF2DAj8RcUJtLfgv21CR8WiehNpABFV1t4M3Q");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const f = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8"))));
const V: VaultAccounts = { dex: new PublicKey("HqEbFccTn82RgLwD6NBLhtGmwX84XfYcgrqBEVnaTUFB"), mint: USDC, vault: new PublicKey("6SJSaHYmJgpU6G68vzEy9UeP44oYnxFscwJ1NA9vFs9b") };
const dest = await getAssociatedTokenAddress(USDC, f.publicKey);
const before = (await getAccount(conn, dest)).amount;
try {
  const s = await sendAndConfirmTransaction(conn, new Transaction().add(withdrawInsurance(P, V, { market: new PublicKey("DgY3EytkRP93usRPCnW65dsp7ZL4UW2CEL9JneJjoqWb"), receipt: new PublicKey("EuRaQynrvuidmyVfboGP6YFe76v6zzkmdRhjp4fQEayo"), lp: f.publicKey, destToken: dest, burnShares: 23_000_000n })), [f], { commitment: "confirmed" });
  const after = (await getAccount(conn, dest)).amount;
  console.log(`RECOVERED $${Number(after - before) / 1e6} USDC (tx ${s.slice(0, 12)}); wallet USDC now $${Number(after) / 1e6}`);
} catch (e: any) { console.log("recover FAIL:", String(e.message).slice(0, 80)); console.log(((e.logs) || []).join("\n").slice(0, 300)); }
process.exit(0);
