# Mukon CLI porting inventory

This branch is rooted in `aeyakovenko/percolator-cli` `7f9004768e5f` and
already contains the reviewed deployed-v16 compatibility overlay
`491775de95e5`. The old Mukon line is preserved at
`archive/mukon-master-cd5f012-20261013`.

The old and upstream lines have no merge base. The `248 ahead / 322 behind`
comparison is therefore not a useful replay plan. Tree-to-tree comparison is
239 files and `+38,500/-14,046`; the Mukon side contains substantial product
code, not just disposable scripts.

## Keep and port as product functionality

### Deployed-v16 compatibility

- `src/mukon/deployed-v16.ts`
- `scripts/mukon-deployed-v16.test.ts`
- `MUKON_COMPATIBILITY.md`

These are already present through `491775d`. They keep exact Mukon wire
encoders and fail-closed account/provider validation separate from upstream's
newer layouts.

### Generic CLI and runtime

The Stage 1 source audit proved that this area cannot be copied as one package.
Despite its generic names, `src/abi`, `src/solana/slab.ts`, and the command
modules implement the pre-v16 single-slab program: tags 0–30, a 72-byte header,
and a 1,156,936-byte slab. Those files are incompatible with both upstream's
current v16 layout and Mukon's deployed v16 wrapper. They remain preserved on
the archive branch, but are not active normalized CLI code.

Port only version-independent concepts into an explicit namespace:

- strict numeric/public-key validation;
- explicit runtime configuration with no default cluster or wallet;
- RPC construction with automatic 429 retries disabled;
- abortable, blockheight-aware confirmation with distinct timeout,
  cancellation, expiry, transport, and on-chain failures; and
- offline tests for those boundaries.

Any future command must select `src/v16` or `src/mukon/deployed-v16` explicitly.
There will be no unversioned instruction or slab parser and no compatibility
shim that guesses a layout from account bytes.

### Keeper, oracle, and provider isolation

Port as a coherent package, preserving the fixes through `cd5f012`:

- `scripts/oracle-keeper-v16.ts`
- `scripts/keeper-{runtime,maintenance,shadow}.ts` and focused tests
- `scripts/oracle-price-source.ts` and tests
- `scripts/pyth-{hermes,solana-push}.ts` and tests
- `scripts/magicblock-demo-prices.ts` and tests

Required behavior includes bounded RPC/confirmation work, pending-confirmation
reconciliation, push/crank separation, loss-stale and delayed-maintenance
recovery, per-feed quarantine, authenticated Hermes requests, and preservation
of the exactly-one-writer rule.

Stage 2 ports the deterministic keeper runtime, maintenance, shadow and provider
modules plus 115 focused tests. The executable `oracle-keeper-v16.ts` is
deliberately deferred: its four source-ordering tests are preserved separately
and must pass after Stage 3 removes live program/market/portfolio defaults and
ports the required health/coherence dependencies.

Stage 3A ports the reviewed `cd5f012` market-health and temporal-coherence
engines byte-for-byte with their offline tests. It remains intentionally pure:
the keeper executable remains deferred until its live product defaults are
removed and explicit configuration is enforced.

Stage 3B adds the reviewed audit profiles and a read-only RPC wrapper. Unlike
the historical wrapper, it has no program, market, or portfolio fallback: all
target identities and the RPC role are required explicitly. Its offline tests
prove configuration and source safety; no live audit was run during the port.

Stage 3C admits the reviewed keeper executable without its historical product
defaults. RPC, program, market, LP portfolio, keeper mode, signer role, and the
ordered asset/feed mapping are all explicit. Missing mode never falls through
to live operation, and the prior hard-coded major/ZEC policy is not part of the
normalized source. The executable and its source-wiring tests are offline-
reviewed only; no keeper was started and no signer or RPC was used.

Stage 4A ports only the pure singleton-status and fresh-release-write validators
with generic offline fixtures. They consume bounded synthetic stdin in tests and
cannot call Fly. Workflow, image, hosting configuration, and deployment docs
remain deferred to a separate package.

### Release and singleton controls

Port together and keep manual-only:

- `.github/workflows/deploy-keeper.yml`
- `Dockerfile`, `.dockerignore`, `fly.toml`
- `KEEPER_DEPLOY.md`, `FLY_RELEASE.md`
- `scripts/verify-fly-singleton.mjs`
- `scripts/verify-keeper-release-log.mjs`
- `scripts/check-keeper-release-workflow.test.mjs`
- their tests

The normalized line must retain exact-machine admission, source/image binding,
fresh release-log evidence, and no clone/scale/second-writer path. Copying a
Fly app name or historical release identifier is not part of the port.

### Health, coherence, recovery planning, and operator safety

Keep the generic, read-only or simulation-first tools and their focused tests:

- `check-current-market-health.ts`
- `v16-{market-health,market-coherence,audit-profile}.ts`
- guarded empty-market reanchor builder/simulator
- LP funding preflight and recapitalization checks
- order-market initializer and tests
- current-market recovery simulation/verification where it is parameterized,
  fail-closed, and separated from execution

Execution scripts in the dirty source worktree are not part of this branch and
must remain untouched. Any future executable recovery port needs a separate
transaction-authority brief. Public/private order execution remains owned by
the indexer/executor service; this repository's meaningful order functionality
is initialization, encoding, validation, and audit support.

### Protocol assurance

Retain tests that exercise ABI encoding, invariants, liquidation, accounting,
ADL, fee, oracle, and recovery semantics when they can be rebased onto an
explicit program/engine pin. Large test volume alone is not a reason to drop
coverage.

## Rework before porting

- Package scripts and dependencies: form a union that keeps upstream's v16
  build/smoke entry points and Mukon's CLI/keeper entry points; do not overwrite
  either package wholesale.
- `src/v16`: upstream deleted/replaced files must stay canonical on this branch.
  Mukon deployed-layout support stays under `src/mukon` with golden vectors.
- `.env.example`: retain names and roles only; remove live addresses or
  provider-specific values that are not safe configuration defaults.
- `README.md` and deployment docs: rewrite around the normalized architecture;
  do not select one side's historical deployment narrative.
- `devnet-market.json` and similar configuration: replace with schema/examples
  or environment-driven inputs, not a copied live deployment snapshot.
- old recovery tests/scripts: keep only if parameterized against explicit
  fixtures and free of automatic broadcast behavior.
- `scripts/verify-manifest.ts`: its current fixture is a historical mainnet
  manifest that fails five policy fields. It remains available only as the
  explicit `test:legacy-manifest` diagnostic and is not part of the default
  offline test suite.

## Drop from the normalized product line

The commits remain recoverable from the archive branch and Git history. Do not
replay these artifacts into the normalized product line:

- upstream and Mukon bounty-specific, STOXX, retired mainnet, and superseded
  devnet manifests or hard-coded market snapshots;
- crontab backups, cron shell fragments, one-off monitoring baselines, and
  historical machine/release identifiers;
- one-time deploy, upgrade, unsafe-drain, close-all, wind-down, top-up, unwrap,
  reclaim, or teardown scripts tied to retired accounts;
- generated keypair references or any credential-bearing configuration;
- duplicate audit/status prose whose finding is already captured by current
  tests, `KANBAN.md`, or an immutable release record;
- v12-to-v16 migration utilities and obsolete account-layout parsers;
- temporary debug/probe files and uncommitted `.tmp-*` scripts.

Representative upstream-only drop candidates include the
`mainnet-bounty*-market.json`, `mainnet-stoxx-sol-market.json`, bounty cron,
STOXX admin/deploy/keeper scripts, and devnet unsafe-drain tooling.
Representative old Mukon drop candidates include historical deployment
snapshots, old `setup-devnet-market`/random-trader operations, and executed
market-specific recovery tools.

## Commit sequence

1. `491775d`: deployed-v16 compatibility overlay (already present).
2. This inventory and normalization boundary.
3. Version-explicit normalized runtime foundation plus offline tests,
   preserving upstream `src/v16` and excluding the legacy single-slab ABI.
4. Keeper/provider package plus deterministic tests.
5. Health/coherence and simulation-only operator tools.
6. Manual release/singleton controls.
7. Documentation/package reconciliation and removal of quarantined deployment
   artifacts only after all retained tests have explicit fixtures.

Each stage must pass typecheck/build and its focused tests. No stage authorizes
a push, force-push, Fly mutation, deployment, signer use, or transaction.
