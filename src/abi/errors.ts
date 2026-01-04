/**
 * Percolator program error codes.
 * Maps ProgramError::Custom(code) to error names.
 */
export const PERCOLATOR_ERRORS: Record<number, string> = {
  0: "InvalidMagic",
  1: "InvalidVersion",
  2: "AlreadyInitialized",
  3: "NotInitialized",
  4: "InvalidSlabLen",
  5: "InvalidOracleKey",
  6: "OracleStale",
  7: "OracleConfTooWide",
  8: "InvalidVaultAta",
  9: "InvalidMint",
  10: "ExpectedSigner",
  11: "ExpectedWritable",
  12: "OracleInvalid",
  13: "EngineInsufficientBalance",
  14: "EngineUndercollateralized",
  15: "EngineUnauthorized",
  16: "EngineInvalidMatchingEngine",
  17: "EnginePnlNotWarmedUp",
  18: "EngineOverflow",
  19: "EngineAccountNotFound",
  20: "EngineNotAnLPAccount",
  21: "EnginePositionSizeMismatch",
  22: "EngineRiskReductionOnlyMode",
  23: "EngineAccountKindMismatch",
  24: "InvalidTokenAccount",
  25: "InvalidTokenProgram",
};

/**
 * Decode a custom program error code to its name.
 * Returns undefined if unknown.
 */
export function decodeError(code: number): string | undefined {
  return PERCOLATOR_ERRORS[code];
}

/**
 * Parse error from transaction logs.
 * Looks for "Program ... failed: custom program error: 0x..."
 */
export function parseErrorFromLogs(logs: string[]): {
  code: number;
  name: string;
} | null {
  for (const log of logs) {
    const match = log.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (match) {
      const code = parseInt(match[1], 16);
      const name = decodeError(code) ?? `Unknown(${code})`;
      return { code, name };
    }
  }
  return null;
}
