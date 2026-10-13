import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PYTH_HERMES_URL,
  PythHermesConfigurationError,
  pythHermesHeaders,
  pythHermesUrl,
  requirePythHermesConfiguration,
} from "./pyth-hermes.ts";

test("authenticated Hermes configuration fails closed without an API key", () => {
  assert.throws(() => requirePythHermesConfiguration({}), PythHermesConfigurationError);
  assert.throws(
    () => requirePythHermesConfiguration({ PYTH_API_KEY: " \n " }),
    PythHermesConfigurationError,
  );
});

test("Hermes requests use the authenticated Core endpoint and bearer authentication", () => {
  const configuration = requirePythHermesConfiguration({ PYTH_API_KEY: " test-token " });
  assert.equal(configuration.baseUrl, DEFAULT_PYTH_HERMES_URL);
  assert.deepEqual(pythHermesHeaders(configuration), {
    Accept: "application/json",
    Authorization: "Bearer test-token",
  });
  const url = pythHermesUrl(configuration, "/v2/updates/price/latest", [
    ["ids[]", "feed-a"],
    ["ids[]", "feed-b"],
  ]);
  assert.equal(
    url,
    "https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=feed-a&ids%5B%5D=feed-b",
  );
  assert.doesNotMatch(url, /test-token/);
});

test("custom providers must be credential-free HTTPS endpoints", () => {
  const configuration = requirePythHermesConfiguration({
    PYTH_API_KEY: "test-token",
    PYTH_HERMES_URL: "https://provider.example/hermes/",
  });
  assert.equal(configuration.baseUrl, "https://provider.example/hermes");

  for (const value of [
    "http://provider.example/hermes",
    "https://user:password@provider.example/hermes",
    "https://provider.example/hermes?token=secret",
    "not-a-url",
  ]) {
    assert.throws(
      () => requirePythHermesConfiguration({
        PYTH_API_KEY: "test-token",
        PYTH_HERMES_URL: value,
      }),
      PythHermesConfigurationError,
    );
  }
});

test("credential validation never repeats the credential in its error", () => {
  const credential = "private-token\nwith-newline";
  assert.throws(
    () => requirePythHermesConfiguration({ PYTH_API_KEY: credential }),
    (error: unknown) => error instanceof Error && !error.message.includes(credential),
  );
});
