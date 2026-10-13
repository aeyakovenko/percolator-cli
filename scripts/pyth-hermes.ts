export const DEFAULT_PYTH_HERMES_URL = "https://hermes.pyth.network";

export interface PythHermesEnvironment {
  PYTH_API_KEY?: string;
  PYTH_HERMES_URL?: string;
  [name: string]: string | undefined;
}

export interface PythHermesConfiguration {
  accessToken: string;
  baseUrl: string;
}

export class PythHermesConfigurationError extends Error {}

function normalizeBaseUrl(value: string | undefined): string {
  const configured = value?.trim() || DEFAULT_PYTH_HERMES_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new PythHermesConfigurationError("PYTH_HERMES_URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new PythHermesConfigurationError(
      "PYTH_HERMES_URL must be credential-free HTTPS without a query or fragment.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function requirePythHermesConfiguration(
  env: PythHermesEnvironment,
): PythHermesConfiguration {
  const accessToken = env.PYTH_API_KEY?.trim();
  if (!accessToken) {
    throw new PythHermesConfigurationError(
      "PYTH_API_KEY is required for authenticated Hermes access.",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(accessToken)) {
    throw new PythHermesConfigurationError("PYTH_API_KEY contains invalid control characters.");
  }
  return {
    accessToken,
    baseUrl: normalizeBaseUrl(env.PYTH_HERMES_URL),
  };
}

export function pythHermesHeaders(
  configuration: PythHermesConfiguration,
): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${configuration.accessToken}`,
  };
}

export function pythHermesUrl(
  configuration: PythHermesConfiguration,
  pathname: string,
  query: readonly (readonly [string, string])[],
): string {
  const url = new URL(pathname.replace(/^\/+/, ""), `${configuration.baseUrl}/`);
  for (const [name, value] of query) url.searchParams.append(name, value);
  return url.toString();
}
