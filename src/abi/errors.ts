/**
 * Percolator program error definitions.
 * Each error includes a name and actionable guidance.
 */
interface ErrorInfo {
  name: string;
  hint: string;
}

export const PERCOLATOR_ERRORS: Record<number, ErrorInfo> = {
  0: {
    name: "InvalidMagic",
    hint: "The slab account has invalid data. Ensure you're using the correct slab address.",
  },
  1: {
    name: "InvalidVersion",
    hint: "Slab version mismatch. The program may have been upgraded. Check for CLI updates.",
  },
  2: {
    name: "AlreadyInitialized",
    hint: "This account is already initialized. Use a different account or skip initialization.",
  },
  3: {
    name: "NotInitialized",
    hint: "The slab is not initialized. Run 'init-market' first.",
  },
  4: {
    name: "InvalidSlabLen",
    hint: "Slab account has wrong size. Create a new slab account with correct size.",
  },
  5: {
    name: "InvalidOracleKey",
    hint: "Oracle account doesn't match config. Check the --oracle parameter matches the market's oracle.",
  },
  6: {
    name: "OracleStale",
    hint: "Oracle price is too old. Wait for oracle to update or check if oracle is paused.",
  },
  7: {
    name: "OracleConfTooWide",
    hint: "Oracle confidence interval is too wide. Wait for more stable market conditions.",
  },
  8: {
    name: "InvalidVaultAta",
    hint: "Vault token account is invalid. Check the vault account is correctly configured.",
  },
  9: {
    name: "InvalidMint",
    hint: "Token mint doesn't match. Ensure you're using the correct collateral token.",
  },
  10: {
    name: "ExpectedSigner",
    hint: "Missing required signature. Ensure the correct wallet is specified with --wallet.",
  },
  11: {
    name: "ExpectedWritable",
    hint: "Account must be writable. This is likely a CLI bug - please report it.",
  },
  12: {
    name: "OracleInvalid",
    hint: "Oracle data is invalid. Check the oracle account is a valid Pyth price feed.",
  },
  13: {
    name: "EngineInsufficientBalance",
    hint: "Not enough collateral. Deposit more with 'deposit' before this operation.",
  },
  14: {
    name: "EngineUndercollateralized",
    hint: "Account is undercollateralized. Deposit more collateral or reduce position size.",
  },
  15: {
    name: "EngineUnauthorized",
    hint: "Not authorized. You must be the account owner or admin for this operation.",
  },
  16: {
    name: "EngineInvalidMatchingEngine",
    hint: "Matcher program/context doesn't match LP config. Check --matcher-program and --matcher-context.",
  },
  17: {
    name: "EnginePnlNotWarmedUp",
    hint: "PnL not warmed up yet. Wait for the warmup period to complete before trading.",
  },
  18: {
    name: "EngineOverflow",
    hint: "Numeric overflow in calculation. Try a smaller amount or position size.",
  },
  19: {
    name: "EngineAccountNotFound",
    hint: "Account not found at this index. Run 'init-user' or 'init-lp' first, or check the index.",
  },
  20: {
    name: "EngineNotAnLPAccount",
    hint: "Expected an LP account but got a user account. Check the --lp-idx parameter.",
  },
  21: {
    name: "EnginePositionSizeMismatch",
    hint: "Position size mismatch between user and LP. This shouldn't happen - please report it.",
  },
  22: {
    name: "EngineRiskReductionOnlyMode",
    hint: "Market is in risk-reduction mode. Only position-reducing trades are allowed.",
  },
  23: {
    name: "EngineAccountKindMismatch",
    hint: "Wrong account type. User operations require user accounts, LP operations require LP accounts.",
  },
  24: {
    name: "InvalidTokenAccount",
    hint: "Token account is invalid. Ensure you have an ATA for the collateral mint.",
  },
  25: {
    name: "InvalidTokenProgram",
    hint: "Invalid token program. Ensure SPL Token program is accessible.",
  },
  26: {
    name: "InvalidConfigParam",
    hint: "Invalid configuration parameter. Check per-market admin limits and parameter constraints.",
  },
  27: {
    name: "HyperpTradeNoCpiDisabled",
    hint: "Hyperp mode requires TradeCpi, not TradeNoCpi. Use the trade-cpi command instead.",
  },
};

/**
 * Decode a custom program error code to its info.
 */
export function decodeError(code: number): ErrorInfo | undefined {
  return PERCOLATOR_ERRORS[code];
}

/**
 * Get error name from code.
 */
export function getErrorName(code: number): string {
  return PERCOLATOR_ERRORS[code]?.name ?? `Unknown(${code})`;
}

/**
 * Get actionable hint for error code.
 */
export function getErrorHint(code: number): string | undefined {
  return PERCOLATOR_ERRORS[code]?.hint;
}

/**
 * Parse error from transaction logs.
 * Looks for "Program ... failed: custom program error: 0x..."
 */
export function parseErrorFromLogs(logs: string[]): {
  code: number;
  name: string;
  hint?: string;
} | null {
  for (const log of logs) {
    const match = log.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (match) {
      const code = parseInt(match[1], 16);
      const info = decodeError(code);
      return {
        code,
        name: info?.name ?? `Unknown(${code})`,
        hint: info?.hint,
      };
    }
  }
  return null;
}
