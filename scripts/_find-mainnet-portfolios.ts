import { Connection, PublicKey } from "@solana/web3.js";
import { HEADER_LEN } from "../src/v16/index.js";

const PROG = new PublicKey("4m3ipBQDYX6JQ9YSmUXDjESDHMtGWtiXforkWr9Qoxdi");
const MARKET = new PublicKey("HgpvbLJhEZhtDAR25XWnGYMAr7MKMT1Zzpv5HGUrzbVq");

(async () => {
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  // KIND_PORTFOLIO = 2, header at offset 10
  const accts = await conn.getProgramAccounts(PROG, {
    filters: [{ memcmp: { offset: 10, bytes: Buffer.from([2]).toString("base64"), encoding: "base64" } }],
  });
  console.log("portfolios under", PROG.toBase58(), ":", accts.length);
  for (const a of accts) {
    const d = a.account.data;
    // provenance_header is at HEADER_LEN..HEADER_LEN+100; market_group_id is first 32 bytes
    const market = new PublicKey(d.subarray(HEADER_LEN, HEADER_LEN + 32));
    const owner = new PublicKey(d.subarray(HEADER_LEN + 100, HEADER_LEN + 132));
    console.log(`  ${a.pubkey.toBase58()}  ${d.length}B  market=${market.toBase58()}  owner=${owner.toBase58()}  ${a.account.lamports / 1e9} SOL`);
  }
})();
