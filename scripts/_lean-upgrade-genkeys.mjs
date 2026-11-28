// Generate (idempotently) the fresh devnet program + oracle keypairs for the in-place upgrade proof.
// Keys go to OUT_DIR (default .upgrade-out/, git-ignored via the *-keypair.json rule); only pubkeys are printed.
import { Keypair } from "@solana/web3.js";
import fs from "fs";
const dir = process.env.OUT_DIR ?? `${process.cwd()}/.upgrade-out`;
fs.mkdirSync(dir, { recursive: true });
for (const n of ["percolator", "matcher", "oracle_adapter", "reward_module", "oracle", "oracle2", "oracle3"]) {
  const p = `${dir}/${n}-keypair.json`;
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  const k = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  console.log(n, k.publicKey.toBase58());
}
