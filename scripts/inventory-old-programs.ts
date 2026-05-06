/**
 * Inventory all old devnet programs we hold upgrade authority on.
 * Reports per-program: number of owned accounts and total lamports.
 */
import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAMS = [
  "FMbfUkReq3fBpmgehw7E6yikYvuGjMiHdosxX2Q8mVDA",
  "54sponiXs8tpQFd7yPeBia9uB83apehvGxFC2bpgS47i",
  "AT2XFGzcQ2vVHkW5xpnqhs8NvfCUq5EmEcky5KE9EhnA",
  "5ogNxr4uFXZXoeJ4cP89kKZkx1FkbaD2FBQr91KoYZep",
  "DDHRT1iqLswUKro4f1Bio6tde6rfMTe7ysUYyBCKQPfe",
  "FGarWKFQCsdBYwr3AjX7915sp6Ut6aTEg2QyQnnuZZrH",
  "56scG5gnijHPkGtMqrA5TiMq79ZpZDqcGfHWHAWyKPa3",
  "46iB4ET4WpqfTXAqGSmyBczLBgVhd1sHre93KtU3sTg9",
  "ErpA6LYZHrcbAU9NEFN1sFj4gbgtkV9P6yFb97jqZfTE",
  "CphxyUxcLA6HcWqtTeYqxBiaye1pCj9QnubVdwrDLjyR",
  "ANeutRJhNbamB6gMMVnMT7biSm6H98v1HyM5bLRhBfbP",
];

const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");

async function main() {
  let grandTotal = 0;
  for (const pid of PROGRAMS) {
    const pk = new PublicKey(pid);
    try {
      const accounts = await conn.getProgramAccounts(pk, {
        dataSlice: { offset: 0, length: 0 },
      });
      const sol = accounts.reduce((s, a) => s + a.account.lamports, 0) / 1e9;
      grandTotal += sol;
      const sizes = new Set<number>();
      for (const a of accounts) {
        const full = await conn.getAccountInfo(a.pubkey, "confirmed");
        if (full) sizes.add(full.data.length);
      }
      console.log(`${pid}: ${accounts.length} accounts, ${sol.toFixed(4)} SOL, sizes=[${[...sizes].join(",")}]`);
    } catch (e: any) {
      console.log(`${pid}: ERROR ${e.message}`);
    }
  }
  console.log(`\nGrand total in slabs: ${grandTotal.toFixed(4)} SOL`);
}

main().catch(e => { console.error(e); process.exit(1); });
