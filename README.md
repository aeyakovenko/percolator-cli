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

Create a config file at `~/.config/percolator-cli.json`:

```json
{
  "rpcUrl": "https://api.devnet.solana.com",
  "programId": "2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp",
  "walletPath": "~/.config/solana/id.json"
}
```

Or use command-line flags:
- `--rpc <url>` - Solana RPC endpoint
- `--program <pubkey>` - Percolator program ID
- `--wallet <path>` - Path to keypair file
- `--json` - Output in JSON format
- `--simulate` - Simulate transaction without sending

## Mainnet Bounty 7 — STOXX/SOL single-asset (v16 `marketauth`-collapse layout, LIVE)

> **Status (2026-06-03, LIVE):** single-asset perpetuals market — STOXX50 priced
> in SOL via a 3-leg Pyth composite (STOXX·EUR × EUR/USD ÷ SOL/USD, inverted).
> 20× leverage, wSOL collateral, `HYBRID_AFTER_HOURS` oracle mode so the EWMA
> carries the mark when STOXX is closed. New layout (commit `792256b` collapsed
> the 7 market-level authorities into a single `marketauth`; commit `dba87a9`
> unified asset 0 with assets 1..N): the market account is **2,955 B / 0.0215
> SOL rent** instead of the old 116 KB / 2.06 SOL — 99× cheaper.
>
> (The previous 3-asset `BhkMic5g…` bounty market was wound down 2026-06-03
> via the `unsafe_forced_close` admin escape hatch, recovering +6.576 SOL from
> every old-layout zombie account under PROG including the long-stranded
> AWCZ2pK dust and the 2026-05-26 attacker husk `8oYjDr2…`. See *Deprecated*
> below.)

**On-chain addresses**

```
Program:       4m3ipBQDYX6JQ9YSmUXDjESDHMtGWtiXforkWr9Qoxdi   (v16 program, marketauth layout)
Market:        4AXbMuJzrUv5KtVs6zc5jDtXTB4XKhKtEBGU6BmkVut4   (STOXX/SOL, launched 2026-06-03)
Vault PDA:     84o6UPbT4WbhYiK3aWFWCwBeMDc79zB7rbY8fY8Nby53
Collateral:    So11111111111111111111111111111111111111112   (wSOL)
marketauth:    A3Mu2nQdjJXhJkuUDBbF2BdvgDs5KodNE9XsetXNMrCK   (admin; single collapsed key)
Keeper key:    9WiMAQtdx8zXMovePuaZ7v472UsFgZ7vkL7rr7APuxBQ   (dedicated; dormant-when-empty)
Keeper pf:     9cQXfQcu5sTf4fZBSJs5hHSMkqpUrN8AynoAkafkBShz
Insurance:     0 SOL (not seeded at launch)
Matcher:       (none — bilateral TradeNoCpi only on this market)
Manifest:      mainnet-stoxx-sol-market.json
```

**Asset 0 — STOXX/SOL** (the only asset; this is a single-asset market)

| | Pyth feed | PriceUpdateV2 account |
|---|---|---|
| leg 0 | STOXX50·EUR  `dd08f0a4…` | `C2Cf16vF6LX8GrWJwfZga5z5tjVsax5VWnL2T7Q8CF91` |
| leg 1 | EUR/USD      `a995d00b…` | `Fu76ChamBDjE8UuGLV6GP2AcPPSU6gjhkNhAyuoPm7ny` |
| leg 2 | SOL/USD      `ef0d8b6f…` | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |

Composite formula: `STOXX·EUR × EUR/USD ÷ SOL/USD` (via `oracle_leg_flags =
DIVIDE_LEG3 = 0x02`), then **inverted** so SOL is the base unit. At launch
(slot `424152688`) the EWMA seeded at `mark_ewma_e6 = 961,571` = **0.9616
SOL per STOXX share** (STOXX ~$72, SOL ~$69 → 1.04 STOXX/SOL inverted).

`oracle_mode = HYBRID_AFTER_HOURS` (mode 1). When all legs are fresh inside
`max_staleness_secs` the engine reads the composite oracle; when any leg
goes stale (STOXX overnight + weekends), it falls back to the EWMA mark.
SOL/USD is kept fresh by Pyth's sponsored shard-0 crank; STOXX·EUR + EUR/USD
are self-pushed by the keeper from `hermes.pyth.network` during EU market
hours (Eurex 07:00–22:00 UTC Mon–Fri) via the local `pyth-pusher` subprocess.

**Build provenance**

```
BPF binary SHA-256:   5b9464a53ed25d84fe1bd657ffbb50e94246465490323a783ab6e25135edbfe3
BPF binary size:      956,592 bytes ELF
percolator-prog:      9343dad  (Cover backing fee policy count liveness; sits on
                       top of 294079f 'Cover invalid domain public calls' +
                       de85ee9 'Cover batch backing fee policy gate' + two real
                       behavior changes: ac4d3bc 'Reject cross-market liquidation
                       rewards' and b5f69a1 'Reject cross-market maintenance cranker
                       rewards'. src/v16_program.rs +70 / -35 LoC. Layout unchanged
                       from 70294cb.)
prior:                198651f / BPF c3ec9493… / 956,104 B (deployed 2026-06-04 evening,
                       superseded same day — fixed c050578's try_empty stack
                       overflow by bumping engine to 08ebb7f)
                      c050578 / BPF 11eafaf1… / 952,544 B (had try_empty warning)
                      0a631cf / BPF b0cc3f80… / 952,272 B (deployed 2026-06-04)
                      70294cb / BPF 1aedbfa2… / 918,184 B (deployed 2026-06-03)
engine pin:           08ebb7f  (Reduce v16 account init stack usage — unchanged from
                       198651f. Engine HEAD 1487d50 is a proof commit the wrapper
                       has not yet bumped to.)
Layout:               marketauth-collapse (commit 792256b)
                      + asset-0 unified with assets 1..N (commit dba87a9)
                      WrapperConfigV16  = 432 B  (was 624 B; 7 keys → 1 marketauth)
                      MarketGroupHeader = 710 B  (was 638 B; engine accounting block)
                      PortfolioAccount  = 9,195 B  (was 22,379 B; source-domain claims
                                          compacted into a 32-slot × 196 B inline array)
                      DEFAULT_MARKET_SLOT_CAPACITY = 1  (market reallocs on asset activate)
MARKET_ACCOUNT_LEN:   2,955 B for a 1-slot market = 448 (header+config)
                                                 + 710 (MG header)
                                                 + 1 × 1,797 (slot stride: 512 oracle + 1,285 engine)
```

Verify locally:

```bash
git clone https://github.com/aeyakovenko/percolator-prog.git
cd percolator-prog && git checkout 9343dad
cargo build-sbf --tools-version v1.52
sha256sum target/deploy/percolator_prog.so
#   Expected: 5b9464a53ed25d84fe1bd657ffbb50e94246465490323a783ab6e25135edbfe3

solana program dump -u m 4m3ipBQDYX6JQ9YSmUXDjESDHMtGWtiXforkWr9Qoxdi /tmp/deployed.so
head -c 956592 /tmp/deployed.so | sha256sum   # must match
```

**Configuration**

| Param | Value | Notes |
|---|---|---|
| `mm` / `im` (margin) | 500 bps / 500 bps | 20× nominal leverage, no opening buffer |
| `max_price_move_bps_per_slot` | 49 | §1.4 envelope at mm=500 + max_accrual_dt=10 |
| `max_accrual_dt_slots` | 10 | per-crank accrual step; keeper targets ≤20 slots gap (2 cranks/cycle) |
| `h_min` / `h_max` | 0 / 6_480_000 | up to ~30 d profit maturity |
| `max_trading_fee_bps` | 10,000 | hybrid mode cap (100%) |
| `trade_fee_base_bps` | 1 | hybrid base; +EWMA movement bps off-hours |
| `liquidation_fee_bps` | 5 | 0.05% per liq, capped at 50 SOL |
| `min_nonzero_mm_req` / `_im_req` | 500 / 600 | exact-N proof room |
| `min_liquidation_abs` | 0 | no per-call dust floor |
| `permissionless_resolve_stale_slots` | 6,480,000 (~30 d) | survives any multi-day market closure |
| `force_close_delay_slots` | 216,000 (~24 h) | post-resolve grace |
| `maintenance_fee_per_slot` | 35 lamports | ≈ **$0.50/day** account hold (SOL ≈ $69 at launch) |
| `permissionless_market_init_fee` | 7,500,000 lamports | ≈ **$0.50** to permissionlessly append a new asset slot |
| `max_staleness_secs` | 259,200 (3 d) | covers weekend STOXX gaps; HYBRID_AFTER_HOURS falls back to EWMA past this |
| `hybrid_soft_stale_slots` | 200 | soft-stale window before EWMA-only fallback inside max_staleness |
| `mark_ewma_halflife_slots` | 300 | EWMA half-life ≈ 2 min |
| `insurance_withdraw_max_bps` | 5,000 | 50% per-window withdraw cap |
| `insurance_withdraw_cooldown_slots` | 216,000 (~24 h) | between withdraws |
| Insurance seed | **0 SOL** | not seeded yet at launch — top up via `TopUpInsurance` / `TopUpInsuranceDomain` |

### Trading

`InitPortfolio` + `Deposit` are cheap (rent ~0.065 SOL + tx fees); there is
no per-account creation fee on this market (the `newAccountFee` field was
removed in the new layout). Bilateral `TradeNoCpi` works without a matcher;
both sides simply sign.

Before a trade the asset must be cranked up to within `max_accrual_dt`
slots of the current slot. The keeper does this when there are positions
open; users entering against an idle market can self-crank by packing one or
more `PermissionlessCrank action:0` ixs into their own trade tx.

### Keeper — dormant-when-empty

`scripts/mainnet-stoxx-sol-keeper.ts` (cron wrapper:
`scripts/stoxx-sol-keeper-cron.sh`) runs **once per minute** on the
dedicated keeper key. It costs roughly nothing when the market is empty:

| state | cranks/cycle | cost |
|---|---|---|
| **DORMANT** — no portfolios with capital, gap < `HEARTBEAT_SLOTS` (5M slots ≈ 23 d) | 0 | 0 SOL/day |
| **DORMANT heartbeat** — gap > `HEARTBEAT_SLOTS` | 1 | ~12 cranks/year → effectively 0 |
| **ACTIVE** — any portfolio has capital | up to 9 in one tx | 5,000 lamports/tick × 1,440/day = **0.0072 SOL/day ≈ \$0.50/day** |

Active-state cranking pulls the engine's `asset.slot_last` back to within
`TARGET_GAP=20` slots of the clock — even though the on-chain
`max_accrual_dt_slots=10` cap means each crank only advances 10 slots, the
script packs `ceil(gap / max_accrual_dt) + 1` cranks per tick. Zero priority
fee — only the 5,000 lamport base fee.

The keeper also self-pushes STOXX·EUR + EUR/USD from Pyth Hermes via the
local `~/pyth-pusher` subprocess **only** when the market is active (or
heartbeating). Off-hours dormancy doesn't push anything.

Cron entry (single line; the wrapper exports PATH + cd's into the repo):

```cron
* * * * * /bin/sh /home/anatoly/percolator-cli/scripts/stoxx-sol-keeper-cron.sh # percolator-stoxx-sol-keeper
```

Log: `~/.cache/percolator/stoxx-sol-keeper.log`.

### Bounty win condition

Cause `group.insurance` on `4AXbMuJzrUv5…` to drop below its current value
via any sequence of public-instruction calls. Pyth manipulation and Solana
validator attacks are out of scope; admission bypass, K overflow, ADL math,
conservation violation, fee-credits sign flip, stale-mark arb exceeding fee
mechanics, mark-EWMA exploitation, and the 3-leg oracle composition
(`DIVIDE_LEG3 + invert`) are all in scope. (No insurance seeded yet at
launch — top up via `TopUpInsurance` is the prerequisite to any drain
attempt being profitable.)

---


## Deprecated: Mainnet Bounty 6 — 3-asset USD/STOXX/BTC bounty (wound down)

> **Status (2026-06-03):** the v16 multi-market bounty-6 (`BhkMic5g…`, 3 assets,
> on the pre-`marketauth` 116 KB layout) was wound down + drained via the
> `unsafe_forced_close` admin escape hatch. Insurance + vault residue, every
> portfolio, the 2026-05-26 attacker husk `8oYjDr2…`, and the long-stranded
> dust-pathology husk `AWCZ2pK…` all rent-reclaimed (+6.576 SOL total). The
> old keeper portfolio `5iWTBYod…` is gone. See Bounty 7 above.

---

## Deprecated: Mainnet Bounty 5 v1 — STOXX/SOL single-market (wound down)

> **Status (2026-05-25):** the v1 bounty-5 (single STOXX50/SOL market, slab
> `DV4QaQapFp94FjFA8kfXTXo3oe9sGv1wwaszakHjg7hP` under the pre-v16 program
> `4ToDRrQW5j3oeQm8uTAwV9Rp6NhYfH5E5hMKcXkqfwfz`) was resolved at the fair mark
> `1.209466` and wound down — force-close the 3 accounts → `WithdrawInsurance` →
> `CloseSlab` → unwrap, recovering **~17.85 SOL** to admin. The `4ToDRrQW…` program
> is **retired**; the live bounty (now Bounty 6) runs as the v16 multi-market group on
> `4m3ipBQDYX6JQ9YSmUXDjESDHMtGWtiXforkWr9Qoxdi` (see the LIVE section above).
> `permissionless_resolve_stale_slots` on v1 was the full ~30 d, so the slab stayed
> crankable until wind-down.

## Deprecated: Mainnet Bounty 4 (wound down)

> **Status (2026-05-15):** Bounty 4 (slab
> `GSAT5fTCUgB9sMMTBsVzhvALbkSv6p9CifWmShHf92hj`) auto-resolved on
> 2026-05-14 ~11:25 UTC after ~3.5 h of trading by hunters (3 paired
> positions, balanced OI ~$15, $5 SOL insurance fully intact, no socialized
> loss). The trigger was a `KeeperCrank` invocation that satisfied the
> engine's `BelowProgressFloor` permissionless-recovery gate even though
> the market was solvent — see `/tmp/bug.md` for the forensic report.
>
> Root cause: `bounded_price_step_cap_abs(now_slot) == 0` when `now_slot
> == engine.current_slot`, which can happen for same-slot duplicate cranks
> in cron traffic. The fix (`d76ea67 Prevent same-slot target-lag
> recovery` on percolator-prog) makes the wrapper withhold the recovery
> target when `crank_slot <= engine.last_market_slot`, disarming the gate
> for healthy markets.
>
> Wind-down (2026-05-15): WithdrawInsurance + CloseSlab recovered
> ~17.3 SOL (5.12 insurance + 12.22 slab rent) to the deployer. No user
> SOL was lost — hunters were force-closed at the EWMA terminal price
> with `h_num == h_den` (ratio 1.0). The program ID
> `4ToDRrQW5j3oeQm8uTAwV9Rp6NhYfH5E5hMKcXkqfwfz` was **upgraded in place**
> to wrapper `d76ea67` for bounty 5 — the BPF binary and program data
> address are unchanged, only the program code reflects the fix.

---

## Deprecated: Mainnet Bounty 3 (wound down)

> **Status (2026-05-13):** Bounty 3 (`2LfCFmDKwcnHunqdsCW9uV7KNgBgnFGASs8uM7MwHgHm`)
> went into a Resolved state on 2026-05-07 after maintenance fees consumed
> a tester's capital faster than the cron tick (at the time, 1 crank/min)
> could accrue. Conservation held — no insurance loss. The slab was force-
> closed, insurance withdrawn, program retired via `solana program close`;
> ~21 SOL recovered to the deployer. The program ID is permanently
> retired. New participants target Bounty 6 above.

```
Program:        2LfCFmDKwcnHunqdsCW9uV7KNgBgnFGASs8uM7MwHgHm  (RETIRED via program close)
Slab:           zExGagF9FeMTYGjvkBhknmNzLAP7toX6Aj6Pu1kuvmT  (closed)
BPF SHA-256:    6e2bb5aee602aed1de0b2d80f72f97b6b115e0f536438f76d31e0de06d5b7002
percolator-prog: 04b854e
engine pin:     5059332f8a6ce7e8dcff83315e90ac8e2ced7d42
Lesson:         single-crank-per-minute cron can't keep up with
                MAX_ACCRUAL_DT_SLOTS=10 when OI>0. Bounty 4/5 use the
                4-second inner-loop pattern instead.
```

---

## Deprecated: Mainnet Bounty 2

> **Status (2026-05-05):** Bounty 2 superseded by Bounty 3 (then 4). All
> four market authorities + program upgrade authority BURNED. The market
> remains tradable against the deployed binary; new participants should
> target Bounty 6 above.

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
percolator-cli close-account --slab <pubkey> --idx <n>
```

### LP Operations

```bash
# Initialize LP account
percolator-cli init-lp --slab <pubkey>

# Trade with CPI (matcher)
percolator-cli trade-cpi --slab <pubkey> --user-idx <n> --lp-idx <n> \
  --size <i128> --matcher-program <pubkey> --matcher-ctx <pubkey>
```

### Keeper Operations

```bash
# Crank the keeper (liquidations are processed automatically during crank)
percolator-cli keeper-crank --slab <pubkey> --nonce <n> --oracle <pubkey>
```

### Admin Operations

```bash
# Update admin
percolator-cli update-admin --slab <pubkey> --new-admin <pubkey>

# Top up insurance fund
percolator-cli topup-insurance --slab <pubkey> --amount <lamports>

# Update market configuration (funding and threshold params)
percolator-cli update-config --slab <pubkey> \
  --funding-horizon-slots <n> \
  --funding-k-bps <n> \
  --funding-scale-notional-e6 <n> \
  --funding-max-premium-bps <n> \
  --funding-max-bps-per-slot <n> \
  --thresh-floor <n> \
  --thresh-risk-bps <n> \
  --thresh-update-interval-slots <n> \
  --thresh-step-bps <n> \
  --thresh-alpha-bps <n> \
  --thresh-min <n> \
  --thresh-max <n> \
  --thresh-min-step <n>
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
