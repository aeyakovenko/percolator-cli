import {
  isMainnetRpc,
  resolveTxMode,
} from "../src/runtime/tx.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertThrows(fn: () => void, expectedMsg: string, testName: string): void {
  try {
    fn();
    throw new Error(`FAIL: ${testName} - expected to throw`);
  } catch (e) {
    if (e instanceof Error && e.message.includes(expectedMsg)) return;
    throw new Error(`FAIL: ${testName} - unexpected error: ${e}`);
  }
}

console.log("Testing transaction safety helpers...\n");

{
  assert(isMainnetRpc("https://api.mainnet-beta.solana.com"), "detects public mainnet RPC");
  assert(isMainnetRpc("https://mainnet.helius-rpc.com/?api-key=redacted"), "detects Helius mainnet RPC");
  assert(!isMainnetRpc("https://api.devnet.solana.com"), "does not classify devnet as mainnet");
  assert(!isMainnetRpc("http://127.0.0.1:8899"), "does not classify localnet as mainnet");
  console.log("✓ isMainnetRpc");
}

{
  assert(resolveTxMode({ simulate: false, send: false }).simulate === true, "defaults to simulation");
  assert(resolveTxMode({ simulate: true, send: false }).simulate === true, "--simulate stays simulation");
  assert(resolveTxMode({ simulate: false, send: true }).simulate === false, "--send opts into send");
  assertThrows(
    () => resolveTxMode({ simulate: true, send: true }),
    "Choose either --simulate or --send",
    "rejects conflicting tx mode flags"
  );
  console.log("✓ resolveTxMode");
}

console.log("\n✅ All transaction helper tests passed!");
