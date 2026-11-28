/** Pure tests for src/lean/prize-monitor.ts (the decode/validate/key logic of scripts/_lean-oi-monitor.ts). */
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { decodePrizeSnapshot, type RawAccount } from "../../src/lean/prize-monitor.js";
import { MAGIC, MARKET_SIZE, PORTFOLIO_SIZE, MktOff, PflOff } from "../../src/lean/constants.js";

const PROG = Keypair.generate().publicKey;
const USDC = 1_000_000n;

function market(o: { insurance: bigint; mark?: bigint; status?: number; size?: number; owner?: PublicKey; magic?: number }): RawAccount {
  const b = Buffer.alloc(o.size ?? MARKET_SIZE);
  b.writeUInt32LE(o.magic ?? MAGIC.MARKET, 0);
  b.writeUInt8(o.status ?? 0, MktOff.status);
  b.writeBigUInt64LE(o.mark ?? 94_000n * USDC, MktOff.markPrice);
  b.writeBigUInt64LE(o.insurance, MktOff.insurance);
  return { owner: o.owner ?? PROG, data: b };
}
function pfl(o: { capital: bigint; locked?: bigint; size?: number; owner?: PublicKey; magic?: number }): RawAccount {
  const b = Buffer.alloc(o.size ?? PORTFOLIO_SIZE);
  b.writeUInt32LE(o.magic ?? MAGIC.PORTFOLIO, 0);
  b.writeBigUInt64LE(o.locked ?? 0n, PflOff.totalLockedMm);
  b.writeBigUInt64LE(o.capital, PflOff.capital);
  return { owner: o.owner ?? PROG, data: b };
}
/** the pre-fix monitor key: free capital@88 only */
const oldKey = (accts: (RawAccount | null)[]) => {
  const c = (x: bigint) => (x < 0n ? -1n : x / 10_000n).toString();
  const cap = (a: RawAccount | null) => (a ? Buffer.from(a.data).readBigUInt64LE(88) : -1n);
  const m = Buffer.from(accts[0]!.data);
  return `${c(m.readBigUInt64LE(224))}|${c(cap(accts[1]))}|${c(cap(accts[2]))}|${m.readUInt8(4)}`;
};

const M = market({ insurance: 1000n * USDC });
const VAULT = pfl({ capital: 500n * USDC });

test("healthy snapshot: exact line format, value = capital + totalLockedMm", () => {
  const s = decodePrizeSnapshot(PROG, [M, VAULT, pfl({ capital: 60n * USDC, locked: 40n * USDC })]);
  assert.deepEqual(s.problems, []);
  assert.equal(s.line, "insurance=$1000 | vaultPfl=$500 | userLong=$100 | status=Active | mark=$94000");
  assert.equal(s.userLong.capital, 60n * USDC);
  assert.equal(s.userLong.lockedMm, 40n * USDC);
  assert.match(`12:34:56 [baseline] ${s.line}`, /^\d\d:\d\d:\d\d \[(baseline|CHANGE)\] insurance=\$\S+ \| vaultPfl=\$\S+ \| userLong=\$\S+ \| status=\S+ \| mark=\$\S+$/);
});

test("BEFORE/AFTER: a free -> locked margin shift with identical total changes the old key but NOT the new key", () => {
  const flat = [M, VAULT, pfl({ capital: 100n * USDC, locked: 0n })];          // prize long closed: all free
  const open = [M, VAULT, pfl({ capital: 60n * USDC, locked: 40n * USDC })];   // prize long open: 40 locked as margin
  assert.notEqual(oldKey(flat), oldKey(open), "old monitor: false CHANGE alert on open/close");
  const a = decodePrizeSnapshot(PROG, flat), b = decodePrizeSnapshot(PROG, open);
  assert.equal(a.key, b.key, "new monitor: no alert");
  assert.equal(a.line, b.line);
  // same for the vault portfolio
  assert.equal(decodePrizeSnapshot(PROG, [M, pfl({ capital: 1n * USDC, locked: 499n * USDC }), open[2]]).key, a.key);
});

test("a real prize move still changes the key (insurance, either portfolio total, status); sub-cent dust does not", () => {
  const base = decodePrizeSnapshot(PROG, [M, VAULT, pfl({ capital: 60n * USDC, locked: 40n * USDC })]).key;
  const k = (m: RawAccount, v: RawAccount | null, u: RawAccount | null) => decodePrizeSnapshot(PROG, [m, v, u]).key;
  const UL = pfl({ capital: 60n * USDC, locked: 40n * USDC });
  assert.notEqual(k(market({ insurance: 999n * USDC }), VAULT, UL), base);
  assert.notEqual(k(M, pfl({ capital: 499n * USDC }), UL), base);
  assert.notEqual(k(M, VAULT, pfl({ capital: 60n * USDC, locked: 39n * USDC })), base, "locked margin drained");
  assert.notEqual(k(M, VAULT, pfl({ capital: 59n * USDC, locked: 40n * USDC })), base, "free capital drained");
  assert.notEqual(k(market({ insurance: 1000n * USDC, status: 1 }), VAULT, UL), base);
  assert.equal(k(M, VAULT, pfl({ capital: 60n * USDC + 9_999n, locked: 40n * USDC })), base, "sub-cent dust ignored");
  assert.equal(k(market({ insurance: 1000n * USDC, mark: 95_000n * USDC }), VAULT, UL), base, "mark is display-only");
});

test("closed portfolio (account gone) is CLOSED, not an alert — same as before", () => {
  const s = decodePrizeSnapshot(PROG, [M, VAULT, null]);
  assert.deepEqual(s.problems, []);
  assert.equal(s.line, "insurance=$1000 | vaultPfl=$500 | userLong=$CLOSED | status=Active | mark=$94000");
  assert.notEqual(s.key, decodePrizeSnapshot(PROG, [M, VAULT, pfl({ capital: 0n })]).key);
});

test("validation: wrong owner / size / magic is a loud ALERT in the line and in the key, never garbage", () => {
  const UL = pfl({ capital: 100n * USDC });
  const good = decodePrizeSnapshot(PROG, [M, VAULT, UL]);
  const evil = Keypair.generate().publicKey;
  // same bytes, different owner (e.g. account closed and re-created under another program)
  const wrongOwner = decodePrizeSnapshot(PROG, [M, VAULT, pfl({ capital: 100n * USDC, owner: evil })]);
  assert.equal(wrongOwner.userLong.state, "invalid");
  assert.match(wrongOwner.line, /userLong=\$INVALID \| status=Active \| mark=\$94000 \| ALERT=userLong: owner /);
  assert.notEqual(wrongOwner.key, good.key);
  const wrongSize = decodePrizeSnapshot(PROG, [M, pfl({ capital: 500n * USDC, size: PORTFOLIO_SIZE - 104 }), UL]);
  assert.match(wrongSize.line, /vaultPfl=\$INVALID .*ALERT=vaultPfl: size 872 != 976/);
  const wrongMagic = decodePrizeSnapshot(PROG, [M, pfl({ capital: 500n * USDC, magic: MAGIC.MARKET }), UL]);
  assert.match(wrongMagic.line, /ALERT=vaultPfl: magic 0x/);
  // market: wrong layout size (e.g. the 400-byte round-3 market read with the 416-byte default)
  const m400 = market({ insurance: 1000n * USDC, size: 400 });
  const badMkt = decodePrizeSnapshot(PROG, [m400, VAULT, UL]);
  assert.equal(badMkt.marketOk, false);
  assert.match(badMkt.line, /^insurance=\$INVALID \| vaultPfl=\$500 \| userLong=\$100 \| status=INVALID \| mark=\$INVALID \| ALERT=market: size 400 != 416$/);
  assert.equal(decodePrizeSnapshot(PROG, [m400, VAULT, UL], 400).line, good.line, "explicit 400-byte market size is accepted");
  const missing = decodePrizeSnapshot(PROG, [null, VAULT, UL]);
  assert.match(missing.line, /^insurance=\$MISSING .* status=MISSING \| mark=\$MISSING \| ALERT=market: account not found$/);
  // a system-owned zero-length account (closed + refunded address)
  const sys = decodePrizeSnapshot(PROG, [M, VAULT, { owner: PublicKey.default, data: new Uint8Array(0) }]);
  assert.match(sys.line, /ALERT=userLong: owner 11111111111111111111111111111111 != program /);
  // alert state is stable -> fires once per transition, and clears back to the healthy key
  assert.equal(decodePrizeSnapshot(PROG, [M, VAULT, pfl({ capital: 100n * USDC, owner: evil })]).key, wrongOwner.key);
  assert.equal(decodePrizeSnapshot(PROG, [M, VAULT, UL]).key, good.key);
  assert.throws(() => decodePrizeSnapshot(PROG, [M, VAULT]), /expected 3 accounts/);
});
