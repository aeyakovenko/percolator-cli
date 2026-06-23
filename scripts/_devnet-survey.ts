/* Quick survey of wrapper-owned devnet accounts under Bu1J8eQQN. */
import { Connection, PublicKey } from "@solana/web3.js";

const PROG = new PublicKey("Bu1J8eQQN2mNnUgisSEd5StBG6zDaRb7fwDjN34VzgLG");
const RPC = process.env.SOLANA_RPC_URL ?? "https://devnet.helius-rpc.com/?api-key=2dfa2086-c6cd-4cb4-8a13-08ecdee36a0f";
const conn = new Connection(RPC, "confirmed");

async function survey(kind: number, label: string) {
  const accts = await conn.getProgramAccounts(PROG, {
    filters: [{ memcmp: { offset: 10, bytes: Buffer.from([kind]).toString("base64"), encoding: "base64" } }],
  });
  let total = 0n;
  for (const a of accts) total += BigInt(a.account.lamports);
  console.log(`${label}: ${accts.length} accts, ${Number(total)/1e9} SOL rent`);
  for (const a of accts) {
    console.log(`  ${a.pubkey.toBase58()}  ${a.account.data.length}B  ${a.account.lamports/1e9} SOL`);
  }
  return { accts, total };
}

(async () => {
  console.log("=== Devnet wrapper Bu1J8eQQN survey ===");
  await survey(1, "Markets (kind=1)");
  await survey(2, "Portfolios (kind=2)");
  await survey(3, "BackingDomainLedgers (kind=3)");
  await survey(4, "InsuranceLedgers (kind=4)");
})();
