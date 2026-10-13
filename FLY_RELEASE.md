# Continuous singleton keeper release

The v16 keeper is promoted only through the manually dispatched
`Promote v16 oracle keeper (continuous singleton)` workflow. Pushes, pull
requests, and schedules never deploy it.

## Boundary

This is a one-Machine continuity flow. It does not create a standby, make two
writers safe, bootstrap hosting, configure credentials, or start a stopped
Machine. Host-failure failover requires a separately reviewed on-chain
lease/fencing design.

## One-time GitHub setup

1. Protect the `production` environment with the required human reviewer.
2. Store only an app-scoped Fly deployment token as the environment secret
   `FLY_API_TOKEN`.
3. Never store oracle, RPC, signer, program, market, portfolio, asset-map, or
   provider credential values in GitHub Actions.

## Dispatch checkpoint

From an exact reviewed commit, provide:

- the existing Fly app name and exact started singleton Machine ID;
- the full source revision and `sha256:` digest recorded for its current image;
- the candidate `vN` release label;
- the reviewed oracle source;
- positive operational floors for LP conservative risk equity and aggregate
  domain insurance;
- `DEPLOY`; and
- `ROLLBACK`, authorizing at most one restoration of the captured old image.

The protected-environment reviewer compares every identity with the private
release checkpoint. The workflow then verifies the existing Machine already has
explicit program, market, portfolio, live mode, asset map, oracle source, and
required secret names. It never changes those target settings or credentials.

## Workflow contract

1. Reject a missing, stopped, duplicate, wrong-Machine, wrong-source, or
   wrong-image deployment.
2. Reject missing explicit target configuration, non-live mode, or missing
   required secret names. The Hermes API-key secret name is required for both
   candidate and rollback when either selected source uses Hermes.
3. Run the normalized offline tests, focused typechecks, build, release
   validators, and workflow-contract tests before external mutation.
4. Build and digest-pin the candidate while the old keeper remains live.
5. Re-read the old singleton immediately before mutation and run the
   operational audit inside that exact Machine.
6. Update only the supplied Machine's image, release metadata, and selected
   oracle source. Never create, clone, scale, or start a Machine.
7. Require the candidate to return `started`, emit a fresh release-bound
   confirmed-write marker, and pass the operational audit.
8. On failure, avoid rollback when the captured image is still running;
   otherwise perform one captured-image rollback, prove a fresh write and
   healthy audit, and fail the workflow.

A successful rollback restores service but does not approve the candidate.

## Audit policy

Continuous releases use `AUDIT_PROFILE=operational` with explicit positive
floors. Identity, custody/accounting, maintenance, locks, open interest,
residue, backing, authority, risk equity, insurance, and live-clock failures
remain release-blocking. The floors are reviewed policy inputs, never inferred
from the current account or stored as secrets.

## Not covered

- Fly app/Machine creation, scale, resources, secrets, or stopped-Machine resume;
- target program, market, portfolio, asset map, mode, RPC, or signer changes;
- v16 program deployment or authority changes; or
- active/passive or multi-writer failover.

Each needs its own reviewed package and fresh authorization.
