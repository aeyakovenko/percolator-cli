/** READ-ONLY: compare the on-chain program bytes of a program id with a local .so (sha256 of the first len(.so)
 *  bytes of ProgramData; the rest must be zero padding).  npx tsx scripts/_lean-upgrade-verify.ts <programId> <file.so> [rpcUrl=devnet helius] */
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
const key = fs.readFileSync(`${process.env.HOME}/.helius`, "utf8").replace(/\s/g, "");
const cluster = process.argv[4] === "mainnet" ? "mainnet" : "devnet";
const conn = new Connection(`https://${cluster}.helius-rpc.com/?api-key=${key}`, "confirmed");
(async () => {
  const id = new PublicKey(process.argv[2]); const so = fs.readFileSync(process.argv[3]);
  const prog = await conn.getAccountInfo(id);
  const pd = await conn.getAccountInfo(new PublicKey(prog!.data.subarray(4, 36)));
  const body = pd!.data.subarray(45);
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const same = sha(body.subarray(0, so.length)) === sha(so) && body.subarray(so.length).every((x) => x === 0);
  console.log(`${cluster} ${id.toBase58()}: on-chain sha256(first ${so.length} B) ${sha(body.subarray(0, so.length)).slice(0, 16)}… vs file ${sha(so).slice(0, 16)}… => ${same ? "IDENTICAL (+ zero padding)" : "DIFFERENT"}; last deploy slot ${pd!.data.readBigUInt64LE(4)}; max len ${body.length}`);
  process.exit(same ? 0 : 1);
})().catch((e) => { console.error(String(e).replace(/api-key=[^&\s"']+/g, "api-key=***").slice(0, 300)); process.exit(1); });
