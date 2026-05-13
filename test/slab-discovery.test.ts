import {
  hasSlabMagic,
  parseHeader,
  slabMagicMemcmpFilter,
  SLAB_MAGIC,
  SLAB_MAGIC_BYTES,
} from "../src/solana/slab.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

console.log("Testing slab discovery filters...\n");

const magicBytes = Buffer.from(SLAB_MAGIC_BYTES);
const validSlab = Buffer.alloc(136);
validSlab.writeBigUInt64LE(SLAB_MAGIC, 0);

assert(magicBytes.toString("ascii") === "TALOCREP", "slab magic is little-endian account bytes");
assert(hasSlabMagic(validSlab), "hasSlabMagic accepts LE parser bytes");

const bigEndianBytes = Buffer.from("PERCOLAT", "ascii");
assert(!hasSlabMagic(bigEndianBytes), "hasSlabMagic rejects BE ASCII bytes");

let threw = false;
try {
  parseHeader(Buffer.concat([bigEndianBytes, Buffer.alloc(128)]));
} catch {
  threw = true;
}
assert(threw, "parseHeader rejects BE ASCII magic");

const filter = slabMagicMemcmpFilter();
assert("memcmp" in filter, "discovery filter is memcmp");
assert(filter.memcmp.offset === 0, "memcmp starts at account byte zero");
assert(filter.memcmp.encoding === "base64", "memcmp declares base64 encoding");
assert(filter.memcmp.bytes === magicBytes.toString("base64"), "memcmp bytes use LE slab magic");
assert(Buffer.from(filter.memcmp.bytes, "base64").equals(magicBytes), "memcmp base64 decodes to LE slab magic");

console.log("✓ slab magic bytes and memcmp filter");
console.log("\n✅ All slab discovery tests passed!");
