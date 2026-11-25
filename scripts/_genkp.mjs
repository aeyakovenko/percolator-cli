import { Keypair } from "@solana/web3.js";
import fs from "fs";
for (const name of ["percolator","matcher","adapter"]) {
  const p = `${process.env.HOME}/.config/solana/lean-mainnet-${name}.json`;
  if (fs.existsSync(p)) { const k=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p,"utf8")))); console.log(`${name}: ${k.publicKey.toBase58()} (exists)`); continue; }
  const k = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  console.log(`${name}: ${k.publicKey.toBase58()} saved`);
}
