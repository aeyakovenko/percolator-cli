import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { createMarket, LEAN_DEVNET, POS_SCALE } from "../../src/lean/index.js";

test("createMarket bounds the liquidation fee by maintenance margin", () => {
  const publicKey = () => Keypair.generate().publicKey;
  const accounts = {
    dex: publicKey(),
    market: publicKey(),
    mint: publicKey(),
    oracleAuth: publicKey(),
    creator: publicKey(),
    creatorToken: publicKey(),
    feeVault: publicKey(),
  };
  const params = {
    initPrice: 100n * POS_SCALE,
    exitWindow: 216_000n,
    maxStaleness: 9_000n,
    warmupSlots: 0n,
    imBps: 1_000n,
    mmBps: 600n,
    tradeFeeBps: 2n,
    maxMoveBps: 0n,
    maxInsDrawBps: 2_500n,
    maxOi: POS_SCALE,
  };
  const build = (liqFeeBps: bigint) =>
    createMarket(LEAN_DEVNET.percolator, { ...accounts, params: { ...params, liqFeeBps } });

  assert.equal(build(0n).data.readBigUInt64LE(52), 0n);
  assert.equal(build(params.mmBps).data.readBigUInt64LE(52), params.mmBps);
  assert.throws(() => build(-1n), /liqFeeBps must be between 0 and mmBps/);
  assert.throws(() => build(params.mmBps + 1n), /liqFeeBps must be between 0 and mmBps/);
});
