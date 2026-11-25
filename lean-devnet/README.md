# lean-devnet — percolator-lean devnet harness

Devnet deployment and test tooling for the percolator-lean v2 programs
(Lean 4 → sBPF via lean-svm). Program ids, ELF hashes and the source commit
are in `../lean-devnet.json`; the TS client is `src/lean/` (import
`percolator-cli/lean`).

| Path | What |
|---|---|
| `runner/` | The percolator-lean LiteSVM suite (`svm-runner/src/main.rs`) ported to run against devnet over RPC. `port.py` regenerates `src/main.rs` from the pinned upstream source; `src/chain.rs` is the RPC stand-in for `LiteSVM`. |
| `mock-feed/` | Tiny devnet-only program that owns a writable 32-byte `FEED` record, used by the oracle-adapter suite (LiteSVM wrote the feed with `set_account`). |
| `*.so` | Copies of the deployed ELFs (gitignored). |

## Running

```bash
# full suites 1-9 (≈45 min; the 1000-step fuzzer dominates)
SOLANA_RPC_URL=https://api.devnet.solana.com ./runner/target/release/lean-devnet-runner percolator.so matcher.so oracle_adapter.so
# skip the fuzzer
LEAN_SKIP_FUZZ=1 ./runner/target/release/lean-devnet-runner ...
# TS client smoke (every encoder) and read-only invariant survey
pnpm test:lean
pnpm lean:survey
```

The runner refuses a mainnet RPC URL; the TS scripts check the devnet genesis hash.

## How the port differs from LiteSVM

- **Rejections are checked in simulation.** Expected failures are
  simulated against live devnet state and never sent. The rejection reason
  is printed for each one (`[reject] label -> error`).
- **CU numbers come from simulation.**
- **Accounts are created for real.** That covers system `create_account`,
  SPL mint, token accounts and `MintTo`. Account addresses are new keypairs.
- **Time is scaled by K.** Logical slots map to real slots with
  `LEAN_DEVNET_DILATION` K (default 16). Market `exitWindow`/`maxStaleness`
  and the adapter's `maxFeedAge` are multiplied by K. Δ≤1 steps only wait
  for a fresh slot, and multi-slot jumps wait K·Δ.
- **Legs are refreshed automatically.** Trade and Withdraw need every
  open leg refreshed in the current slot, and consecutive steps land in
  different slots on devnet. So success-path Trade, Withdraw and matcher
  Fill/WithdrawLp calls get `RefreshLeg` prepended for each open leg.
  Expected-failure paths are left alone. This inflates the reported CU for
  those instructions.
- **Same-slot oracle spam (5a)** is tested as a single transaction with
  two updates, asserting `Custom(126)` on instruction 1.
- **Vault pre-funding** sends 890,880 lamports (the rent-exempt minimum).
  LiteSVM sends 1, which a real cluster rejects.
- **Dropped transactions** are rebuilt with a fresh blockhash and resent.
