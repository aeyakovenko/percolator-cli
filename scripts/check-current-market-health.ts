/** Read-only current-market custody and matcher-capital diagnostic. */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  AccountLayout,
  AccountState,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  abortableSleep,
  RpcOperationSignalScope,
  runDeadlineBoundOperation,
  safeErrorMessage,
} from "./keeper-runtime.ts";
import {
  DEFAULT_COHERENCE_WINDOW_MS,
  formatV16HealthCoherence,
  monitorV16HealthCoherence,
} from "./v16-market-coherence.ts";
import {
  assessV16MarketHealth,
  formatV16MarketHealth,
  parseUsdcFloor,
  readV16MarketCollateralMint,
  readV16MarketHealthSnapshot,
} from "./v16-market-health.ts";
import {
  resolveV16AuditProfile,
  type V16AuditProfile,
} from "./v16-audit-profile.ts";
import {
  resolveExplicitRuntimeConfig,
  type ExplicitRuntimeConfig,
} from "../src/normalized/config.ts";

export interface V16HealthCheckConfig {
  auditProfile: V16AuditProfile;
  lpPortfolio: PublicKey;
  market: PublicKey;
  minimumLpCapital: bigint;
  runtime: ExplicitRuntimeConfig;
}

function requiredSetting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the read-only v16 health check`);
  return value;
}

function requiredPublicKey(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): PublicKey {
  try {
    return new PublicKey(requiredSetting(env, name));
  } catch (error) {
    if (error instanceof Error && error.message.includes(" is required ")) throw error;
    throw new Error(`${name} must be a base58 Solana public key`);
  }
}

export function resolveV16HealthCheckConfig(
  env: Readonly<Record<string, string | undefined>>,
): V16HealthCheckConfig {
  const programId = requiredPublicKey(env, "PROGRAM_ID");
  const runtime = resolveExplicitRuntimeConfig({
    rpcUrl: requiredSetting(env, "RPC_URL"),
    programId,
    commitment: "confirmed",
  });
  return {
    auditProfile: resolveV16AuditProfile(env),
    lpPortfolio: requiredPublicKey(env, "LP_PORTFOLIO"),
    market: requiredPublicKey(env, "MARKET"),
    minimumLpCapital: parseUsdcFloor(env.LP_MIN_CAPITAL_USDC),
    runtime,
  };
}

function safeSlotNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("RPC context slot is outside the safe integer range");
  }
  return Number(value);
}

async function main(): Promise<void> {
  const config = resolveV16HealthCheckConfig(process.env);
  const { auditProfile, lpPortfolio, market, minimumLpCapital, runtime } = config;
  const rpcSignals = new RpcOperationSignalScope();
  const connection = new Connection(runtime.rpcUrl, {
    commitment: runtime.commitment,
    disableRetryOnRateLimit: true,
    fetchMiddleware: (url, options, fetch) => fetch(url, {
      ...(options ?? {}),
      signal: rpcSignals.currentSignal() ?? options?.signal,
    }),
  });
  const coherence = await runDeadlineBoundOperation({
    parentSignal: new AbortController().signal,
    timeoutMs: DEFAULT_COHERENCE_WINDOW_MS + 15_000,
    work: (signal) => rpcSignals.run(signal, async () => {
      const discovery = await connection.getAccountInfoAndContext(market, {
        commitment: runtime.commitment,
      });
      if (!discovery.value || !discovery.value.owner.equals(runtime.programId)) {
        throw new Error("configured v16 market account is unavailable");
      }
      const collateralMint = new PublicKey(readV16MarketCollateralMint(
        Buffer.from(discovery.value.data),
        market.toBytes(),
      ));
      const vaultAuthority = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), market.toBuffer()],
        runtime.programId,
      )[0];
      const vaultAta = getAssociatedTokenAddressSync(collateralMint, vaultAuthority, true);

      return monitorV16HealthCoherence({
        readSample: async (previousContextSlot) => {
          const requestedContextSlot = previousContextSlot === undefined
            ? BigInt(discovery.context.slot)
            : previousContextSlot > BigInt(discovery.context.slot)
              ? previousContextSlot
              : BigInt(discovery.context.slot);
          const accounts = await connection.getMultipleAccountsInfoAndContext(
            [market, lpPortfolio, vaultAta],
            {
              commitment: runtime.commitment,
              minContextSlot: safeSlotNumber(requestedContextSlot),
            },
          );
          const [marketInfo, lpInfo, custodyInfo] = accounts.value;
          if (!marketInfo || !marketInfo.owner.equals(runtime.programId)) {
            throw new Error("configured v16 market account is unavailable");
          }
          if (!lpInfo || !lpInfo.owner.equals(runtime.programId)) {
            throw new Error("configured matcher LP portfolio is unavailable");
          }
          if (!custodyInfo || !custodyInfo.owner.equals(TOKEN_PROGRAM_ID)) {
            throw new Error("configured market custody token account is unavailable");
          }
          if (custodyInfo.data.length !== AccountLayout.span) {
            throw new Error("configured market custody token account has the wrong length");
          }

          const marketData = Buffer.from(marketInfo.data);
          const sampledCollateralMint = new PublicKey(readV16MarketCollateralMint(
            marketData,
            market.toBytes(),
          ));
          if (!sampledCollateralMint.equals(collateralMint)) {
            throw new Error("market collateral mint changed inside the coherence window");
          }
          const custody = AccountLayout.decode(custodyInfo.data);
          if (!custody.mint.equals(collateralMint) || !custody.owner.equals(vaultAuthority)) {
            throw new Error("configured market custody token account identity is invalid");
          }
          if (custody.state !== AccountState.Initialized) {
            throw new Error("configured market custody token account is not initialized");
          }

          return assessV16MarketHealth(readV16MarketHealthSnapshot({
            custodyBalance: custody.amount,
            expectedLpPortfolio: lpPortfolio.toBytes(),
            expectedMarket: market.toBytes(),
            lpData: Buffer.from(lpInfo.data),
            marketData,
            observedClusterSlot: BigInt(accounts.context.slot),
          }), minimumLpCapital, auditProfile.options);
        },
        sleep: (ms) => abortableSleep(ms, signal),
      });
    }),
  });
  console.log(`AUDIT PROFILE ${auditProfile.name.toUpperCase()}`);
  console.log(formatV16MarketHealth(coherence.assessment));
  console.log(formatV16HealthCoherence(coherence));
  if (coherence.kind === "failed"
    || coherence.assessment.level === "critical"
    || coherence.assessment.level === "invalid") {
    process.exitCode = 2;
  }
}

if (process.argv[1]?.endsWith("check-current-market-health.ts")) {
  void import("dotenv/config")
    .then(() => main())
    .catch((error: unknown) => {
      console.error(safeErrorMessage(error));
      process.exitCode = 1;
    });
}
