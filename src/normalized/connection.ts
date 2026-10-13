import {
  Connection,
  type ConnectionConfig,
} from "@solana/web3.js";
import type { ExplicitRuntimeConfig } from "./config.js";

export type ConnectionFactory = (
  endpoint: string,
  config: ConnectionConfig,
) => Connection;

const defaultConnectionFactory: ConnectionFactory = (endpoint, config) => (
  new Connection(endpoint, config)
);

export function createSafeConnection(
  config: ExplicitRuntimeConfig,
  factory: ConnectionFactory = defaultConnectionFactory,
): Connection {
  return factory(config.rpcUrl, {
    commitment: config.commitment,
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: config.confirmationTimeoutMs,
  });
}
