import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
// Pyth receiver program (owns PriceUpdateV2 accounts) on devnet + mainnet.
const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const FEEDS: Record<string, string> = {
  "SOL/USD": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "BTC/USD": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "EUR/USD": "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
};
(async () => {
  const nowS = Math.floor(Date.now() / 1000);
  for (const [name, fid] of Object.entries(FEEDS)) {
    const feedBytes = Buffer.from(fid, "hex");
    // PriceUpdateV2: 8 disc + 32 write_authority + 1 verification_level + price_message{ feed_id@41 ... }
    const res = await conn.getProgramAccounts(RECEIVER, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 41, bytes: bs58.encode(feedBytes) } }],
    });
    if (!res.length) { console.log(`${name}: none`); continue; }
    for (const { pubkey, account } of res) {
      const d = account.data;
      const price = d.readBigInt64LE(73), conf = d.readBigUInt64LE(81), expo = d.readInt32LE(89), pub = d.readBigInt64LE(93);
      const px = Number(price) * Math.pow(10, expo);
      console.log(`${name}: ${pubkey.toBase58()} len=${d.length} ver=${d[40]} price=$${px.toFixed(4)} conf=${(Number(conf) * Math.pow(10, expo)).toFixed(4)} age=${nowS - Number(pub)}s`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
