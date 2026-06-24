import { Connection, PublicKey } from "@solana/web3.js";
import { HEADER_LEN, PA } from "../src/v16/index.js";

(async () => {
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const pfs = [
    "FAkQVjq1iLpAfkU8J8XUmznhnehoTaFqMHsN3TNVfTKu",
    "GeZ23ec6x9LPJCT1CiahVVZxGZTumouX7DAfUpEdThdi",
  ];
  const u128 = (b: Buffer, o: number) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
  const i128 = (b: Buffer, o: number) => {
    const lo = b.readBigUInt64LE(o);
    const hi = b.readBigInt64LE(o + 8);
    return (hi << 64n) | lo;
  };
  for (const k of pfs) {
    const ai = await conn.getAccountInfo(new PublicKey(k), "confirmed");
    if (!ai) { console.log(k, "GONE"); continue; }
    const d = Buffer.from(ai.data);
    const owner = new PublicKey(d.subarray(HEADER_LEN + PA.owner, HEADER_LEN + PA.owner + 32));
    const capital = u128(d, HEADER_LEN + PA.capital);
    const pnl = i128(d, HEADER_LEN + PA.pnl);
    const reserved = u128(d, HEADER_LEN + PA.reserved_pnl);
    console.log(`${k}  owner=${owner.toBase58()}  capital=${capital}  pnl=${pnl}  reserved=${reserved}`);
  }
})();
