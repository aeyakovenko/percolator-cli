/** Read-only (simulate only): the round-4 insurance receipt under 55c167f — parse lastDepositBucket, readiness, and
 *  SIMULATE a 1-share owner withdraw with OI > 0 (nothing is sent). */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import * as fs from "fs";
import { parseInsReceipt, insWithdrawReadyAt, withdrawInsurance, deriveDexVault, parseMarket, type VaultAccounts } from "../src/lean/index.js";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
const m = JSON.parse(fs.readFileSync("lean-mainnet-r4.json", "utf8"));
const P = new PublicKey(m.percolator), DEX = new PublicKey(m.dex), USDC = new PublicKey(m.usdc), MKT = new PublicKey(m.market);
const f = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const V: VaultAccounts = { dex: DEX, mint: USDC, vault: deriveDexVault(P, DEX)[0] };
(async () => {
  const recKey = new PublicKey(m.insReceipt ?? m.prizes?.insReceipt ?? m.insuranceReceipt);
  const r: any = parseInsReceipt(Buffer.from((await conn.getAccountInfo(recKey))!.data));
  const slot = BigInt(await conn.getSlot("confirmed"));
  const mk: any = parseMarket(Buffer.from((await conn.getAccountInfo(MKT))!.data));
  console.log(`receipt ${recKey.toBase58().slice(0, 8)}… shares ${r.shares} lastDepositBucket ${r.lastDepositBucket} ready ${JSON.stringify(insWithdrawReadyAt(r, slot), (_, v) => typeof v === "bigint" ? String(v) : v)} | market OI long ${mk.oiLong}`);
  const ix = withdrawInsurance(P, V, { market: MKT, receipt: recKey, lp: f.publicKey, destToken: await getAssociatedTokenAddress(USDC, f.publicKey), burnShares: 1n } as any);
  const tx = new Transaction({ feePayer: f.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash }).add(ix);
  const sim = await conn.simulateTransaction(tx, [f]);
  console.log(`SIMULATED owner withdraw of 1 share with OI > 0: ${sim.value.err ? "rejected " + JSON.stringify(sim.value.err) : "would succeed (55c167f #117 behaviour)"} — NOT sent`);
})().catch(e => { console.error("ERR", String(e).replace(/api-key=[^ "&]*/g, "***").slice(0, 300)); process.exit(1); });
