//! RPC-backed stand-in for `litesvm::LiteSVM` so the percolator-lean svm-runner
//! suites can run unmodified-in-spirit against a real cluster (devnet).
//!
//! Semantics vs LiteSVM:
//! - send_transaction: simulate at `processed`; on simulated error return Err WITHOUT
//!   sending (expected-rejection checks are therefore simulation-against-live-devnet);
//!   on success, send (skip_preflight), wait for `confirmed`, and report the CU from
//!   the simulation. An on-chain failure after a successful simulation is an Err.
//! - set_account is not available: accounts are created for real (system
//!   create_account, SPL InitializeMint2 / InitializeAccount3 / MintTo).
//! - Slots: logical slots from the suite are mapped to real slots with a dilation
//!   factor K (env LEAN_DEVNET_DILATION, default 16): set_slot(s) waits until the real
//!   slot is >= base + K*(s - last_logical) + 1, where base = max(real slot when the
//!   previous set_slot returned, slot of the last landed tx). Market staleness/exit
//!   windows and the adapter maxFeedAge are scaled by K in main.rs to match.

use std::{
    cell::RefCell,
    collections::HashMap,
    thread::sleep,
    time::{Duration, Instant},
};

use solana_account::Account;
use solana_address::Address;
use solana_commitment_config::CommitmentConfig;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::config::{RpcSendTransactionConfig, RpcSimulateTransactionConfig};
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const SYSTEM_PROGRAM_ID: Address = Address::from_str_const("11111111111111111111111111111111");
pub const TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

pub struct TxMeta {
    pub compute_units_consumed: u64,
}

pub struct Chain {
    rpc: RpcClient,
    pub funder: Keypair,
    cache: RefCell<HashMap<Address, Option<Account>>>,
    pub dilation: u64,
    logical: u64,
    base_real: u64,
    last_tx_slot: u64,
    last_bh: RefCell<Hash>,
    pub big_recipient: Option<Address>,
    pub sent: u64,
    pub simulated: u64,
    pub lamports_spent_start: u64,
}

fn retry<T, E: std::fmt::Debug>(what: &str, mut f: impl FnMut() -> Result<T, E>) -> T {
    let mut delay = 250u64;
    for attempt in 0..12 {
        match f() {
            Ok(v) => return v,
            Err(e) => {
                if attempt == 11 {
                    panic!("RPC {} failed after retries: {:?}", what, e);
                }
                sleep(Duration::from_millis(delay));
                delay = (delay * 2).min(5_000);
            }
        }
    }
    unreachable!()
}

impl Chain {
    pub fn from_env() -> Self {
        let url = std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".into());
        assert!(
            !url.contains("mainnet"),
            "refusing to run the lean devnet suite against a mainnet RPC: {}",
            url
        );
        let kp_path = std::env::var("FUNDER_KEYPAIR")
            .unwrap_or_else(|_| format!("{}/.config/solana/id.json", std::env::var("HOME").unwrap()));
        let bytes: Vec<u8> = {
            let s = std::fs::read_to_string(&kp_path).expect("read funder keypair");
            s.trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .split(',')
                .map(|x| x.trim().parse::<u8>().expect("keypair byte"))
                .collect()
        };
        let funder = Keypair::try_from(bytes.as_slice()).expect("funder keypair");
        let dilation = std::env::var("LEAN_DEVNET_DILATION").ok().and_then(|v| v.parse().ok()).unwrap_or(16);
        let rpc = RpcClient::new_with_commitment(url, CommitmentConfig::confirmed());
        let bal = retry("get_balance", || rpc.get_balance(&funder.pubkey()));
        let mut c = Chain {
            rpc,
            funder,
            cache: RefCell::new(HashMap::new()),
            dilation,
            logical: 0,
            base_real: 0,
            last_tx_slot: 0,
            last_bh: RefCell::new(Hash::default()),
            big_recipient: None,
            sent: 0,
            simulated: 0,
            lamports_spent_start: bal,
        };
        c.base_real = c.real_slot();
        c
    }

    pub fn funder_balance(&self) -> u64 {
        retry("get_balance", || self.rpc.get_balance(&self.funder.pubkey()))
    }

    pub fn real_slot(&self) -> u64 {
        retry("get_slot", || self.rpc.get_slot_with_commitment(CommitmentConfig::processed()))
    }

    // ---------------------------------------------------------------- accounts
    pub fn get_account(&self, a: &Address) -> Option<Account> {
        if let Some(v) = self.cache.borrow().get(a) {
            return v.clone();
        }
        let v = retry("get_account", || {
            self.rpc.get_account_with_commitment(a, CommitmentConfig::confirmed())
        })
        .value;
        self.cache.borrow_mut().insert(*a, v.clone());
        v
    }

    pub fn prefetch(&self, addrs: &[Address]) {
        let missing: Vec<Address> = {
            let c = self.cache.borrow();
            addrs.iter().filter(|a| !c.contains_key(a)).cloned().collect()
        };
        for chunk in missing.chunks(100) {
            let res = retry("get_multiple_accounts", || {
                self.rpc.get_multiple_accounts_with_commitment(chunk, CommitmentConfig::confirmed())
            })
            .value;
            let mut c = self.cache.borrow_mut();
            for (a, v) in chunk.iter().zip(res.into_iter()) {
                c.insert(*a, v);
            }
        }
    }

    fn invalidate(&self) {
        self.cache.borrow_mut().clear();
    }

    // ---------------------------------------------------------------- blockhash
    /// Always returns a blockhash different from the previous call, so two
    /// byte-identical transactions are never sent (they'd be deduplicated).
    pub fn latest_blockhash(&self) -> Hash {
        let start = Instant::now();
        loop {
            let (bh, _) = retry("get_latest_blockhash", || {
                self.rpc.get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
            });
            if bh != *self.last_bh.borrow() || start.elapsed() > Duration::from_secs(5) {
                *self.last_bh.borrow_mut() = bh;
                return bh;
            }
            sleep(Duration::from_millis(150));
        }
    }

    pub fn expire_blockhash(&mut self) {}

    // ---------------------------------------------------------------- transactions
    pub fn send_transaction(&mut self, tx: Transaction) -> Result<TxMeta, String> {
        self.simulated += 1;
        let cfg = RpcSimulateTransactionConfig {
            sig_verify: false,
            replace_recent_blockhash: false,
            commitment: Some(CommitmentConfig::processed()),
            ..Default::default()
        };
        let sim = retry("simulate", || self.rpc.simulate_transaction_with_config(&tx, cfg.clone())).value;
        if let Some(err) = sim.err {
            let logs = sim.logs.unwrap_or_default();
            let tail: Vec<String> = logs.iter().rev().take(3).rev().cloned().collect();
            return Err(format!("{:?} | {}", err, tail.join(" / ")));
        }
        let cu = sim.units_consumed.unwrap_or(0);

        let send_cfg = RpcSendTransactionConfig { skip_preflight: true, max_retries: Some(0), ..Default::default() };
        let sig = retry("send", || self.rpc.send_transaction_with_config(&tx, send_cfg));
        self.sent += 1;
        let start = Instant::now();
        let mut last_resend = Instant::now();
        loop {
            let st = retry("get_signature_statuses", || self.rpc.get_signature_statuses(&[sig]));
            if let Some(Some(s)) = st.value.into_iter().next() {
                if s.satisfies_commitment(CommitmentConfig::confirmed()) {
                    self.invalidate();
                    self.last_tx_slot = self.last_tx_slot.max(s.slot);
                    return match s.err {
                        None => Ok(TxMeta { compute_units_consumed: cu }),
                        Some(e) => Err(format!("on-chain failure after successful simulation: {:?} (sig {})", e, sig)),
                    };
                }
            }
            if start.elapsed() > Duration::from_secs(75) {
                self.invalidate();
                return Err(format!("DROPPED: no confirmation for {} after 75s", sig));
            }
            if last_resend.elapsed() > Duration::from_secs(2) {
                let _ = self.rpc.send_transaction_with_config(&tx, send_cfg);
                last_resend = Instant::now();
            }
            sleep(Duration::from_millis(250));
        }
    }

    fn send_ixs(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Result<TxMeta, String> {
        let mut r = self.send_ixs_once(ixs, extra);
        for _ in 0..3 {
            match &r {
                Err(e) if e.starts_with("DROPPED") => r = self.send_ixs_once(ixs, extra),
                _ => break,
            }
        }
        r
    }

    fn send_ixs_once(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Result<TxMeta, String> {
        let bh = self.latest_blockhash();
        let msg = Message::new(ixs, Some(&self.funder.pubkey()));
        let funder = Keypair::try_from(self.funder.to_bytes().as_slice()).unwrap();
        let mut signers: Vec<&Keypair> = vec![&funder];
        signers.extend_from_slice(extra);
        let tx = Transaction::new(&signers, msg, bh);
        self.send_transaction(tx)
    }

    // ---------------------------------------------------------------- funding
    pub fn transfer(&mut self, to: &Address, lamports: u64) -> Result<(), String> {
        let ix = sys_transfer(&self.funder.pubkey(), to, lamports);
        self.send_ixs(&[ix], &[]).map(|_| ())
    }

    /// Replaces LiteSVM's free airdrop. Only `big_recipient` (the suite's fee payer,
    /// which also funds account creation through `funder`) gets real SOL; everyone
    /// else just needs a rent-exempt system account (some pay InitDex vault rent).
    pub fn airdrop(&mut self, to: &Address, _lamports: u64) -> Result<(), String> {
        let amt = if Some(*to) == self.big_recipient { 500_000_000 } else { 20_000_000 };
        self.transfer(to, amt)
    }

    // ---------------------------------------------------------------- account creation
    pub fn create_prog_acc(&mut self, owner: &Address, size: usize) -> Address {
        let kp = Keypair::new();
        let ix = sys_create_account(&self.funder.pubkey(), &kp.pubkey(), 10_000_000, size as u64, owner);
        self.send_ixs(&[ix], &[&kp]).unwrap_or_else(|e| panic!("create_prog_acc: {}", e));
        kp.pubkey()
    }

    pub fn create_mint(&mut self, decimals: u8) -> Address {
        let kp = Keypair::new();
        let rent = retry("rent", || self.rpc.get_minimum_balance_for_rent_exemption(82));
        let mut d = vec![20u8, decimals];
        d.extend_from_slice(self.funder.pubkey().as_ref());
        d.push(0);
        let ixs = [
            sys_create_account(&self.funder.pubkey(), &kp.pubkey(), rent, 82, &TOKEN_PROGRAM_ID),
            Instruction { program_id: TOKEN_PROGRAM_ID, accounts: vec![AccountMeta::new(kp.pubkey(), false)], data: d },
        ];
        self.send_ixs(&ixs, &[&kp]).unwrap_or_else(|e| panic!("create_mint: {}", e));
        kp.pubkey()
    }

    pub fn create_tok_acc(&mut self, mint: &Address, owner: &Address, amount: u64) -> Address {
        let kp = Keypair::new();
        let mut init = vec![18u8];
        init.extend_from_slice(owner.as_ref());
        let mut ixs = vec![
            sys_create_account(&self.funder.pubkey(), &kp.pubkey(), 2_039_280, 165, &TOKEN_PROGRAM_ID),
            Instruction {
                program_id: TOKEN_PROGRAM_ID,
                accounts: vec![AccountMeta::new(kp.pubkey(), false), AccountMeta::new_readonly(*mint, false)],
                data: init,
            },
        ];
        if amount > 0 {
            let mut m = vec![7u8];
            m.extend_from_slice(&amount.to_le_bytes());
            ixs.push(Instruction {
                program_id: TOKEN_PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(*mint, false),
                    AccountMeta::new(kp.pubkey(), false),
                    AccountMeta::new_readonly(self.funder.pubkey(), true),
                ],
                data: m,
            });
        }
        self.send_ixs(&ixs, &[&kp]).unwrap_or_else(|e| panic!("create_tok_acc: {}", e));
        kp.pubkey()
    }

    /// Writes a 32-byte FEED record into a mock_feed-owned account. `publishSlot`
    /// is the real current slot (the suite's logical slot has no meaning on devnet).
    pub fn write_feed(&mut self, mock_prog: &Address, feed: &Address, price: u64, conf: u64) {
        let pub_slot = self.real_slot();
        let mut d = vec![0u8; 32];
        d[0..4].copy_from_slice(&0x44454546u32.to_le_bytes());
        d[8..16].copy_from_slice(&price.to_le_bytes());
        d[16..24].copy_from_slice(&conf.to_le_bytes());
        d[24..32].copy_from_slice(&pub_slot.to_le_bytes());
        let ix = Instruction {
            program_id: *mock_prog,
            accounts: vec![AccountMeta::new(*feed, false), AccountMeta::new_readonly(self.funder.pubkey(), true)],
            data: d,
        };
        self.send_ixs(&[ix], &[]).unwrap_or_else(|e| panic!("write_feed: {}", e));
    }

    // ---------------------------------------------------------------- time
    pub fn logical_slot(&self) -> u64 {
        self.logical
    }

    pub fn set_slot(&mut self, slot: u64) {
        if self.logical == 0 {
            self.logical = slot;
            self.base_real = self.real_slot().max(self.last_tx_slot);
            return;
        }
        let delta = slot.saturating_sub(self.logical);
        let base = self.base_real.max(self.last_tx_slot);
        // Δ<=1 steps only need a fresh slot (same-slot oracle guard); windows are
        // only ever *exceeded* by multi-slot jumps, which get the full K*Δ wait.
        let wait = if delta <= 1 { delta } else { self.dilation * delta };
        let target = base + wait + 1;
        loop {
            let now = self.real_slot();
            if now >= target {
                self.base_real = now;
                break;
            }
            let remaining = target - now;
            sleep(Duration::from_millis((remaining * 350).clamp(100, 2_000)));
        }
        self.logical = slot;
        self.invalidate();
    }

    pub fn dil(&self) -> u64 {
        self.dilation
    }
}

pub fn sys_create_account(from: &Address, new: &Address, lamports: u64, space: u64, owner: &Address) -> Instruction {
    let mut d = vec![0u8; 52];
    d[0..4].copy_from_slice(&0u32.to_le_bytes());
    d[4..12].copy_from_slice(&lamports.to_le_bytes());
    d[12..20].copy_from_slice(&space.to_le_bytes());
    d[20..52].copy_from_slice(owner.as_ref());
    Instruction {
        program_id: SYSTEM_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*new, true)],
        data: d,
    }
}

pub fn sys_transfer(from: &Address, to: &Address, lamports: u64) -> Instruction {
    let mut d = vec![0u8; 12];
    d[0..4].copy_from_slice(&2u32.to_le_bytes());
    d[4..12].copy_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: SYSTEM_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
        data: d,
    }
}
