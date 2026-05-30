# v16 offline test suite

Offline regression guards for the v16 risk-state decode path — the parsers in
`src/v16/parsers.ts` that the keeper (`scripts/mainnet-bounty5-v16-tick.ts`) and
`scripts/v16-inspect.ts` depend on. No RPC, no validator, no keypair: it runs from
committed golden vectors and pure integer math.

Run via the repo root:

```bash
pnpm test          # manifest check + this suite
npx tsx tests/v16/runner.ts   # just this suite
```

## Why this exists

The pre-v16 `tests/` suite (t1–t22 + harness/invariants/preflight) was a live
solana-test-validator integration suite built on the CLI/ABI/`src/solana/*` layer
that commit `2ddf8ca` ("v16: clean up pre-v16 code") deleted. Every file imported a
now-missing module, so `npx tsx tests/runner.ts` threw `ERR_MODULE_NOT_FOUND`, and
`tsconfig.json` (`include: ["src/**/*"]`) never type-checked `tests/`, so it rotted
silently. That suite was removed and replaced by this v16-native one.

## Files

| File | What it covers |
|------|----------------|
| `runner.ts` | Aggregates the suites; exits non-zero on any failure |
| `harness.ts` | Tiny assert/report helper (mirrors `verify-manifest.ts` style) |
| `fixtures.ts` | Loads + base64-decodes a golden-vector account |
| `parsers.test.ts` | Decodes the real mainnet market + portfolio, asserts every safety field, conservation, and `asset_slot_capacity` |
| `capacity-guard.test.ts` | Regression guard: parser reads the authoritative on-chain `asset_slot_capacity` and never overruns on drift |
| `risk-math.ts` | Pure maintenance-margin / liquidation math (mm 500 bps, liq fee 5 bps) |
| `liquidation.test.ts` | Positive liquidation path + conservation across a simulated settlement |
| `fixtures/*.json` | Real on-chain accounts (base64), captured `2026-05-30` |

## Regenerating the golden-vector fixtures

The fixtures are real mainnet accounts — reproducible from any public RPC, no
keypair needed for reads:

```bash
curl -s https://api.mainnet-beta.solana.com -X POST \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo",
       "params":["BhkMic5gHLjj5Uxkg6rBBXofUzeTZVwmV4uFzfhwtgQw",{"encoding":"base64"}]}' \
  | jq -r '.result.value.data[0]'
```

Store the base64 string as `data_b64` in the fixture JSON (with the matching
`dataLen`). The market is `BhkMic5gHLjj5Uxkg6rBBXofUzeTZVwmV4uFzfhwtgQw`, the keeper
portfolio is `5iWTBYod2C4RovvrWfqs45sTbqNPb9B1B7cSkN2atVNs`, both under program
`4m3ipBQDYX6JQ9YSmUXDjESDHMtGWtiXforkWr9Qoxdi` (see `mainnet-bounty5-v16-market.json`).

## What needs an integration env (not covered here)

The deterministic margin math + conservation are asserted offline. A full liquidation
round-trip — `PermissionlessCrank action:1` executing, the mark-walk envelope
(≤480 bps/crank), and CPI fee routing — needs a `solana-test-validator` or a funded
devnet keeper, and is out of scope for the offline suite.
