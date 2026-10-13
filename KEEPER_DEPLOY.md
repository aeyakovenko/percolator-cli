# V16 oracle keeper hosting

This package runs one transaction-writing v16 oracle keeper on one existing Fly
Machine. It is a continuity runbook, not a bootstrap or high-availability
design. A second writer is forbidden.

## Required runtime configuration

The existing Machine must already have these explicit non-secret settings:

- `PROGRAM_ID`: reviewed v16 program identity.
- `MARKET`: reviewed market account.
- `LP_PORTFOLIO`: reviewed keeper crank portfolio.
- `KEEPER_MODE=live`: required for the protected live release workflow.
- `KEEPER_ASSETS_JSON`: ordered 1–16 asset records containing only `index`,
  `symbol`, and 32-byte hexadecimal `feedId`.
- `ORACLE_PRICE_SOURCE`: one of `pyth-solana-push`, `pyth-hermes`, or
  `magicblock-demo`.

Fly's secret store must contain the names `RPC_URL` and `KEEPER_SECRET_KEY`.
Hermes mode also requires `PYTH_API_KEY`. The RPC role must be dedicated to the
keeper, and the signer must be only the reviewed oracle authority—not an LP,
upgrade, browser, mint, or custody authority.

Enter credential values only through an approved non-echoing Fly secret flow.
Never place them in source, `fly.toml`, GitHub Actions, command history, logs,
chat, or a `NEXT_PUBLIC_*` variable. Operators verify names only.

## Read-only release preflight

Before requesting a release:

1. Verify there is no local keeper process.
2. Verify the supplied Fly app contains exactly one Machine and that the exact
   reviewed Machine is `started`.
3. Compare its recorded source revision and image digest with the private
   release checkpoint.
4. Verify the explicit non-secret settings above are present and the mode is
   `live`; do not print their values into a public log.
5. Verify the required secret names without inspecting values.
6. Confirm RPC health, the rate-limit circuit, signer role, and current market
   health are adequate.

Use semantic placeholders such as `<APP>` and `<MACHINE_ID>` in operator notes.
This repository intentionally contains no deployable app, Machine, program,
market, portfolio, asset-feed, or credential default.

## Normal promotion

Use only the manually dispatched protected workflow documented in
`FLY_RELEASE.md`. It builds and validates the candidate while the old keeper
remains live, rechecks the exact singleton immediately before mutation, updates
only that Machine, and requires:

- the candidate source and digest to be running on that same Machine;
- a fresh `confirmed-push` marker bound to the workflow release ID, source,
  Machine, cutoff, and selected oracle source; and
- a healthy operational audit with explicit positive risk-equity and insurance
  floors.

The release changes only the image, release metadata, and reviewed oracle
source. Program, market, portfolio, asset map, mode, RPC, and signer changes are
separate work packages. A stopped Machine is an emergency-resume gate and is
never normal release staging.

If candidate proof fails, the workflow first checks whether the old image
remained live. Otherwise, the dispatch's explicit `ROLLBACK` authorization
permits one restoration of the captured image, source metadata, release label,
and oracle source. Rollback must itself prove a fresh write and healthy audit;
the workflow then fails because the candidate was not approved.

## Local validation

Local checks do not contact Solana or Fly:

```text
pnpm install --offline --frozen-lockfile
pnpm release:check
```

Running the keeper or audit requires explicit local configuration and is not
part of the offline gate:

```text
pnpm keeper:v16
pnpm audit:v16
```

Both commands fail closed when required identities are absent. Keeper startup
also requires the oracle-authority signer; the audit is read-only and must not
load it.

## Separate authorization required

Each of the following is outside the release workflow and needs a new reviewed
brief and explicit authorization: creating an app or Machine, changing scale or
resources, configuring secrets, changing target identities or asset feeds,
starting a stopped keeper, deploying a v16 program, changing signer authority,
or implementing multi-writer failover.
