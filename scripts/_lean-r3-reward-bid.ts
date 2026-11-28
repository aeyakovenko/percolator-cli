/** EV+ lazy bidder for the round-3.1 wSOL buy-and-burn reward auction.
 *  Runs one full epoch (StartEpoch -> SubmitBid -> SettleEpoch -> ClaimQuote) ONLY when it is
 *  net profitable: picks the profit-maximizing wSOL bid b* = sqrt(Q*Beff*1e3/P) - Beff
 *  where Beff = Bvirt + existingBids (payout = Q*b/(b+Beff)), and fires only if
 *  claimed USDC - burned wSOL - epoch rent >= MIN_NET_USD.
 *  Dry by default (prints the decision, no tx). Pass --live to execute. bidder = funder. */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
  NATIVE_MINT, getAccount, TokenAccountNotFoundError, TokenInvalidAccountOwnerError,
} from "@solana/spl-token";
import bs58 from "bs58";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  rewardStartEpoch, rewardSubmitBid, rewardSettleEpoch, rewardClaimQuote, deriveDexVault,
  accountKind, parseMarket, parseRewardCfg, parseEpochState, parseBidReceipt,
  EPOCH_SIZE, BIDDER_SIZE, type RewardCfg,
} from "../src/lean/index.js";

const U = (n: bigint) => (Number(n) / 1e6).toFixed(6);
export const MIN_NET_USD = 0.20;        // require at least this much net profit to bother
export const EPOCH_RENT_SOL = 0.0016;   // ~rent for the per-epoch 104B account (non-recovered)

/** `SettleEpoch` zeroes `activeQuote` without clearing `activeEpochAcc`; `activeQuote > 0` is the real guard. */
export function isRewardEpochActive(cfg: Pick<RewardCfg, "activeQuote">): boolean {
  return cfg.activeQuote > 0n;
}

/** Profit-maximizing wSOL bid accounting for both `bVirt` and any pre-existing `existingBids`. */
export function computeOptimalBid(
  Q: bigint, bVirt: bigint, existingBids: bigint, solPriceUsd: number, epochRentSol = EPOCH_RENT_SOL,
): { bStar: bigint; payoutUsd: number; burnUsd: number; netUsd: number } {
  if (Q <= 0n || !Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    return { bStar: 0n, payoutUsd: 0, burnUsd: 0, netUsd: -epochRentSol * Math.max(0, solPriceUsd || 0) };
  }
  const bEff = bVirt + existingBids;
  if (bEff <= 0n) {
    return { bStar: 0n, payoutUsd: 0, burnUsd: 0, netUsd: -epochRentSol * solPriceUsd };
  }
  // d/db [Q*b/(b+Beff)/1e6 - b/1e9*P] = 0 -> b* = sqrt(Q*Beff*1e3/P) - Beff
  const bstarF = Math.sqrt(Number(Q) * Number(bEff) * 1000 / solPriceUsd) - Number(bEff);
  if (!Number.isFinite(bstarF) || bstarF < 1) {
    return { bStar: 0n, payoutUsd: 0, burnUsd: 0, netUsd: -epochRentSol * solPriceUsd };
  }
  const bStar = BigInt(Math.floor(bstarF));
  const payoutUsd = Number((Q * bStar) / (bStar + bEff)) / 1e6;
  const burnUsd = (Number(bStar) / 1e9) * solPriceUsd;
  const netUsd = payoutUsd - burnUsd - epochRentSol * solPriceUsd;
  return { bStar, payoutUsd, burnUsd, netUsd };
}

/** Enforce the minimum net return threshold on both pre-start and live-epoch bid decisions. */
export function shouldSubmitBid(est: { bStar: bigint; netUsd: number }, minNetUsd = MIN_NET_USD): boolean {
  return est.bStar > 0n && est.netUsd >= minNetUsd;
}

async function solPriceUsd(): Promise<number> {
  const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot");
  if (!r.ok) throw new Error(`coinbase SOL/USD HTTP ${r.status}`);
  const j: any = await r.json();
  const px = parseFloat(j?.data?.amount);
  if (!Number.isFinite(px) || px <= 0) throw new Error(`invalid SOL/USD price: ${j?.data?.amount}`);
  return px;
}

export interface PendingBidState {
  genesisHash?: string;
  cfg?: string;
  bidder?: string;
  epoch: string;
  bidReceipt?: string;
  startSig?: string;
  startLastValidBlockHeight?: number;
  stage: "started" | "bid";
}

/** Atomically replace `stateFile` via temp file + fsync + rename (never leaves truncated JSON). */
export function saveStateAtomic(stateFile: string, state: PendingBidState) {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, stateFile);
}

function clearState(stateFile: string) {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
}

/**
 * Read the initial SPL token balance before claiming:
 * returns `0n` ONLY when the token account is confirmed absent (`TokenAccountNotFoundError` /
 * `TokenInvalidAccountOwnerError`), and `null` on transient RPC failures so proceeds are never inflated.
 */
export async function readInitialTokenBalance(conn: Connection, ata: PublicKey): Promise<bigint | null> {
  try {
    return (await getAccount(conn, ata)).amount;
  } catch (e) {
    if (e instanceof TokenAccountNotFoundError || e instanceof TokenInvalidAccountOwnerError) {
      return 0n;
    }
    return null;
  }
}

/**
 * Hold an OS-managed advisory `flock(LOCK_EX | LOCK_NB)` on `${stateFile}.lock` directly owned
 * by this Node.js process's open file descriptor across reconciliation, bidding, and cleanup.
 * - Opens `fd` in Node.js, applies `flock(3, LOCK_EX | LOCK_NB)` via a short-lived one-shot helper
 *   inheriting `fd` on descriptor 3, and closes the helper immediately. Because `flock(2)` locks
 *   are bound to the open file description (OFD) on Linux and macOS, Node.js itself owns the lock
 *   for as long as `fd` remains open — no background helper process can die and drop the lock.
 * - Kernel releases the lock automatically on `fs.closeSync(fd)` OR `SIGKILL` of Node.js.
 * - Never unlinks `${stateFile}.lock` so all contenders lock the exact same inode.
 */
export async function withStateLock<T>(stateFile: string, fn: () => Promise<T>): Promise<T> {
  const lockFile = `${stateFile}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600);

  const backends: Array<[string, string[]]> = [
    ["flock", ["-E", "2", "-n", "3"]],
    [
      "perl",
      [
        "-e",
        'use Fcntl qw(:flock); open(my $fh, "+<&=", 3) or exit 3; flock($fh, LOCK_EX|LOCK_NB) or exit 2; exit 0;',
      ],
    ],
    [
      "python3",
      [
        "-c",
        "import fcntl, sys\ntry:\n fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError:\n sys.exit(2)\n",
      ],
    ],
  ];

  let acquired = false;
  try {
    for (const [cmd, args] of backends) {
      const res = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "ignore", fd] });
      if (res.error) continue;
      if (res.status === 0) {
        acquired = true;
        break;
      }
      if (res.status === 2) {
        throw new Error(`reward-bid keeper lock already held (${lockFile}); refusing overlapping run`);
      }
    }
    if (!acquired) {
      throw new Error(`unable to acquire OS flock for ${lockFile} (none of flock, perl, python3 available)`);
    }
    return await fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Send a transaction safely with confirmation-timeout recovery:
 * - Retains the locally signed bytes and rebroadcasts the EXACT same signature while its blockhash
 *   is still valid (`curHeight <= lastValidBlockHeight`), never signing a competing replacement early.
 * - Invokes `onSigned` BEFORE committing `pending` or broadcasting so a failed journal write can
 *   never leave signed bytes reusable on retry without persisted metadata.
 * - Supports `commitment: "finalized"` so cleanup paths wait for finalized confirmation/closure.
 * - Supports `refreshIxs` on post-expiry replacement so callers (e.g. oracle cranks) can re-read
 *   live state instead of re-signing a stale observation.
 * - Rechecks `alreadyLanded` even after a confirmed tx error (e.g. another keeper settled first).
 */
export async function sendIdempotent(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  opts: {
    alreadyLanded?: () => Promise<boolean>;
    onSigned?: (signed: { sig: string; blockhash: string; lastValidBlockHeight: number }) => void;
    refreshIxs?: () => Promise<TransactionInstruction[] | null>;
    commitment?: "confirmed" | "finalized";
    maxRetries?: number;
    retryDelayMs?: number;
  } = {},
): Promise<string | null> {
  const maxRetries = opts.maxRetries ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 2000;
  const commitment = opts.commitment ?? "confirmed";
  let curIxs = ixs;
  let pending: { raw: Buffer; sig: string; blockhash: string; lastValidBlockHeight: number } | undefined;

  const checkSig = async (sig: string): Promise<"done" | "awaiting_finality" | "failed" | "pending"> => {
    try {
      const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (!st) return "pending";
      if (st.err) return "failed";
      if (commitment === "finalized") {
        if (st.confirmationStatus === "finalized") return "done";
        if (st.confirmationStatus === "confirmed") return "awaiting_finality";
        return "pending";
      }
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return "done";
      return "pending";
    } catch {
      return "pending";
    }
  };

  for (let i = 0; ; i++) {
    try {
      let skipBroadcast = false;
      if (pending) {
        const status = await checkSig(pending.sig);
        if (status === "done") return pending.sig;
        if (status === "failed") {
          if (opts.alreadyLanded && await opts.alreadyLanded()) return pending.sig;
          const err = new Error(`tx ${pending.sig} failed on-chain`);
          (err as { nonRetryable?: boolean }).nonRetryable = true;
          throw err;
        }
        if (opts.alreadyLanded && await opts.alreadyLanded()) return pending.sig;
        if (status === "awaiting_finality") {
          skipBroadcast = true;
        } else {
          // Only discard `pending` and sign a fresh blockhash once the previous blockhash is expired at `commitment`
          const curHeight = await conn.getBlockHeight(commitment);
          if (curHeight > pending.lastValidBlockHeight) {
            const postExpiryStatus = await checkSig(pending.sig);
            if (postExpiryStatus === "done") return pending.sig;
            if (postExpiryStatus === "failed") {
              if (opts.alreadyLanded && await opts.alreadyLanded()) return pending.sig;
              const err = new Error(`tx ${pending.sig} failed on-chain`);
              (err as { nonRetryable?: boolean }).nonRetryable = true;
              throw err;
            }
            if (opts.alreadyLanded && await opts.alreadyLanded()) return pending.sig;
            if (postExpiryStatus === "awaiting_finality") {
              skipBroadcast = true;
            } else {
              if (opts.refreshIxs) {
                const refreshed = await opts.refreshIxs();
                if (!refreshed) return null;
                curIxs = refreshed;
              }
              pending = undefined;
            }
          }
        }
      } else if (opts.alreadyLanded && await opts.alreadyLanded()) {
        return null;
      }

      if (!pending) {
        const bh = await conn.getLatestBlockhash("confirmed");
        const tx = new Transaction({
          feePayer: signers[0].publicKey,
          blockhash: bh.blockhash,
          lastValidBlockHeight: bh.lastValidBlockHeight,
        }).add(...curIxs);
        tx.sign(...signers);
        const raw = tx.serialize();
        const sig = bs58.encode(tx.signature!);
        // Persist BEFORE assigning `pending` so a failed journal write can NEVER leave signed bytes
        // cached for a retry that skips persistence and broadcasts an unjournaled transaction.
        opts.onSigned?.({ sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight });
        pending = { raw, sig, ...bh };
      }
      if (!skipBroadcast) {
        await conn.sendRawTransaction(pending.raw);
      }
      const conf = await conn.confirmTransaction(
        { signature: pending.sig, blockhash: pending.blockhash, lastValidBlockHeight: pending.lastValidBlockHeight },
        commitment,
      );
      if (conf.value.err) {
        if (opts.alreadyLanded && await opts.alreadyLanded()) return pending.sig;
        const err = new Error(`tx ${pending.sig} failed: ${JSON.stringify(conf.value.err)}`);
        (err as { nonRetryable?: boolean }).nonRetryable = true;
        throw err;
      }
      return pending.sig;
    } catch (e) {
      if ((e as { nonRetryable?: boolean })?.nonRetryable) throw e;
      let alreadyLandedChecked = !opts.alreadyLanded;
      if (opts.alreadyLanded) {
        try {
          if (await opts.alreadyLanded()) return pending?.sig ?? null;
          alreadyLandedChecked = true;
        } catch {
          /* ignore transient RPC error so retry/backoff runs */
        }
      }
      if (pending) {
        const status = await checkSig(pending.sig);
        if (status === "done") return pending.sig;
        if (status === "failed" && alreadyLandedChecked) throw e;
      }
      const s = String((e as Error).message ?? e);
      if (i < maxRetries && /429|Too Many|rate|block height|timed out|not found|expired|already been processed/i.test(s)) {
        await new Promise((r) => setTimeout(r, retryDelayMs * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function waitForSlot(conn: Connection, targetSlot: number, pollMs = 1500) {
  while ((await conn.getSlot("confirmed")) < targetSlot) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Atomically read `[epochPk, bidReceiptPk]` at `finalized` commitment to prove closure:
 * only returns `true` when the SAME finalized RPC snapshot shows `epoch.settled === true`
 * (guaranteeing the node is strictly past settlement, never pre-bid stale) AND `bidReceipt`
 * is absent or no longer `"bidReceipt"`.
 */
export async function isReceiptFinalizedClosed(
  conn: Connection, rm: PublicKey, cfg: PublicKey, epochPk: PublicKey, bidReceiptPk: PublicKey,
): Promise<boolean> {
  const [epInfo, recInfo] = await conn.getMultipleAccountsInfo([epochPk, bidReceiptPk], "finalized");
  if (!epInfo || !epInfo.owner.equals(rm)) return false;
  const epBuf = Buffer.from(epInfo.data);
  if (accountKind(epBuf) !== "epochState") return false;
  const ep = parseEpochState(epBuf);
  if (!ep.cfg.equals(cfg) || !ep.settled) return false;
  return !recInfo || !recInfo.owner.equals(rm) || accountKind(Buffer.from(recInfo.data)) !== "bidReceipt";
}

/**
 * Reconcile any saved pending epoch / bidReceipt from a prior run before starting a new epoch.
 * - Dry runs (`live: false`) are strictly read-only and NEVER delete or modify `stateFile`.
 * - Verifies cluster (`genesisHash`), `cfg`, and `bidder` before mutating or clearing the journal.
 * - For in-flight `stage === "started"`, checks `startSig` and waits for `startLastValidBlockHeight`
 *   expiry before clearing so a still-valid start tx can never be abandoned.
 * - Reads epoch + receipt together at `finalized` commitment before treating absence as closure.
 * - Idempotently creates `usdcAta` before `ClaimQuote` so fresh wallets cannot strand claims.
 */
export async function reconcileSavedState(
  conn: Connection,
  stateFile: string,
  p: {
    live: boolean;
    rm: PublicKey;
    cfg: PublicKey;
    targetEscrow: PublicKey;
    burnSink: PublicKey;
    quoteVault: PublicKey;
    usdc: PublicKey;
    usdcAta: PublicKey;
    funder: Keypair;
    pollIntervalMs?: number;
    finalizeWaitMs?: number;
  },
): Promise<"none" | "reconciled" | "pending_dry"> {
  if (!fs.existsSync(stateFile)) return "none";
  const prev = JSON.parse(fs.readFileSync(stateFile, "utf8")) as PendingBidState;
  const epochPk = new PublicKey(prev.epoch);
  const bidReceiptPk = prev.bidReceipt ? new PublicKey(prev.bidReceipt) : null;

  // Dry runs are strictly read-only — inspect and report, never mutate or delete the journal.
  if (!p.live) {
    console.log(`[reward-bid] DRY: saved journal exists (stage=${prev.stage}, epoch=${prev.epoch}, receipt=${prev.bidReceipt ?? "none"}); run with --live to reconcile before starting a new epoch.`);
    return "pending_dry";
  }

  // Verify RPC cluster, RewardCfg existence/owner, and journal binding before touching the journal.
  const [genesisHash, cfgInfo] = await Promise.all([
    conn.getGenesisHash(),
    conn.getAccountInfo(p.cfg, "confirmed"),
  ]);
  if (!cfgInfo || !cfgInfo.owner.equals(p.rm) || accountKind(Buffer.from(cfgInfo.data)) !== "rewardCfg") {
    throw new Error(`refusing to reconcile/delete ${stateFile}: RewardCfg ${p.cfg.toBase58()} not found on current RPC (genesis=${genesisHash})`);
  }
  const cfgParsed = parseRewardCfg(Buffer.from(cfgInfo.data));
  if (prev.genesisHash && prev.genesisHash !== genesisHash) {
    throw new Error(`refusing to touch ${stateFile}: journal genesis ${prev.genesisHash} != RPC genesis ${genesisHash}`);
  }
  if (prev.cfg && prev.cfg !== p.cfg.toBase58()) {
    throw new Error(`refusing to touch ${stateFile}: journal cfg ${prev.cfg} != ${p.cfg.toBase58()}`);
  }
  if (prev.bidder && prev.bidder !== p.funder.publicKey.toBase58()) {
    throw new Error(`refusing to touch ${stateFile}: journal bidder ${prev.bidder} != ${p.funder.publicKey.toBase58()}`);
  }

  const isEpochSettled = async (): Promise<boolean> => {
    const ei = await conn.getAccountInfo(epochPk, "confirmed");
    if (!ei || !ei.owner.equals(p.rm)) return false;
    const b = Buffer.from(ei.data);
    return accountKind(b) === "epochState" && parseEpochState(b).settled;
  };

  // Read epoch + receipt together in one RPC snapshot at confirmed first
  const [epochInfo, receiptInfo] = bidReceiptPk
    ? await conn.getMultipleAccountsInfo([epochPk, bidReceiptPk], "confirmed")
    : [await conn.getAccountInfo(epochPk, "confirmed"), null];

  const receiptPresentConfirmed =
    !!receiptInfo && receiptInfo.owner.equals(p.rm) && accountKind(Buffer.from(receiptInfo.data)) === "bidReceipt";

  if (!epochInfo || !epochInfo.owner.equals(p.rm) || accountKind(Buffer.from(epochInfo.data)) !== "epochState") {
    // RewardModule never closes EpochState accounts; if we reached stage="bid", have a receipt,
    // or cfg still points at this epoch, RPC cannot prove what happened — retain the journal.
    if (prev.stage === "bid" || bidReceiptPk || cfgParsed.activeEpochAcc?.equals(epochPk) || receiptPresentConfirmed) {
      throw new Error(`refusing to delete ${stateFile}: epoch ${prev.epoch} missing on RPC despite stage=${prev.stage} (receipt=${prev.bidReceipt ?? "none"})`);
    }
    // For stage="started", ensure the recorded StartEpoch tx has definitively failed at finalized
    // OR expired at finalized block height before deleting the journal.
    if (!prev.startSig) {
      throw new Error(`refusing to delete ${stateFile}: legacy stage=started journal has no startSig/expiry to prove StartEpoch did not land`);
    }
    const st = (await conn.getSignatureStatuses([prev.startSig], { searchTransactionHistory: true })).value[0];
    if (st && !st.err) {
      throw new Error(`refusing to delete ${stateFile}: startSig ${prev.startSig} is confirmed/processing; retry reconciliation once epoch ${prev.epoch} is visible`);
    }
    const finalizedFailed = !!st && !!st.err && st.confirmationStatus === "finalized";
    let minSlot: number;
    if (finalizedFailed) {
      if (typeof st.slot !== "number") {
        throw new Error(`refusing to delete ${stateFile}: finalized failed startSig ${prev.startSig} missing slot`);
      }
      minSlot = st.slot;
    } else {
      if (prev.startLastValidBlockHeight === undefined) {
        throw new Error(`refusing to delete ${stateFile}: startSig ${prev.startSig} not finalized-failed and journal has no startLastValidBlockHeight`);
      }
      // Atomically fetch finalized `(absoluteSlot, blockHeight)` from one block and require the
      // subsequent account snapshot to be at or past that exact finalized slot (guards against lagging replicas).
      const finEpochInfo = await conn.getEpochInfo("finalized");
      if (finEpochInfo.blockHeight === undefined || finEpochInfo.blockHeight <= prev.startLastValidBlockHeight) {
        throw new Error(`refusing to delete ${stateFile}: startSig ${prev.startSig} still valid (blockHeight ${finEpochInfo.blockHeight ?? "unknown"} <= ${prev.startLastValidBlockHeight})`);
      }
      minSlot = finEpochInfo.absoluteSlot;
    }
    const finRes = await conn.getMultipleAccountsInfoAndContext([p.cfg, epochPk], {
      commitment: "finalized",
      minContextSlot: minSlot,
    });
    if (finRes.context.slot < minSlot) {
      throw new Error(`refusing to delete ${stateFile}: finalized account snapshot slot ${finRes.context.slot} < required minSlot ${minSlot}`);
    }
    const [finCfg, finEpoch] = finRes.value;
    if (!finCfg || !finCfg.owner.equals(p.rm) || accountKind(Buffer.from(finCfg.data)) !== "rewardCfg") {
      throw new Error(`refusing to delete ${stateFile}: RewardCfg ${p.cfg.toBase58()} unavailable at finalized`);
    }
    if (parseRewardCfg(Buffer.from(finCfg.data)).activeEpochAcc?.equals(epochPk)) {
      throw new Error(`refusing to delete ${stateFile}: cfg points to epoch ${prev.epoch} at finalized; retry reconciliation`);
    }
    if (finEpoch && finEpoch.owner.equals(p.rm) && accountKind(Buffer.from(finEpoch.data)) === "epochState") {
      throw new Error(`refusing to delete ${stateFile}: epoch ${prev.epoch} appeared at finalized; retry reconciliation`);
    }
    clearState(stateFile);
    return "reconciled";
  }

  const ep = parseEpochState(Buffer.from(epochInfo.data));
  if (!ep.cfg.equals(p.cfg)) {
    throw new Error(`refusing to touch ${stateFile}: epoch ${prev.epoch} belongs to cfg ${ep.cfg.toBase58()}, expected ${p.cfg.toBase58()}`);
  }

  const isEpochFinalizedSettled = async (): Promise<boolean> => {
    const ei = await conn.getAccountInfo(epochPk, "finalized");
    if (!ei || !ei.owner.equals(p.rm)) return false;
    const b = Buffer.from(ei.data);
    return accountKind(b) === "epochState" && parseEpochState(b).cfg.equals(p.cfg) && parseEpochState(b).settled;
  };

  if (!ep.settled) {
    console.log(`[reward-bid] reconciling saved unsettled epoch ${prev.epoch} (endSlot=${ep.endSlot})…`);
    await waitForSlot(conn, Number(ep.endSlot) + 3, p.pollIntervalMs ?? 1500);
    await sendIdempotent(
      conn,
      [rewardSettleEpoch(p.rm, { cfg: p.cfg, epochAcc: epochPk, targetEscrow: p.targetEscrow, targetMint: NATIVE_MINT, burnSink: p.burnSink, burnMode: 1 })],
      [p.funder],
      // When there is no receipt to claim afterward, wait for finalized settlement before deleting the journal.
      bidReceiptPk
        ? { alreadyLanded: isEpochSettled }
        : { commitment: "finalized", alreadyLanded: isEpochFinalizedSettled },
    );
  } else if (!bidReceiptPk) {
    // Already settled at confirmed with no bidReceipt: wait for finalized settlement before cleanup.
    const finalizeWaitMs = p.finalizeWaitMs ?? 45_000;
    const pollMs = p.pollIntervalMs ?? 1500;
    const deadline = Date.now() + finalizeWaitMs;
    let settledFinalized = false;
    for (;;) {
      if (await isEpochFinalizedSettled()) {
        settledFinalized = true;
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(pollMs, remaining)));
    }
    if (!settledFinalized) {
      throw new Error(`refusing to delete ${stateFile}: epoch ${prev.epoch} settlement not confirmed at finalized within ${finalizeWaitMs}ms`);
    }
  }

  if (bidReceiptPk) {
    const readConfirmedEpochAndReceipt = async () => {
      const [epI, recI] = await conn.getMultipleAccountsInfo([epochPk, bidReceiptPk], "confirmed");
      const epBuf = epI && epI.owner.equals(p.rm) ? Buffer.from(epI.data) : null;
      const settled =
        !!epBuf && accountKind(epBuf) === "epochState" &&
        parseEpochState(epBuf).cfg.equals(p.cfg) && parseEpochState(epBuf).settled;
      const receiptOpen =
        !!recI && recI.owner.equals(p.rm) && accountKind(Buffer.from(recI.data)) === "bidReceipt";
      return { settled, receiptOpen };
    };

    const submitClaim = async () => {
      console.log(`[reward-bid] reconciling unclaimed bidReceipt ${prev.bidReceipt} for epoch ${prev.epoch}…`);
      // Require finalized claim confirmation OR finalized receipt closure before clearing the journal.
      const claimSig = await sendIdempotent(
        conn,
        [
          createAssociatedTokenAccountIdempotentInstruction(p.funder.publicKey, p.usdcAta, p.funder.publicKey, p.usdc),
          rewardClaimQuote(p.rm, {
            cfg: p.cfg, epochAcc: epochPk, bidReceipt: bidReceiptPk, bidder: p.funder.publicKey,
            quoteVault: p.quoteVault, bidderQuoteTok: p.usdcAta, quoteMint: p.usdc,
          }),
        ],
        [p.funder],
        {
          commitment: "finalized",
          alreadyLanded: () => isReceiptFinalizedClosed(conn, p.rm, p.cfg, epochPk, bidReceiptPk),
        },
      );
      if (!claimSig && !(await isReceiptFinalizedClosed(conn, p.rm, p.cfg, epochPk, bidReceiptPk))) {
        throw new Error(`refusing to delete ${stateFile}: bidReceipt ${prev.bidReceipt} closure could not be verified at finalized`);
      }
    };

    const confirmed = await readConfirmedEpochAndReceipt();
    if (confirmed.receiptOpen) {
      if (!confirmed.settled) {
        throw new Error(`refusing to delete ${stateFile}: epoch ${prev.epoch} is not settled at confirmed`);
      }
      await submitClaim();
    } else if (confirmed.settled) {
      // Confirmed shows settled + absent receipt (e.g. SubmitBid never landed or prior post-claim crash).
      // Skip blind ClaimQuote (which crashes with IllegalOwner) and poll until finalized confirms closure;
      // if a reorg revives the receipt at confirmed, fall back to submitting ClaimQuote.
      const finalizeWaitMs = p.finalizeWaitMs ?? 45_000;
      const pollMs = p.pollIntervalMs ?? 1500;
      const deadline = Date.now() + finalizeWaitMs;
      let finalizedClosed = false;
      let revived = false;
      for (;;) {
        if (await isReceiptFinalizedClosed(conn, p.rm, p.cfg, epochPk, bidReceiptPk)) {
          finalizedClosed = true;
          break;
        }
        const recheck = await readConfirmedEpochAndReceipt();
        if (recheck.receiptOpen) {
          if (!recheck.settled) {
            throw new Error(`refusing to delete ${stateFile}: epoch ${prev.epoch} reverted to unsettled during finalization wait`);
          }
          revived = true;
          break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(pollMs, remaining)));
      }
      if (revived) {
        await submitClaim();
      } else if (!finalizedClosed) {
        throw new Error(
          `refusing to delete ${stateFile}: bidReceipt ${prev.bidReceipt} closure not confirmed at finalized within ${finalizeWaitMs}ms`,
        );
      }
    } else {
      throw new Error(`refusing to delete ${stateFile}: epoch ${prev.epoch} is not settled at confirmed`);
    }
  }

  clearState(stateFile);
  console.log(`[reward-bid] reconciled prior state for epoch ${prev.epoch}.`);
  return "reconciled";
}

async function main() {
  const LIVE = process.argv.includes("--live");
  const SETTLE_EXTERNAL = process.argv.includes("--settle-external");
  const conn = new Connection(process.env.SOLANA_RPC_URL!, "confirmed");
  const m = JSON.parse(fs.readFileSync("lean-mainnet-r3.json", "utf8"));
  const RM = new PublicKey(m.rewardModule), P = new PublicKey(m.percolator), DEX = new PublicKey(m.dex), MKT = new PublicKey(m.market);
  const CFG = new PublicKey(m.rewardCfg), USDC = new PublicKey(m.usdc);
  const quoteVault = new PublicKey(m.quoteVault), targetEscrow = new PublicKey(m.targetEscrow), burnSink = new PublicKey(m.burnSink);
  const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
  const stateFile = process.env.REWARD_BID_STATE_FILE ?? `${process.env.HOME}/.config/solana/lean-r3-reward-bid-state.json`;
  const usdcAta = await getAssociatedTokenAddress(USDC, funder.publicKey);

  async function acct(pk: PublicKey) { const i = await conn.getAccountInfo(pk, "confirmed"); return i ? Buffer.from(i.data) : null; }

  const run = async () => {
    // 0) Reconcile any saved epoch / unclaimed receipt BEFORE inspecting or starting a new epoch
    const rec = await reconcileSavedState(conn, stateFile, {
      live: LIVE, rm: RM, cfg: CFG, targetEscrow, burnSink, quoteVault, usdc: USDC, usdcAta, funder,
    });
    if (rec === "pending_dry") return;

    let cfg = parseRewardCfg((await acct(CFG))!);
    // Only settle someone else's expired epoch when explicitly opted in via --settle-external
    // (preserves the cron wrapper's no-spend guarantee when there is no local work or EV+ pot).
    if (isRewardEpochActive(cfg) && LIVE && SETTLE_EXTERNAL && cfg.activeEpochAcc) {
      const activeEpBuf = await acct(cfg.activeEpochAcc);
      if (activeEpBuf && accountKind(activeEpBuf) === "epochState") {
        const activeEp = parseEpochState(activeEpBuf);
        const curSlot = await conn.getSlot("confirmed");
        if (!activeEp.settled && curSlot >= Number(activeEp.endSlot)) {
          console.log(`[reward-bid] settling ended external epoch ${cfg.activeEpochAcc.toBase58()} (--settle-external)…`);
          const activeEpPk = cfg.activeEpochAcc;
          await sendIdempotent(
            conn,
            [rewardSettleEpoch(RM, { cfg: CFG, epochAcc: activeEpPk, targetEscrow, targetMint: NATIVE_MINT, burnSink, burnMode: 1 })],
            [funder],
            {
              alreadyLanded: async () => {
                const b = await acct(activeEpPk);
                return !!b && accountKind(b) === "epochState" && parseEpochState(b).settled;
              },
            },
          );
          cfg = parseRewardCfg((await acct(CFG))!);
        }
      }
    }

    const mkt = parseMarket((await acct(MKT))!);
    const accrued = mkt.rewardAccrued;
    const rollover = cfg.rolloverQuote;
    const reserveRateE6 = cfg.reserveRateE6;
    const minBatch = cfg.minBatchQuote;
    const activeEpoch = isRewardEpochActive(cfg);
    const P_sol = await solPriceUsd();
    const Q = accrued + rollover;
    const Bvirt = (Q * reserveRateE6 + 999_999n) / 1_000_000n;
    const est = computeOptimalBid(Q, Bvirt, 0n, P_sol);
    console.log(`[reward-bid] accrued=$${U(accrued)} rollover=$${U(rollover)} -> Q=$${U(Q)} | reserveRateE6=${reserveRateE6} Bvirt=${Bvirt} | SOL=$${P_sol.toFixed(2)} activeEpoch=${activeEpoch}`);
    console.log(`[reward-bid] optimal bid b*=${(Number(est.bStar) / 1e9).toFixed(6)} SOL -> claim $${est.payoutUsd.toFixed(4)} | burn $${est.burnUsd.toFixed(4)} | net(after epoch rent) $${est.netUsd.toFixed(4)}`);

    if (activeEpoch) { console.log("[reward-bid] an epoch is already active — skipping (settle/claim it first, or pass --settle-external if ended)."); return; }
    if (Q < minBatch) { console.log(`[reward-bid] SKIP: pot $${U(Q)} < minBatch $${U(minBatch)}.`); return; }
    if (!shouldSubmitBid(est)) { console.log(`[reward-bid] SKIP: net $${est.netUsd.toFixed(4)} < MIN_NET $${MIN_NET_USD}. (waiting for a bigger pot / lower reserve)`); return; }
    if (!LIVE) { console.log(`[reward-bid] DRY: would fire this epoch (net +$${est.netUsd.toFixed(4)}). Re-run with --live to execute.`); return; }

    // ---- LIVE: run the full epoch ----
    const bidder = funder;
    const genesisHash = await conn.getGenesisHash();
    const wsolAta = (await getOrCreateAssociatedTokenAccount(conn, funder, NATIVE_MINT, funder.publicKey)).address;
    const dexVault = deriveDexVault(P, DEX)[0];

    // 1) Sign StartEpoch and atomically persist `(startSig, startLastValidBlockHeight)` BEFORE every broadcast
    //    (both the initial attempt and any post-expiry replacement) so a crash can never orphan an in-flight start tx.
    const epoch = Keypair.generate();
    const rentE = await conn.getMinimumBalanceForRentExemption(EPOCH_SIZE);
    const startIxs = [
      SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: epoch.publicKey, lamports: rentE, space: EPOCH_SIZE, programId: RM }),
      rewardStartEpoch(RM, { cfg: CFG, epochAcc: epoch.publicKey, dex: DEX, market: MKT, quoteMint: USDC, dexVault, quoteVault, percolator: P }),
    ];
    const journalBase = { genesisHash, cfg: CFG.toBase58(), bidder: bidder.publicKey.toBase58(), epoch: epoch.publicKey.toBase58() };
    await sendIdempotent(
      conn,
      startIxs,
      [funder, epoch],
      {
        onSigned: ({ sig, lastValidBlockHeight }) => {
          saveStateAtomic(stateFile, {
            ...journalBase,
            startSig: sig,
            startLastValidBlockHeight: lastValidBlockHeight,
            stage: "started",
          });
        },
        alreadyLanded: async () => {
          const b = await acct(epoch.publicKey);
          return !!b && accountKind(b) === "epochState";
        },
      },
    );

    // Re-read live epoch state (including any front-run `totalBids`) and enforce the same MIN_NET_USD threshold
    const ep = parseEpochState((await acct(epoch.publicKey))!);
    const live = computeOptimalBid(ep.quotePot, ep.virtBids, ep.totalBids, P_sol, EPOCH_RENT_SOL);
    console.log(`[reward-bid] LIVE epoch ${epoch.publicKey.toBase58()}: Q=$${U(ep.quotePot)} Bvirt=${ep.virtBids} existingBids=${ep.totalBids} -> bid ${(Number(live.bStar) / 1e9).toFixed(6)} SOL, claim $${live.payoutUsd.toFixed(4)} burn $${live.burnUsd.toFixed(4)} net $${live.netUsd.toFixed(4)}`);
    const isEpochSettled = async () => {
      const b = await acct(epoch.publicKey);
      return !!b && accountKind(b) === "epochState" && parseEpochState(b).settled;
    };
    const isEpochFinalizedSettled = async () => {
      const ei = await conn.getAccountInfo(epoch.publicKey, "finalized");
      if (!ei || !ei.owner.equals(RM)) return false;
      const b = Buffer.from(ei.data);
      return accountKind(b) === "epochState" && parseEpochState(b).cfg.equals(CFG) && parseEpochState(b).settled;
    };
    if (!shouldSubmitBid(live)) {
      console.log(`[reward-bid] DECLINE after StartEpoch: net $${live.netUsd.toFixed(4)} < MIN_NET $${MIN_NET_USD}; waiting to settle epoch and roll quote over.`);
      await waitForSlot(conn, Number(ep.endSlot) + 3);
      await sendIdempotent(
        conn,
        [rewardSettleEpoch(RM, { cfg: CFG, epochAcc: epoch.publicKey, targetEscrow, targetMint: NATIVE_MINT, burnSink, burnMode: 1 })],
        [funder],
        { commitment: "finalized", alreadyLanded: isEpochFinalizedSettled },
      );
      clearState(stateFile);
      return;
    }

    // 2) Atomically wrap SOL, create fresh bidReceipt, and SubmitBid in ONE tx (prevents duplicate-bid double debit)
    const bidReceipt = Keypair.generate();
    const rentB = await conn.getMinimumBalanceForRentExemption(BIDDER_SIZE);
    saveStateAtomic(stateFile, { ...journalBase, bidReceipt: bidReceipt.publicKey.toBase58(), stage: "bid" });
    const isBidLanded = async () => {
      const b = await acct(bidReceipt.publicKey);
      return !!b && accountKind(b) === "bidReceipt" && parseBidReceipt(b).amount > 0n;
    };
    await sendIdempotent(
      conn,
      [
        SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: wsolAta, lamports: Number(live.bStar) }),
        createSyncNativeInstruction(wsolAta),
        SystemProgram.createAccount({ fromPubkey: funder.publicKey, newAccountPubkey: bidReceipt.publicKey, lamports: rentB, space: BIDDER_SIZE, programId: RM }),
        rewardSubmitBid(RM, { cfg: CFG, epochAcc: epoch.publicKey, bidReceipt: bidReceipt.publicKey, bidder: bidder.publicKey, bidderTargetTok: wsolAta, targetEscrow, targetMint: NATIVE_MINT, amount: live.bStar }),
      ],
      [funder, bidReceipt],
      { alreadyLanded: isBidLanded },
    );

    // 3) Wait until epoch endSlot, SettleEpoch (burn)
    await waitForSlot(conn, Number(ep.endSlot) + 3);
    await sendIdempotent(
      conn,
      [rewardSettleEpoch(RM, { cfg: CFG, epochAcc: epoch.publicKey, targetEscrow, targetMint: NATIVE_MINT, burnSink, burnMode: 1 })],
      [funder],
      { alreadyLanded: isEpochSettled },
    );

    // 4) Idempotently create USDC ATA + ClaimQuote, waiting for finalized confirmation/closure before deleting the journal
    const before = await readInitialTokenBalance(conn, usdcAta);
    await sendIdempotent(
      conn,
      [
        createAssociatedTokenAccountIdempotentInstruction(funder.publicKey, usdcAta, funder.publicKey, USDC),
        rewardClaimQuote(RM, { cfg: CFG, epochAcc: epoch.publicKey, bidReceipt: bidReceipt.publicKey, bidder: bidder.publicKey, quoteVault, bidderQuoteTok: usdcAta, quoteMint: USDC }),
      ],
      [funder],
      {
        commitment: "finalized",
        alreadyLanded: () => isReceiptFinalizedClosed(conn, RM, CFG, epoch.publicKey, bidReceipt.publicKey),
      },
    );
    clearState(stateFile);
    if (before !== null) {
      const got = (await getAccount(conn, usdcAta)).amount - before;
      console.log(`[reward-bid] DONE: claimed $${(Number(got) / 1e6).toFixed(6)} USDC for ${(Number(live.bStar) / 1e9).toFixed(6)} wSOL burned (buy-and-burn). net ~$${(Number(got) / 1e6 - live.burnUsd - EPOCH_RENT_SOL * P_sol).toFixed(4)}`);
    } else {
      console.log(`[reward-bid] DONE: claimed USDC for ${(Number(live.bStar) / 1e9).toFixed(6)} wSOL burned (buy-and-burn; initial USDC balance unavailable).`);
    }
  };

  if (LIVE) {
    await withStateLock(stateFile, run);
  } else {
    await run();
  }
}

/** Symlink-safe ESM direct-entrypoint check (falls back to `path.resolve` if `realpathSync` fails). */
export function isDirectEntrypoint(metaUrl: string, argv1 = process.argv[1]): boolean {
  if (!argv1) return false;
  const selfPath = fileURLToPath(metaUrl);
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(selfPath);
  } catch {
    return path.resolve(argv1) === path.resolve(selfPath);
  }
}

if (isDirectEntrypoint(import.meta.url)) {
  main().then(() => process.exit(0)).catch(e => { console.error("[reward-bid] ERR", String(e).slice(0, 300)); process.exit(1); });
}
