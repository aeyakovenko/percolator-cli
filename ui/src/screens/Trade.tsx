import { useState, useCallback } from "react";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { SlabSnapshot } from "../hooks/use-slab";
import type { UseMatcherCtxResult } from "../hooks/use-matcher-ctx";
import { useUserAccount } from "../hooks/use-user-account";
import { lamportsToSol } from "../lib/format";
import { computeTier } from "../lib/tiers";
import { StatCard } from "../components/StatCard";
import {
  PROGRAM_ID,
  CREDIBILITY_MATCHER_PROGRAM,
  SLAB,
  MINT,
  VAULT,
  VAULT_PDA,
  ORACLE,
  MATCHER_CTX,
  LP_INDEX,
  LP_PDA,
} from "../config/market";
import styles from "./Trade.module.css";

// Instruction encoders — imported via @abi alias
import {
  encodeInitUser,
  encodeDepositCollateral,
  encodeWithdrawCollateral,
  encodeTradeCpi,
} from "@abi/instructions";
import {
  ACCOUNTS_INIT_USER,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_TRADE_CPI,
  buildAccountMetas,
} from "@abi/accounts";

interface TradeProps {
  data: SlabSnapshot;
  matcherCtx: UseMatcherCtxResult;
  connection: Connection;
  wallet: WalletContextState;
}

type TxStatus = "idle" | "sending" | "success" | "error";

const LAMPORTS_PER_SOL = 1_000_000_000n;

export function Trade({ data, matcherCtx, connection, wallet }: TradeProps) {
  const userAccount = useUserAccount(data, wallet.publicKey);

  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [tradeSize, setTradeSize] = useState("");
  const [tradeSide, setTradeSide] = useState<"long" | "short">("long");
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txMessage, setTxMessage] = useState("");

  const sendTx = useCallback(
    async (tx: Transaction) => {
      if (!wallet.publicKey || !wallet.sendTransaction) {
        throw new Error("Wallet not connected");
      }
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      const sig = await wallet.sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    },
    [wallet, connection]
  );

  // ---- Init User Account ----
  const handleInitUser = useCallback(async () => {
    if (!wallet.publicKey) return;
    setTxStatus("sending");
    setTxMessage("Initializing account...");
    try {
      const userAta = await getAssociatedTokenAddress(MINT, wallet.publicKey);
      const fee = data.params.newAccountFee;

      const tx = new Transaction();

      // Ensure ATA exists
      const ataInfo = await connection.getAccountInfo(userAta);
      if (!ataInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            userAta,
            wallet.publicKey,
            MINT
          )
        );
      }

      // Wrap SOL to pay the account fee (if fee > 0)
      if (fee > 0n) {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: userAta,
            lamports: fee,
          })
        );
        tx.add(
          new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [{ pubkey: userAta, isSigner: false, isWritable: true }],
            data: Buffer.from([17]), // SyncNative
          })
        );
      }

      const ixData = encodeInitUser({ feePayment: fee });
      const keys = buildAccountMetas(ACCOUNTS_INIT_USER, [
        wallet.publicKey,
        SLAB,
        userAta,
        VAULT,
        TOKEN_PROGRAM_ID,
      ]);
      tx.add(new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixData }));

      const sig = await sendTx(tx);
      setTxStatus("success");
      setTxMessage(`Account created. Tx: ${sig.slice(0, 16)}...`);
    } catch (e) {
      setTxStatus("error");
      setTxMessage(e instanceof Error ? e.message : String(e));
    }
  }, [wallet, connection, sendTx, data]);

  // ---- Deposit Collateral ----
  const handleDeposit = useCallback(async () => {
    if (!wallet.publicKey || !userAccount) return;
    const solAmount = parseFloat(depositAmount);
    if (isNaN(solAmount) || solAmount <= 0) return;

    setTxStatus("sending");
    setTxMessage("Depositing...");
    try {
      const lamports = BigInt(Math.round(solAmount * 1e9));
      const userAta = await getAssociatedTokenAddress(MINT, wallet.publicKey);

      const tx = new Transaction();

      // Ensure ATA exists
      const ataInfo = await connection.getAccountInfo(userAta);
      if (!ataInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            userAta,
            wallet.publicKey,
            MINT
          )
        );
      }

      // Wrap SOL: transfer SOL to ATA then sync
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: userAta,
          lamports,
        })
      );
      // SyncNative
      tx.add(
        new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [{ pubkey: userAta, isSigner: false, isWritable: true }],
          data: Buffer.from([17]), // SyncNative tag
        })
      );

      const ixData = encodeDepositCollateral({
        userIdx: userAccount.idx,
        amount: lamports,
      });
      const keys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
        wallet.publicKey,
        SLAB,
        userAta,
        VAULT,
        TOKEN_PROGRAM_ID,
        SYSVAR_CLOCK_PUBKEY,
      ]);
      tx.add(new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixData }));

      const sig = await sendTx(tx);
      setTxStatus("success");
      setTxMessage(`Deposited ${solAmount} SOL. Tx: ${sig.slice(0, 16)}...`);
      setDepositAmount("");
    } catch (e) {
      setTxStatus("error");
      setTxMessage(e instanceof Error ? e.message : String(e));
    }
  }, [wallet, connection, sendTx, userAccount, depositAmount]);

  // ---- Withdraw Collateral ----
  const handleWithdraw = useCallback(async () => {
    if (!wallet.publicKey || !userAccount) return;
    const solAmount = parseFloat(withdrawAmount);
    if (isNaN(solAmount) || solAmount <= 0) return;

    setTxStatus("sending");
    setTxMessage("Withdrawing...");
    try {
      const lamports = BigInt(Math.round(solAmount * 1e9));
      const userAta = await getAssociatedTokenAddress(MINT, wallet.publicKey);

      const tx = new Transaction();
      const ixData = encodeWithdrawCollateral({
        userIdx: userAccount.idx,
        amount: lamports,
      });
      const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_COLLATERAL, [
        wallet.publicKey,
        SLAB,
        VAULT,
        userAta,
        VAULT_PDA,
        TOKEN_PROGRAM_ID,
        SYSVAR_CLOCK_PUBKEY,
        ORACLE,
      ]);
      tx.add(new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixData }));

      const sig = await sendTx(tx);
      setTxStatus("success");
      setTxMessage(`Withdrew ${solAmount} SOL. Tx: ${sig.slice(0, 16)}...`);
      setWithdrawAmount("");
    } catch (e) {
      setTxStatus("error");
      setTxMessage(e instanceof Error ? e.message : String(e));
    }
  }, [wallet, connection, sendTx, userAccount, withdrawAmount]);

  // ---- Trade (CPI through credibility matcher) ----
  const handleTrade = useCallback(async () => {
    if (!wallet.publicKey || !userAccount) return;
    const size = parseFloat(tradeSize);
    if (isNaN(size) || size <= 0) return;

    setTxStatus("sending");
    setTxMessage("Executing trade...");
    try {
      // Convert SOL size to lamports, negative for short
      const sizeInLamports = BigInt(Math.round(size * 1e9));
      const signedSize = tradeSide === "short" ? -sizeInLamports : sizeInLamports;

      // Find LP owner from slab accounts
      const lpAccount = data.accounts.find(
        (a) => a.idx === LP_INDEX
      );
      const lpOwner = lpAccount
        ? lpAccount.account.owner
        : wallet.publicKey; // fallback

      const tx = new Transaction();
      const ixData = encodeTradeCpi({
        lpIdx: LP_INDEX,
        userIdx: userAccount.idx,
        size: signedSize,
      });
      const keys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
        wallet.publicKey,
        lpOwner,
        SLAB,
        SYSVAR_CLOCK_PUBKEY,
        ORACLE,
        CREDIBILITY_MATCHER_PROGRAM,
        MATCHER_CTX,
        LP_PDA,
      ]);
      tx.add(new TransactionInstruction({ programId: PROGRAM_ID, keys, data: ixData }));

      const sig = await sendTx(tx);
      setTxStatus("success");
      setTxMessage(
        `${tradeSide.toUpperCase()} ${size} SOL executed. Tx: ${sig.slice(0, 16)}...`
      );
      setTradeSize("");
    } catch (e) {
      setTxStatus("error");
      setTxMessage(e instanceof Error ? e.message : String(e));
    }
  }, [wallet, connection, sendTx, userAccount, tradeSize, tradeSide, data]);

  // ---- Spread estimate and coverage tier from matcher context ----
  const tier = matcherCtx.data
    ? computeTier(matcherCtx.data.insuranceSnapshot, matcherCtx.data.totalOiSnapshot)
    : computeTier(data.engine.insuranceFund.balance, data.engine.totalOpenInterest);

  const spreadInfo = matcherCtx.data
    ? (() => {
        const mc = matcherCtx.data;
        const absInv = mc.inventoryBase < 0n ? -mc.inventoryBase : mc.inventoryBase;
        const imbalancePenalty =
          mc.liquidityNotionalE6 > 0n
            ? (Number(absInv) / Number(mc.liquidityNotionalE6)) * mc.imbalanceKBps
            : 0;
        const effectiveSpread = Math.max(
          mc.minSpreadBps,
          Math.min(
            mc.maxSpreadBps,
            mc.baseFeeBps + imbalancePenalty
          )
        );
        const oraclePrice = Number(mc.lastOraclePriceE6) / 1e6;
        return { effectiveSpread, oraclePrice };
      })()
    : null;

  // ---- No wallet connected ----
  if (!wallet.publicKey) {
    return (
      <div className={styles.root}>
        <h2 className={styles.heading}>Trade</h2>
        <div className={styles.connectPrompt}>
          <p>Connect your wallet to trade.</p>
          <p className={styles.hint}>
            Use the wallet button in the top-right corner.
          </p>
        </div>
      </div>
    );
  }

  // ---- No account yet ----
  if (!userAccount) {
    return (
      <div className={styles.root}>
        <h2 className={styles.heading}>Trade</h2>
        <div className={styles.initSection}>
          <p>No account found for this wallet on this market.</p>
          <button className={styles.primaryBtn} onClick={handleInitUser}>
            Initialize Account
          </button>
          {txStatus !== "idle" && (
            <p className={`${styles.txMsg} ${styles[txStatus]}`}>{txMessage}</p>
          )}
        </div>
      </div>
    );
  }

  // ---- Main trading interface ----
  const posDir =
    userAccount.positionSize > 0n
      ? "LONG"
      : userAccount.positionSize < 0n
      ? "SHORT"
      : "FLAT";
  const absPosSize =
    userAccount.positionSize < 0n
      ? -userAccount.positionSize
      : userAccount.positionSize;

  return (
    <div className={styles.root}>
      <h2 className={styles.heading}>Trade</h2>

      {/* Account status bar */}
      <div className={styles.accountBar}>
        <StatCard
          label="Capital"
          value={`${lamportsToSol(userAccount.capital)} SOL`}
        />
        <StatCard
          label="Position"
          value={`${posDir} ${lamportsToSol(absPosSize)}`}
        />
        <StatCard
          label="PnL"
          value={`${Number(userAccount.pnl) >= 0 ? "+" : ""}${lamportsToSol(userAccount.pnl)} SOL`}
        />
        <StatCard
          label="Margin Health"
          value={`${userAccount.marginHealthPct > 500 ? ">500" : userAccount.marginHealthPct.toFixed(0)}%`}
        />
      </div>

      {/* Tier + Spread info */}
      <div className={styles.tierBar} style={{ borderColor: tier.borderColor, backgroundColor: tier.bgColor }}>
        <span className={styles.tierName} style={{ color: tier.color }}>{tier.name}</span>
        {spreadInfo && (
          <>
            <span>Oracle: ${spreadInfo.oraclePrice.toFixed(2)}</span>
            <span>Spread: {spreadInfo.effectiveSpread.toFixed(1)} bps</span>
          </>
        )}
        <span>Coverage: {tier.coveragePct.toFixed(1)}%</span>
        <span>Fill cap: {tier.fillCapPct}%</span>
      </div>

      <div className={styles.panels}>
        {/* Deposit / Withdraw */}
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Collateral</h3>
          <div className={styles.inputRow}>
            <input
              type="number"
              className={styles.input}
              placeholder="SOL amount"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              min="0"
              step="0.01"
            />
            <button className={styles.actionBtn} onClick={handleDeposit}>
              Deposit
            </button>
          </div>
          <div className={styles.inputRow}>
            <input
              type="number"
              className={styles.input}
              placeholder="SOL amount"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              min="0"
              step="0.01"
            />
            <button className={styles.actionBtnSecondary} onClick={handleWithdraw}>
              Withdraw
            </button>
          </div>
        </div>

        {/* Trade */}
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Trade</h3>
          <div className={styles.sideToggle}>
            <button
              className={`${styles.sideBtn} ${tradeSide === "long" ? styles.sideLong : ""}`}
              onClick={() => setTradeSide("long")}
            >
              Long
            </button>
            <button
              className={`${styles.sideBtn} ${tradeSide === "short" ? styles.sideShort : ""}`}
              onClick={() => setTradeSide("short")}
            >
              Short
            </button>
          </div>
          <div className={styles.inputRow}>
            <input
              type="number"
              className={styles.input}
              placeholder="Size (SOL)"
              value={tradeSize}
              onChange={(e) => setTradeSize(e.target.value)}
              min="0"
              step="0.01"
            />
            <button className={styles.primaryBtn} onClick={handleTrade}>
              Execute
            </button>
          </div>
          {spreadInfo && tradeSize && !isNaN(parseFloat(tradeSize)) && (
            <div className={styles.estimate}>
              <span>Est. entry:</span>
              <span>
                ${tradeSide === "long"
                  ? (spreadInfo.oraclePrice * (1 + spreadInfo.effectiveSpread / 10000)).toFixed(4)
                  : (spreadInfo.oraclePrice * (1 - spreadInfo.effectiveSpread / 10000)).toFixed(4)}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* TX Status */}
      {txStatus !== "idle" && (
        <p className={`${styles.txMsg} ${styles[txStatus]}`}>{txMessage}</p>
      )}
    </div>
  );
}
