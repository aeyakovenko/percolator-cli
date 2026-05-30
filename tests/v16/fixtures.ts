/**
 * Golden-vector fixture loader. Each fixture is a real on-chain account captured
 * via `getAccountInfo` (encoding base64) — no keypair is needed to read accounts,
 * so these are reproducible from any public RPC:
 *
 *   curl <RPC> -s -X POST -H 'content-type: application/json' -d \
 *     '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo",
 *       "params":["BhkMic5gHLjj5Uxkg6rBBXofUzeTZVwmV4uFzfhwtgQw",{"encoding":"base64"}]}'
 *
 * and the `.value.data[0]` base64 string is stored verbatim. They are NOT
 * synthetic — they decode against the live mainnet bounty-5 v16 market.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface Fixture {
  source: string;
  capturedAt: string;
  program: string;
  address: string;
  owner: string;
  lamports: number;
  dataLen: number;
  data_b64: string;
}

export function loadFixture(name: string): { meta: Fixture; data: Buffer } {
  const raw = fs.readFileSync(path.join(HERE, "fixtures", name), "utf8");
  const meta = JSON.parse(raw) as Fixture;
  const data = Buffer.from(meta.data_b64, "base64");
  if (data.length !== meta.dataLen) {
    throw new Error(`${name}: decoded ${data.length} B but meta.dataLen=${meta.dataLen}`);
  }
  return { meta, data };
}
