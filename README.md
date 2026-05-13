# percolator-cli

Command-line interface for interacting with the Percolator perpetuals protocol on Solana.

## Related Repositories

- [percolator](https://github.com/aeyakovenko/percolator) - Risk engine library
- [percolator-prog](https://github.com/aeyakovenko/percolator-prog) - Main Percolator program (Solana smart contract)
- [percolator-match](https://github.com/aeyakovenko/percolator-match) - Passive LP matcher program (50bps spread)
- [percolator-stake](https://github.com/dcccrypto/percolator-stake) - Staking integration
- [percolator-stress-test](https://github.com/aeyakovenko/percolator-stress-test) - Stress testing suite

**Third-party repositories are community contributions. Do not trust — always verify. Review the code yourself before running or deploying anything.**

## Disclaimer

**FOR EDUCATIONAL PURPOSES ONLY**

This code has **NOT been audited**. Do NOT use in production or with real funds. The percolator program is experimental software provided for learning and testing purposes only. Use at your own risk.

## Installation

```bash
pnpm install
pnpm build
```

## Configuration

Create a config file named `percolator-cli.json` in the directory where you run
the CLI, or at `~/.config/percolator-cli.json`. You can also pass another path
explicitly with `--config <path>`.

```json
{
  "rpcUrl": "https://api.devnet.solana.com",
  "programId": "2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp",
  "wallet": "~/.config/solana/id.json",
  "commitment": "confirmed"
}
```

Or use command-line flags:
- `--config <path>` - Path to config file
- `--rpc <url>` - Solana RPC endpoint
- `--program <pubkey>` - Percolator program ID
- `--wallet <path>` - Path to keypair file
- `--commitment <level>` - Commitment level: `processed`, `confirmed`, or `finalized`
- `--json` - Output in JSON format
- `--simulate` - Simulate transaction without sending. This is the default for transaction commands.
- `--send` - Send a transaction instead of simulating it.
- `--yes-mainnet` - Allow `--send` when the RPC URL appears to target mainnet.

## Mainnet Bounty 3 — `bounty_sol_20x_max`

> **Status (2026-05-05, LIVE):** market deployed and ticking. Market authorities
> + program upgrade authority will be burned after the cron loop and
> market state are verified over the next 24h. The bounty pool spec is
> [`percolator-stress/max_risk.md`](https://github.com/aeyakovenko/percolator-stress-test/blob/master/max_risk.md).

```
Program:        2LfCFmDKwcnHunqdsCW9uV7KNgBgnFGASs8uM7MwHgHm
Slab:           zExGagF9FeMTYGjvkBhknmNzLAP7toX6Aj6Pu1kuvmT  (inverted SOL/USD, non-Hyperp)
Oracle:         7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE  (Pyth SOL/USD PriceUpdateV2, sponsored shard 0)
Feed ID:        ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
Vault ATA:      3Rgu8UqVKn71vbF91sk5bXZbrqJgpFfhZvJEpJtZgenA  (wrapped SOL, PDA-signed)
Vault PDA:      9kVocvX1RfGstC1U2xhtSjrHLJWivnw7RPv3Vi8aPkKs
Matcher:        (none — third parties provision their own)
Insurance:      5 SOL seeded at deploy
```

**Build provenance** (reproducible from `cargo build-sbf` on the pinned
commits below):

```
BPF binary SHA-256:  6e2bb5aee602aed1de0b2d80f72f97b6b115e0f536438f76d31e0de06d5b7002
BPF binary size:     518,896 bytes ELF (data length on chain)
percolator-prog:     04b854e (master) + Cargo.toml engine pin bump (uncommitted)
percolator (engine): 5059332f8a6ce7e8dcff83315e90ac8e2ced7d42   (pinned via Cargo.toml git rev)
percolator-cli:      <commit at deploy>
MAX_ACCOUNTS:        4096
```

The wrapper's only direct dependency that isn't a published crate is the
engine — pulled by Cargo.toml as
`percolator = { git = "https://github.com/aeyakovenko/percolator", rev = "5059332f…" }`.
The pinned `rev` makes `cargo build-sbf` deterministic across machines.

Verify locally:

```bash
# 1. Clone the program at the deployed commit.
git clone https://github.com/aeyakovenko/percolator-prog.git
cd percolator-prog
git checkout 04b854e   # then bump Cargo.toml engine rev to 5059332f8a6ce7e8dcff83315e90ac8e2ced7d42

# 2. Build (cargo will fetch the engine git dep at the pinned rev).
cargo build-sbf

# 3. Hash the ELF.
sha256sum target/deploy/percolator_prog.so
#   Expected: 6e2bb5aee602aed1de0b2d80f72f97b6b115e0f536438f76d31e0de06d5b7002

# 4. Hash the on-chain bytes.
solana program dump -u m 2LfCFmDKwcnHunqdsCW9uV7KNgBgnFGASs8uM7MwHgHm /tmp/deployed.so
head -c 518896 /tmp/deployed.so | sha256sum
#   Must match the cargo build-sbf hash exactly.
```

For an automated reproducibility check inside docker (OtterSec-style),
`solana-verify build --library-name percolator_prog` works against this
repo because the engine dep is fetched by `rev`, not by sibling-dir path.

**Configuration (max_risk.md verbatim where the v12.21 wrapper accepts it):**

| Param | Value | Notes |
|---|---|---|
| `mm` (maintenance margin) | 500 bps | = im, no opening buffer at max leverage |
| `im` (initial margin) | 500 bps | 1/L = 5% → 20x nominal max leverage |
| `max_price_move_bps_per_slot` | 49 | 99.2% of §1.4 envelope ceiling |
| `max_accrual_dt_slots` | 10 | wrapper-hardcoded |
| `h_min` | 0 | spec fast-path admission |
| `h_max` | 86_400 | ~9.6h profit maturity ceiling |
| `trading_fee` | 1 bp | undercuts every CEX/DEX globally |
| `liquidation_fee` | 5 bps | frees envelope budget for max_move |
| `min_nonzero_mm_req` / `min_nonzero_im_req` | 500 / 600 | exact-N proof room |
| `min_liquidation_abs` | 0 | no per-call dust floor |
| `liquidation_fee_cap` | 50 × 10⁹ | $50K cap (atomic, pegged) |
| `permissionless_resolve_stale_slots` | 432_000 (~48 h) | matches deprecated v1 mainnet |
| `force_close_delay_slots` | 432_000 (~48 h) | post-resolve grace |
| `new_account_fee` | 5_882_000 lamports (~$0.50) | bounty pool top-up |
| `maintenance_fee_per_slot` | 58 lamports | ~$1/day flat (SOL @ ~$85) |
| `tvl_insurance_cap_mult` | 50 | deposit cap = 50× insurance |
| Insurance seed | 5 SOL | bounty target; grows with adoption |

**Operational keepalive** — cron runs `mainnet-bounty3-tick.ts` every
minute. Each tick takes a slab snapshot, submits a permissionless
`KeeperCrank`, takes a second snapshot, and writes one JSONL line to
`~/.cache/percolator/bounty3-tick.log` with deltas and event flags.

Watched flags (any appearing in the log = page on-call):

- `INSURANCE_DROP` — bounty hit candidate, investigate immediately
- `CONSERVATION_BROKEN` — vault SPL ≠ engine.vault, deeper bug
- `ACCOUNTING_BROKEN` — vault < cTot + insurance
- `ACCRUE_LAG(>600 sl)` — cranker is broken; > 4 minute gap
- `SIDE_MODE_NON_NORMAL` — liquidation cascade in progress
- `PRICE_MOVE_SAT(consumed=…)` — price-move-consumption threshold tripped
- `ACCOUNT_OPENED` / `ACCOUNT_CLOSED` — informational

Install/refresh cron after the setup script lands:

```bash
SOLANA_RPC_URL=https://your.rpc/ npx tsx scripts/mainnet-bounty3-cron-install.ts
tail -f ~/.cache/percolator/bounty3-tick.log
```

**Bounty win condition** (per max_risk.md §8): cause
`engine.insurance_fund.balance` to decrease below its current value via
any sequence of public calls. Pyth manipulation and Solana validator
attacks are out of scope; everything else (admission bypass, K overflow,
ADL math, conservation violation, fee-credits sign flip, etc.) is in.

---

## Deprecated: Mainnet Bounty 2 (superseded by Bounty 3 above)

> **Status (2026-05-05):** Bounty 2 has been superseded by Bounty 3 (above)
> with the same `bounty_sol_20x_max` spec, refreshed engine pin, and
> `tvl_insurance_cap_mult` raised from 20 to 50. The Bounty 2 market is
> still live on chain with all four market authorities + program upgrade
> authority BURNED. Withdraw paths and the bounty win condition still
> hold against the deployed Bounty 2 binary, but new participants should
> target Bounty 3.

```
Program:        6qWZvUtfyShbxTQkwjCayk3LuGqTGJwBo2QfkePK5jdJ  (upgrade authority BURNED)
Slab:           CJKBStEn5VXEF9VNTChKKb5YW84MV7LycqMMziVuxJSc  (all 4 market auths BURNED)
Oracle:         7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE
Vault ATA:      DVTjorxLQvdtoTmDarSHGBox4VCUPb9QQkDjz8mSUxor
Vault PDA:      FLnTKmFAtD3z3tTZj2Nyx52DRVwEzGz5ERwnPdK4ewR9
BPF SHA-256:    7c5b75aff1bd2a3f9ea145b63ee74a0c55d3af50922e802dac63388ef0639d1e
percolator-prog: c6e61e6ce0557163eb621a3329abc50d3952be8a
engine pin:     5940285737b514af4416cd8394773abc79e6366d
```

---

## Deprecated: v12.20 Mainnet (sunset)

> **Status (2026-04-22):** the v12.20 mainnet test market below is being
> sunset. Live state is left running for transparency; new development
> targets the v12.21 devnet market in the next section. The CLI on this
> branch (`master`) parses the v12.21 wire format and is **not**
> backwards-compatible with the v12.20 slab — checkout commit
> `74e902f1` if you need to interact with the deprecated mainnet market.

```
Program:     BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw  (upgrade authority BURNED)
Slab:        5ZamUkAiXtvYQijNiRcuGaea66TVbbTPusHfwMX1kTqB  (inverted SOL/USD, all 3 market auths BURNED)
Oracle:      7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE  (Pyth SOL/USD PriceUpdateV2, sponsored shard 0)
Feed ID:     ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
Vault ATA:   AcJsfpbuUKHHdoqPuLccRsK794nHecM1XKySE6Umefvr  (wrapped SOL, PDA-signed)
Matcher:     (none — third parties provision their own)
```

**On-chain provenance** (the bytes anyone can dump and hash today):

```
On-chain SHA-256:    502088e9cf5e1b38cccd31bbab2df18d4958712fb9456d48669241aaddf4cc93
On-chain size:       395,368 bytes (output of `solana program dump`)
percolator-prog:     06f86fb125525af81c0bfd19a295095dda102c07
percolator (engine): 3f55f871a3aa29d7b582fc2641d2106cbac0c32e
percolator-cli:      74e902f165dcac98c87eb80406a2a92a40cf8dc7
MAX_ACCOUNTS:        4096
Upgrade authority:   BURNED (--final at deploy time)
```

Verify locally: `solana program dump -u m BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw /tmp/mainnet.so && sha256sum /tmp/mainnet.so` — must output the SHA above.

To prove the deployed bytes correspond to the named commits, clone the repos at those commits and run `cargo build-sbf`, then compare the resulting `target/deploy/percolator_prog.so` against the on-chain dump (see "Reproducing the binary from source" below). The build is not a deterministic Docker reproducible build — the on-chain SHA is the authoritative artifact.

### Reproducing the binary from source

The program cannot use the standard `solana-verify` / OtterSec automated flow because `percolator-prog/Cargo.toml` uses `percolator = { path = "../percolator" }` — a sibling-dir path dep. Docker sandboxes that clone only one repo can't resolve it. Reproducing locally is straightforward:

```bash
# 1. Clone both repos as siblings at the deployed commits
mkdir percolator-build && cd percolator-build
git clone https://github.com/aeyakovenko/percolator.git
git clone https://github.com/aeyakovenko/percolator-prog.git
( cd percolator      && git checkout 3f55f871a3aa29d7b582fc2641d2106cbac0c32e )
( cd percolator-prog && git checkout 06f86fb125525af81c0bfd19a295095dda102c07 )

# 2. Build with default features (MAX_ACCOUNTS=4096).
#    Requires solana CLI 1.18+ toolchain for SBF.
cd percolator-prog
cargo build-sbf

# 3. Hash the locally built ELF.
sha256sum target/deploy/percolator_prog.so
#   Record this hash.

# 4. Hash the on-chain bytes and compare.
solana program dump -u m BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw /tmp/deployed.so
sha256sum /tmp/deployed.so
#   Expected (on-chain): 502088e9cf5e1b38cccd31bbab2df18d4958712fb9456d48669241aaddf4cc93
#   The local-build hash from step 3 must equal this for byte-identical
#   provenance. `solana program dump` returns the raw on-chain ELF
#   (no padding stripping needed); if the local build differs in size,
#   the toolchain version drifted from the original deploy.
```

The two hashes matching proves the deployed program is byte-identical to the commits named above. If they don't match, the most common cause is a different `solana-cli` / `cargo build-sbf` toolchain version than was used at deploy time — try matching the build environment of the original deployer.

> Future deploys that want the automated OtterSec badge should vendor the engine crate into `percolator-prog/engine/` as a git submodule (or via a crates.io release) so the build is self-contained from one repo clone.

**Configuration:**
- Inverted (mark = SOL per USD), wSOL collateral, unit_scale=0 (1 lamport = 1 engine unit)
- Insurance fund: 5 SOL (≈ $435 at init, SOL=$87.32)
- `tvlInsuranceCapMult = 20` → max `c_tot` = 100 SOL (≈ $8,700), grows as insurance grows from new-account fees
- `maintenanceFeePerSlot = 265` lamports → ~0.0572 SOL/day/account ≈ **$5/day at SOL=$87**
- `new_account_fee = 57_000_000` lamports ≈ **$5 per `InitUser` / `InitLP`** (all routed to insurance)
- `permissionlessResolveStaleSlots = 432_000` (~48 h) + `forceCloseDelaySlots = 432_000` (~48 h) = **auto-shutdown on 48 h oracle silence**
- `maxStalenessSecs = 60` (Pyth sponsor posts every ~2 s, so this is very loose)
- 5× leverage (20% IM / 10% MM)
- No LP → no trading yet. Third-party matcher deployers create their own matcher program and call `InitLP` (anyone can — no admin gate on the LP slot).

### Hourly Crank

A permissionless keeper crank runs once per hour via cron (see `scripts/mainnet-crank.ts`). This keeps the market inside the 48 h staleness window and advances funding/accounting. Anyone can run it with their own wallet — it's a free tx signature (~5000 lamports) with no reward since it's permissionless:

```bash
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  npx tsx scripts/mainnet-crank.ts
```

Example crontab entry (adjust paths for your system):

```cron
0 * * * * cd /path/to/percolator-cli && SOLANA_RPC_URL=https://api.mainnet-beta.solana.com /path/to/npx tsx scripts/mainnet-crank.ts >> mainnet-crank.log 2>&1
```

The script reads the manifest at `mainnet-market.json`, so dropping a copy of that file next to the script on any host is enough to run an independent keeper.

## Devnet (v12.21, current)

```
Program:        2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp (percolator-prog, v12.21)
Matcher:        4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy (percolator-match, ABI v2)
Slab:           52e67qT6aUiP41CR2JaZQfSAkbZr5MTTZUeYWWwb2zCN (admin-free inverted SOL/USD, Chainlink)
Chainlink:      99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR (SOL/USD)
```

**Build provenance** (deployed program SHA matches local `cargo build-sbf` byte-for-byte):

```
BPF binary SHA-256:  51008b3d16986adac08e276a3a3e683787a5372ed1dc84af43fd89b1343d0501
BPF binary size:     447,520 bytes ELF
percolator-prog:     de98bf203ee8df383a0181ae7ed0dccc1867db27
percolator (engine): 5940285737b514af4416cd8394773abc79e6366d
MAX_ACCOUNTS:        4096
```

### v12.21 highlights

- **MarketConfig** lost `oracle_price_cap_e2bps` + `min_oracle_price_cap_e2bps` (16 bytes); gained `oracle_target_price_e6` + `oracle_target_publish_time` and a 1-byte `insurance_withdraw_deposits_only` flag. CONFIG_LEN: 400 → 384.
- **RiskParams** wire still 160 bytes: `max_crank_staleness_slots` is read+discarded, replaced by `max_price_move_bps_per_slot` (must be > 0, enforces §1.4 solvency envelope).
- **Engine `MAX_ACCRUAL_DT_SLOTS = 100`** (was 10 000 000). Hard cap: `permissionlessResolveStaleSlots ≤ 100`, **and** `h_max ≤ permissionlessResolveStaleSlots`. Effective auto-shutdown window is **~40 sec**, so a continuous (sub-40 s) cranker is mandatory once a market has any traffic.
- **InitMarket account list shrank to 6** keys: `[admin, slab, mint, vault, clock, oracle]`. Token program / rent / system program are no longer passed.
- **SetOraclePriceCap (tag 18) removed.** Authority rotations still go through `UpdateAuthority` (tag 32).
- **Conf filter** must be in `[50, 1000]` bps; oracle staleness must be in `(0, 600]` seconds.

### On-chain layout (BPF)

```
SLAB_LEN        1_525_624 bytes     (unchanged — engine grew +16 to offset MarketConfig shrink)
HEADER_LEN      136                 (admin + insurance_authority + insurance_operator)
CONFIG_LEN      384                 (v12.21: -16 vs v12.20)
ENGINE_OFF      520                 = align_up(136 + 384, 8)
ENGINE_LEN      1_492_176           (+16 vs v12.20: rr_cursor + sweep_generation + price_move_consumed)
ACCOUNT_SIZE    360                 (unchanged)
MAX_ACCOUNTS    4096                (configurable via `small`/`medium` cargo features)
```

The parser in `src/solana/slab.ts` derives the MAX_ACCOUNTS-dependent offsets from the slab account data length, so small, medium, and full deployments parse transparently.

### Instruction set (v12.21)

Removed since v12.18: `SetRiskThreshold`, `UpdateAdmin` (tag 12), `SetMaintenanceFee`, `SetOracleAuthority` (tag 16), `SetInsuranceWithdrawPolicy`, `QueryLpFees`. v12.21 also drops `SetOraclePriceCap` (tag 18). All four authority roles (admin, hyperp_mark, insurance, insurance_operator) are rotated via `UpdateAuthority { kind, new_pubkey }` (tag 32). `CatchupAccrue` (tag 31) and `WithdrawInsuranceLimited` (tag 23, gated on `insurance_operator`) remain.

### Create a Test Market

```bash
npx tsx scripts/setup-devnet-market.ts
```

### Preflight Test (93 checks)

```bash
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY npx tsx tests/preflight.ts
```

See [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md) for full coverage details (198+ automated checks).

### Keeper Crank

Risk-increasing trades require a recent keeper crank (within 200 slots).

```bash
percolator-cli keeper-crank --slab <slab-pubkey> --oracle <oracle-pubkey>
```

## Adding Your Own Matcher

Matchers are programs that determine trade pricing. The 50bps passive matcher accepts all trades at oracle price ± 50bps spread. You can create custom matchers with different pricing logic.

### Matcher Interface

A matcher program must implement:

1. **Init instruction** (tag `0x02`): Initialize context with LP PDA for security
2. **Match instruction** (tag `0x00`): Called by percolator during `trade-cpi`

### Security Requirements

**CRITICAL**: The matcher program MUST error if the LP PDA is not a signer. The percolator program signs the LP PDA via `invoke_signed` during CPI. If your matcher accepts unsigned calls, attackers can bypass LP authorization and steal funds. Always check `lp_pda.is_signer` and return `MissingRequiredSignature` if false.

The matcher context must also store the LP PDA and verify it matches on every trade call. This prevents unauthorized programs from using your matcher.

### Creating a Custom Matcher

#### Step 1: Write the matcher program

```rust
use solana_program::{account_info::AccountInfo, entrypoint, program_error::ProgramError, pubkey::Pubkey};

entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
    match data[0] {
        0x00 => {
            // Match instruction - MUST verify LP PDA signature
            let lp_pda = &accounts[0];
            let ctx = &accounts[1];

            // Verify LP PDA is a signer (signed by percolator via CPI)
            if !lp_pda.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }

            // Verify LP PDA matches stored PDA in context
            let ctx_data = ctx.try_borrow_data()?;
            let stored_pda = Pubkey::new_from_array(ctx_data[16..48].try_into().unwrap());
            if *lp_pda.key != stored_pda {
                return Err(ProgramError::InvalidAccountData);
            }

            // Process trade...
            Ok(())
        }
        0x02 => {
            // Init instruction - store LP PDA for verification
            let lp_pda = &accounts[0];
            let ctx = &accounts[1];

            // Store LP PDA in context at offset 16
            let mut ctx_data = ctx.try_borrow_mut_data()?;
            ctx_data[16..48].copy_from_slice(&lp_pda.key.to_bytes());
            Ok(())
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
```

#### Step 2: Create LP with ATOMIC transaction

**CRITICAL**: You must create the matcher context AND initialize the LP in a single atomic transaction. This prevents race conditions where an attacker could initialize your context with their LP PDA.

```typescript
// Find the FIRST FREE slot (match percolator's bitmap scan)
const usedSet = new Set(parseUsedIndices(slabData));
let lpIndex = 0;
while (usedSet.has(lpIndex)) {
  lpIndex++;
}

// Derive LP PDA for the index we'll create
const [lpPda] = deriveLpPda(PROGRAM_ID, SLAB, lpIndex);

// ATOMIC: All three in ONE transaction
const atomicTx = new Transaction().add(
  // 1. Create matcher context account
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: matcherCtxKp.publicKey,
    lamports: rent,
    space: 320,
    programId: MATCHER_PROGRAM_ID,
  }),
  // 2. Initialize matcher context WITH LP PDA
  {
    programId: MATCHER_PROGRAM_ID,
    keys: [
      { pubkey: lpPda, isSigner: false, isWritable: false },
      { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
    ],
    data: initMatcherData,
  },
  // 3. Initialize LP in percolator
  buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData })
);
await sendAndConfirmTransaction(conn, atomicTx, [payer, matcherCtxKp]);
```

#### Step 3: Deposit collateral to LP

```bash
percolator-cli deposit \
  --slab <slab-pubkey> \
  --user-idx <lp-idx> \
  --amount <amount>
```

### Matcher Context Layout (Unified Version 3)

The current matcher uses this unified context layout:

```
Offset  Size  Field                    Description
0       8     magic                    0x5045_5243_4d41_5443 ("PERCMATC")
8       4     version                  3
12      1     kind                     0=Passive, 1=vAMM
13      3     _pad0
16      32    lp_pda                   LP PDA for signature verification
48      4     trading_fee_bps          Fee on fills
52      4     base_spread_bps          Minimum spread
56      4     max_total_bps            Cap on total cost
60      4     impact_k_bps             Impact multiplier
64      16    liquidity_notional_e6    Quoting depth (u128)
80      16    max_fill_abs             Max fill per trade (u128)
96      16    inventory_base           LP inventory state (i128)
112     8     last_oracle_price_e6     Last oracle price
120     8     last_exec_price_e6       Last execution price
128     16    max_inventory_abs        Inventory limit (u128)
144     112   _reserved
```

The context data starts at offset 64 in the 320-byte account (first 64 bytes reserved for matcher return data).

## Commands Reference

### Market Operations

```bash
# Initialize a new market (see init-market --help for all params)
percolator-cli init-market --slab <pubkey> --mint <pubkey> --vault <pubkey> \
  --index-feed-id <hex> --max-staleness-secs <n> --conf-filter-bps <n> ...

# View slab state
percolator-cli slab:get --slab <pubkey>
percolator-cli slab:header --slab <pubkey>
percolator-cli slab:config --slab <pubkey>
percolator-cli slab:nonce --slab <pubkey>
```

### User Operations

```bash
# Initialize user account
percolator-cli init-user --slab <pubkey>

# Deposit collateral
percolator-cli deposit --slab <pubkey> --user-idx <n> --amount <lamports>

# Withdraw collateral
percolator-cli withdraw --slab <pubkey> --user-idx <n> --amount <lamports>

# Trade (no CPI)
percolator-cli trade-nocpi --slab <pubkey> --user-idx <n> --lp-idx <n> \
  --size <i128> --oracle <pubkey>

# Close account
percolator-cli close-account --slab <pubkey> --user-idx <n> --oracle <pubkey>
```

### LP Operations

```bash
# Initialize LP account
percolator-cli init-lp --slab <pubkey>

# Trade with CPI (matcher)
percolator-cli trade-cpi --slab <pubkey> --user-idx <n> --lp-idx <n> \
  --size <i128> --matcher-program <pubkey> --matcher-context <pubkey> \
  --limit-price-e6 <n> --oracle <pubkey>
```

### Keeper Operations

```bash
# Crank the keeper (liquidations are processed automatically during crank)
percolator-cli keeper-crank --slab <pubkey> --oracle <pubkey> \
  --caller-idx <n> --compute-units <n>
```

### Admin Operations

```bash
# Update admin
percolator-cli update-admin --slab <pubkey> --new-admin <pubkey>

# Top up insurance fund
percolator-cli topup-insurance --slab <pubkey> --amount <lamports>

# Update market configuration (funding and TVL cap params).
# Omitted flags keep their current on-chain values.
percolator-cli update-config --slab <pubkey> \
  --funding-horizon-slots <n> \
  --funding-k-bps <n> \
  --funding-max-premium-bps <n> \
  --funding-max-e9-per-slot <n> \
  --tvl-insurance-cap-mult <n> \
  --oracle <pubkey>
```

### Oracle Authority (Admin Only)

The oracle authority feature allows the admin to push prices directly instead of relying on Chainlink. This is useful for testing scenarios like flash crashes, ADL triggers, and stress testing.

```bash
# Set oracle authority (admin only)
percolator-cli set-oracle-authority --slab <pubkey> --authority <pubkey>

# Push oracle price (authority signer required)
# Price is in USD (e.g., 143.50 for $143.50)
percolator-cli push-oracle-price --slab <pubkey> --price <usd>

# Disable oracle authority (reverts to Chainlink)
percolator-cli set-oracle-authority --slab <pubkey> --authority 11111111111111111111111111111111
```

**Security Notes:**
- Only the market admin can set the oracle authority
- Only the designated authority can push prices
- Zero price (0) is rejected to prevent division-by-zero attacks
- Setting authority to the zero address disables the feature

## Testing

```bash
# Unit tests (offline)
pnpm test

# Preflight — 93 checks across 25 sections, 3 market types
# Behavioral correctness + conservation invariants
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY npx tsx tests/preflight.ts

# Live state verification — 100 checks, exhaustive before/after state diffs
# Verifies exact field deltas on every instruction (deposit, trade, crank, etc.)
npx tsx scripts/live-verify.ts

# Integration tests (T1-T22, needs SOLANA_RPC_URL)
npx tsx tests/runner.ts
```

See [DEPLOY_CHECKLIST.md](DEPLOY_CHECKLIST.md) for full coverage details (198+ automated checks).

## Scripts

### Market Setup

```bash
# Setup a new devnet market with funded LP and insurance
npx tsx scripts/setup-devnet-market.ts
```

### Bots

```bash
# Crank bot - runs continuous keeper cranks (every 5 seconds)
npx tsx scripts/crank-bot.ts

# Random traders bot - 5 traders making random trades with momentum bias
# Routes to best LP by simulated price (vAMM vs passive)
npx tsx scripts/random-traders.ts
```

### LP Setup

```bash
# Add a vAMM-configured LP (creates matcher context + LP account + deposits collateral)
npx tsx scripts/add-vamm-lp.ts
```

### Market Analysis

```bash
# Dump full market state to state.json (positions, margins, parameters)
npx tsx scripts/dump-state.ts

# Dump comprehensive market state to market.json (all on-chain fields)
npx tsx scripts/dump-market.ts

# Check liquidation risk for all accounts
npx tsx scripts/check-liquidation.ts

# Check funding rate status and accumulation
npx tsx scripts/check-funding.ts

# Display market risk parameters
npx tsx scripts/check-params.ts
```

### User Tools

```bash
# Find user account index by owner pubkey
npx tsx scripts/find-user.ts <slab_pubkey>                    # List all accounts
npx tsx scripts/find-user.ts <slab_pubkey> <owner_pubkey>     # Find specific account
```

### Stress Testing & Security

```bash
# Haircut-ratio system stress test - conservation, insurance, undercollateralization
npx tsx scripts/stress-haircut-system.ts

# Worst-case stress test - gap risk, insurance exhaustion, socialized losses
npx tsx scripts/stress-worst-case.ts

# Oracle authority stress test - tests price manipulation scenarios
npx tsx scripts/oracle-authority-stress.ts
npx tsx scripts/oracle-authority-stress.ts 0        # Run specific scenario by index
npx tsx scripts/oracle-authority-stress.ts --disable # Disable oracle authority after tests

# Pen-test oracle - comprehensive security testing
# Tests: flash crash, price edge cases, timestamp attacks, funding manipulation
npx tsx scripts/pentest-oracle.ts

# Protocol invariant tests
npx tsx scripts/test-price-profit.ts           # Price-profit relationship validation
npx tsx scripts/test-threshold-increase.ts     # Threshold auto-adjustment verification
npx tsx scripts/test-lp-profit-realize.ts      # LP profit realization and withdrawal
npx tsx scripts/test-profit-withdrawal.ts      # Profit withdrawal limit enforcement
```

### Configuration

```bash
# Update funding configuration parameters
npx tsx scripts/update-funding-config.ts
```

## Architecture

### Price Oracles

Percolator supports multiple oracle modes:

1. **Pyth** - Uses Pyth Network price feeds via PriceUpdateV2 accounts
2. **Chainlink** - Uses Chainlink OCR2 aggregator accounts
3. **Oracle Authority** - Admin-controlled price push for testing

The program auto-detects oracle type by checking the account owner. If an oracle authority is set and has pushed a price, that price is used instead of Pyth/Chainlink.

**Oracle Authority Priority:**
1. If `oracle_authority != 0` AND `authority_price_e6 != 0` AND timestamp is recent: use authority price
2. Otherwise: fall back to Pyth/Chainlink

### Inverted Markets

Inverted markets use `1/price` internally. This is useful for markets like SOL/USD where you want SOL-denominated collateral and let users take long/short USD positions. Going long = long USD (profit if SOL drops), going short = short USD (profit if SOL rises).

### Matchers

Matchers are external programs that determine trade pricing. The `percolator-match` program supports two modes:

**Passive Mode** (mode=0): Fixed spread around oracle price
- Simple bid/ask spread (e.g., 50bps = 0.5%)
- No price impact based on trade size

**vAMM Mode** (mode=1): Spread + impact pricing
- `trading_fee_bps`: Fee charged on every fill (e.g., 5 = 0.05%)
- `base_spread_bps`: Minimum spread (e.g., 10 = 0.10%)
- `impact_k_bps`: Price impact at full liquidity utilization
- `max_total_bps`: Cap on total cost (spread + impact + fee)
- `liquidity_notional_e6`: Quoting depth for impact calculation

The random-traders bot routes to the LP with the best simulated price, computing quotes using each LP's matcher parameters.

## License

Apache 2.0 - see [LICENSE](LICENSE)
