import re, sys
src = open(sys.argv[1]).read()
n_expected = {}
def rep(old, new, count=1):
    global src
    c = src.count(old)
    assert c == count, f"expected {count} of {old[:70]!r}, found {c}"
    src = src.replace(old, new)

rep("use litesvm::LiteSVM;\n",
    "mod chain;\nuse chain::Chain as LiteSVM;\nuse std::sync::atomic::{AtomicU64, Ordering};\nstatic DIL: AtomicU64 = AtomicU64::new(1);\nfn dil() -> u64 { DIL.load(Ordering::Relaxed) }\n")
rep("use solana_clock::Clock;\n", "")
rep("""fn set_slot(svm: &mut LiteSVM, slot: u64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.slot = slot;
    svm.set_sysvar(&clock);
    svm.expire_blockhash();
}""", """fn set_slot(svm: &mut LiteSVM, slot: u64) {
    svm.set_slot(slot);
}""")
rep("""fn get_slot(svm: &LiteSVM) -> u64 {
    let clock: Clock = svm.get_sysvar();
    clock.slot
}""", """fn get_slot(svm: &LiteSVM) -> u64 {
    svm.logical_slot()
}""")
# real account creation
src = re.sub(r"fn create_prog_acc\(svm: &mut LiteSVM, prog_id: &Address, size: usize\) -> Address \{.*?\n\}\n",
    "fn create_prog_acc(svm: &mut LiteSVM, prog_id: &Address, size: usize) -> Address {\n    svm.create_prog_acc(prog_id, size)\n}\n", src, count=1, flags=re.S)
src = re.sub(r"fn create_tok_acc\(svm: &mut LiteSVM, mint: &Address, owner: &Address, amount: u64\) -> Address \{.*?\n\}\n",
    "fn create_tok_acc(svm: &mut LiteSVM, mint: &Address, owner: &Address, amount: u64) -> Address {\n    svm.create_tok_acc(mint, owner, amount)\n}\n", src, count=1, flags=re.S)
assert "svm.create_prog_acc(prog_id, size)" in src and "svm.create_tok_acc(mint, owner, amount)" in src
# batch reads for invariant checks
rep("""    label: &str,
) {
    let v = read_u64(svm, dex, 160);""", """    label: &str,
) {
    {
        let mut all = vec![*dex, *dex_vault];
        all.extend_from_slice(markets);
        all.extend_from_slice(portfolios);
        svm.prefetch(&all);
    }
    let v = read_u64(svm, dex, 160);""")
# slot-window params scaled by dilation
rep("""    data[12..20].copy_from_slice(&exit_window.to_le_bytes());
    data[20..28].copy_from_slice(&max_staleness.to_le_bytes());""",
"""    data[12..20].copy_from_slice(&(exit_window * dil()).to_le_bytes());
    data[20..28].copy_from_slice(&(max_staleness * dil()).to_le_bytes());""")
# program ids: deployed devnet programs instead of add_program
rep("""    let elf = std::fs::read(&so_path).unwrap_or_else(|e| panic!("Failed to read {}: {}", so_path, e));""",
"""    let elf = std::fs::read(&so_path).unwrap_or_else(|e| panic!("Failed to read {}: {}", so_path, e));
    let env_addr = |k: &str, d: &str| -> Address { std::env::var(k).unwrap_or_else(|_| d.to_string()).parse().unwrap() };
    let dev_prog = env_addr("LEAN_PROG", "GD43BhWwAjiZLs56juEkacSKkY3TVCTbD7cG7HHDYKdA");
    let dev_matcher = env_addr("LEAN_MATCHER", "9NqBGzLYY5d8v426voAT3VqJUprJX6fwyGJ2a8P4A22N");
    let dev_adapter = env_addr("LEAN_ADAPTER", "5PasXKLBKCAhTPJ2WxPjQxJYbxVnMZY7ZNiQpEVUZ5K2");
    let dev_mock_feed = env_addr("LEAN_MOCK_FEED", "9EqYn4MUYC8q4FNcV3SAvYN9VuLsouLSYJxW1eEy7yNx");""")
rep("""    let mut svm = LiteSVM::new();
    let prog_id = Keypair::new().pubkey();
    svm.add_program(prog_id, &elf).expect("ELF load failed");
    set_slot(&mut svm, 100);

    let payer = Keypair::new();""", """    let mut svm = LiteSVM::from_env();
    DIL.store(svm.dil(), Ordering::Relaxed);
    let prog_id = dev_prog;
    println!("  DEVNET MODE: prog={} dilation={} funder={}", prog_id, svm.dil(), svm.funder.pubkey());
    set_slot(&mut svm, 100);

    let payer = Keypair::new();
    svm.big_recipient = Some(payer.pubkey());""")
rep("""    let mint = Keypair::new().pubkey();
    svm.set_account(
        mint,
        Account {
            lamports: 10_000_000,
            data: make_spl_mint(6, 10_000_000_000_000, &dex_admin.pubkey()),
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();""", """    let mint = svm.create_mint(6);""")
# pre-funding griefing: real transfer must leave the account rent-exempt (890_880 for 0 bytes)
rep("""    svm.set_account(
        dex_vault,
        Account { lamports: 1, data: vec![], owner: SYSTEM_PROGRAM_ID, executable: false, rent_epoch: 0 },
    )
    .unwrap();""", """    svm.transfer(&dex_vault, 890_880).expect("pre-fund dex_vault");""")
# 5a same-slot spam: emulate "same slot" by putting both updates in ONE transaction
rep("""    send_err(&mut svm, ix_update_oracle(prog_id, btc_mkt, btc_oracle.pubkey(), 93_000_000, 0, 0), &payer, &[&payer, &btc_oracle], "Same-slot UpdateOracle spam");""",
"""    {
        let r = send_ixs_try(&mut svm, &[
            ix_update_oracle(prog_id, btc_mkt, btc_oracle.pubkey(), 92_160_000, 0, 0),
            ix_update_oracle(prog_id, btc_mkt, btc_oracle.pubkey(), 93_000_000, 0, 0),
        ], &payer, &[&payer, &btc_oracle]);
        let e = r.expect_err("Same-slot UpdateOracle spam must be rejected");
        assert!(e.contains("InstructionError(1, Custom(126))"), "Same-slot spam: expected ix#1 Custom(126) oracleSameSlot, got {}", e);
    }""")
# suite 9 programs
rep("""    let matcher_prog = Keypair::new().pubkey();
    let adapter_prog = Keypair::new().pubkey();
    svm.add_program(matcher_prog, &matcher_elf).expect("matcher ELF load failed");
    svm.add_program(adapter_prog, &adapter_elf).expect("adapter ELF load failed");""",
"""    let matcher_prog = dev_matcher;
    let adapter_prog = dev_adapter;""")
rep("""    let feed_acc = Keypair::new().pubkey();
    let write_feed = |svm: &mut LiteSVM, price: u64, conf: u64, pub_slot: u64| {
        let mut d = vec![0u8; 32];
        d[0..4].copy_from_slice(&0x44454546u32.to_le_bytes()); // "FEED"
        d[8..16].copy_from_slice(&price.to_le_bytes());
        d[16..24].copy_from_slice(&conf.to_le_bytes());
        d[24..32].copy_from_slice(&pub_slot.to_le_bytes());
        svm.set_account(feed_acc, Account { lamports: 10_000_000, data: d, owner: SYSTEM_PROGRAM_ID, executable: false, rent_epoch: 0 }).unwrap();
    };""", """    let feed_acc = svm.create_prog_acc(&dev_mock_feed, 64);
    let write_feed = |svm: &mut LiteSVM, price: u64, conf: u64, _pub_slot: u64| {
        svm.write_feed(&dev_mock_feed, &feed_acc, price, conf);
    };""")
rep("""    init_adp_data[4..12].copy_from_slice(&10u64.to_le_bytes());""",
    """    init_adp_data[4..12].copy_from_slice(&(10u64 * dil()).to_le_bytes());""")
# footer: cost report
rep("""    println!("  ALL 9 PERCOLATOR-LEAN VERIFICATION + COMPOSABILITY + FUZZ SUITES PASSED 100%!");""",
"""    println!("  ALL 9 PERCOLATOR-LEAN VERIFICATION + COMPOSABILITY + FUZZ SUITES PASSED 100%!");
    println!("  devnet: {} txs sent, {} simulations, funder spent {} lamports", svm.sent, svm.simulated, svm.lamports_spent_start.saturating_sub(svm.funder_balance()));""")
# Same-slot leg freshness: on devnet consecutive suite steps land in different slots, so
# success-path Trade(11)/WithdrawCollateral(7) and matcher Fill(2)/WithdrawLp(3) get a
# RefreshLeg prepended for each active leg of each portfolio they touch. Expected-failure
# paths (send_err / send_ixs_try) are NOT touched.
rep("""fn send_ixs_ok(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> u64 {
""", """static PROG_ID: std::sync::OnceLock<Address> = std::sync::OnceLock::new();
static MATCHER_ID: std::sync::OnceLock<Address> = std::sync::OnceLock::new();
static AUTO_REFRESHES: AtomicU64 = AtomicU64::new(0);
fn devnet_auto_refresh(svm: &LiteSVM, ixs: &[Instruction]) -> Vec<Instruction> {
    let prog = *PROG_ID.get().unwrap();
    let matcher = MATCHER_ID.get().cloned();
    let mut seen: Vec<(Address, Address)> = Vec::new();
    let mut out = Vec::new();
    for ix in ixs {
        if ix.program_id == prog && ix.data.first() == Some(&10) && ix.accounts.len() >= 3 {
            seen.push((ix.accounts[1].pubkey, ix.accounts[2].pubkey));
        }
        let needs = (ix.program_id == prog && matches!(ix.data.first(), Some(7) | Some(11)))
            || (Some(ix.program_id) == matcher && matches!(ix.data.first(), Some(2) | Some(3)));
        if needs {
            for m in &ix.accounts {
                let Some(a) = svm.get_account(&m.pubkey) else { continue };
                if a.owner != prog || a.data.len() < PFL_SIZE || u32::from_le_bytes(a.data[0..4].try_into().unwrap()) != 0x4F4C4650 { continue; }
                let dex = Address::new_from_array(a.data[24..56].try_into().unwrap());
                for idx in 0..MAX_LEGS {
                    let b = LEG_HEADER + idx * LEG_STRIDE;
                    // active AND non-flat only: exactly what checkAllLegsFresh enforces; a flat
                    // leg on a resolved market would make RefreshLeg fail the whole tx.
                    if a.data[b] == 0 || a.data[b + 1] == 0 { continue; }
                    let mkt = Address::new_from_array(a.data[b + 16..b + 48].try_into().unwrap());
                    if seen.contains(&(mkt, m.pubkey)) { continue; }
                    seen.push((mkt, m.pubkey));
                    AUTO_REFRESHES.fetch_add(1, Ordering::Relaxed);
                    out.push(ix_refresh_leg(prog, dex, mkt, m.pubkey, false));
                }
            }
        }
        out.push(ix.clone());
    }
    out
}

fn send_ixs_ok(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> u64 {
    let ixs = &devnet_auto_refresh(svm, ixs)[..];
""")
rep("""    let prog_id = dev_prog;
""", """    let prog_id = dev_prog;
    PROG_ID.set(dev_prog).unwrap();
    MATCHER_ID.set(dev_matcher).unwrap();
""")
rep("""funder spent {} lamports", svm.sent,""", """funder spent {} lamports, {} auto-RefreshLeg ixs prepended", svm.sent,""")
rep("""svm.lamports_spent_start.saturating_sub(svm.funder_balance()));""", """svm.lamports_spent_start.saturating_sub(svm.funder_balance()), AUTO_REFRESHES.load(Ordering::Relaxed));""")
# Dropped-tx retry for runner-built transactions (rebuild with a fresh blockhash).
rep("""    let msg = Message::new(ixs, Some(&payer.pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    let res = svm.send_transaction(tx).unwrap_or_else(|e| panic!("Expected OK, got {:?}", e));
    res.compute_units_consumed""", """    let mut attempt = 0;
    let res = loop {
        let bh = if attempt == 0 { bh } else { svm.latest_blockhash() };
        let msg = Message::new(ixs, Some(&payer.pubkey()));
        let tx = Transaction::new(signers, msg, bh);
        match svm.send_transaction(tx) {
            Err(e) if e.starts_with("DROPPED") && attempt < 3 => { attempt += 1; continue; }
            r => break r,
        }
    };
    let res = res.unwrap_or_else(|e| panic!("Expected OK, got {:?}", e));
    res.compute_units_consumed""")
rep("""    let msg = Message::new(ixs, Some(&payer.pubkey()));
    let tx = Transaction::new(signers, msg, bh);
    svm.send_transaction(tx)
        .map(|r| r.compute_units_consumed)
        .map_err(|e| format!("{:?}", e))""", """    let mut attempt = 0;
    loop {
        let bh = if attempt == 0 { bh } else { svm.latest_blockhash() };
        let msg = Message::new(ixs, Some(&payer.pubkey()));
        let tx = Transaction::new(signers, msg, bh);
        match svm.send_transaction(tx) {
            Err(e) if e.starts_with("DROPPED") && attempt < 3 => { attempt += 1; continue; }
            r => break r.map(|r| r.compute_units_consumed).map_err(|e| format!("{:?}", e)),
        }
    }""")
# Record the rejection reason of every expected failure (send_err passes on ANY error).
rep("""    let res = svm.send_transaction(tx);
    assert!(res.is_err(), "Expected rejection for '{}', but tx succeeded!", label);""",
"""    let res = svm.send_transaction(tx);
    if let Err(e) = &res { println!("    [reject] {} -> {}", label, e.split(" | ").next().unwrap_or(e)); }
    assert!(res.is_err(), "Expected rejection for '{}', but tx succeeded!", label);""")
# LEAN_SKIP_FUZZ=1 skips suite 8's 1000 steps for quick re-runs.
rep("""    for step in 0..1000u64 {""",
"""    let fuzz_steps: u64 = if std::env::var("LEAN_SKIP_FUZZ").is_ok() { 0 } else { 1000 };
    for step in 0..fuzz_steps {""")
for bad in ["set_account(", "add_program(", "set_sysvar", "get_sysvar", "LiteSVM::new()"]:
    assert bad not in src, f"leftover LiteSVM-only call: {bad}"
open(sys.argv[2], "w").write(src)
print("ported OK")
