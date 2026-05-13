import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

console.log("Testing config loading...\n");

const oldHome = process.env.HOME;
const oldCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "percolator-config-"));

try {
  const home = join(tmp, "home");
  const cwd = join(tmp, "cwd");
  mkdirSync(join(home, ".config"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  process.env.HOME = home;
  process.chdir(cwd);

  writeFileSync(
    join(home, ".config", "percolator-cli.json"),
    JSON.stringify({
      rpcUrl: "https://api.devnet.solana.com",
      programId: "2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp",
      walletPath: "~/custom-devnet-wallet.json",
      commitment: "finalized",
    })
  );

  const config = loadConfig({});
  assert(config.rpcUrl === "https://api.devnet.solana.com", "loads documented home config");
  assert(config.wallet === "~/custom-devnet-wallet.json", "accepts documented walletPath alias");
  assert(config.commitment === "finalized", "preserves commitment from home config");
  console.log("✓ documented home config with walletPath alias");

  const overridden = loadConfig({ wallet: "~/cli-wallet.json", rpc: "https://example.com" });
  assert(overridden.wallet === "~/cli-wallet.json", "CLI wallet overrides file walletPath");
  assert(overridden.rpcUrl === "https://example.com", "CLI RPC overrides file RPC");
  console.log("✓ CLI overrides file config");
} finally {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(tmp, { recursive: true, force: true });
}

console.log("\n✅ All config tests passed!");
