/**
 * Provider-error classification (T3.2) — the retryable-vs-terminal contract
 * the step-durable loop journals against.
 */

import { describe, expect, it } from "vitest";
import {
  PiProviderError,
  classifyProviderError,
  isAbortError,
  toPiProviderError,
} from "./pi-client.js";

describe("classifyProviderError", () => {
  it.each([
    ["request timed out after 60000ms", "PROVIDER_TIMEOUT"],
    ["fetch failed: ECONNREFUSED 127.0.0.1:443", "PROVIDER_UNREACHABLE"],
    ["429 rate limit exceeded", "PROVIDER_RATE_LIMITED"],
    ["503 service unavailable", "PROVIDER_UNAVAILABLE"],
    ["overloaded_error: Overloaded", "PROVIDER_UNAVAILABLE"],
    ["401 invalid api key", "PROVIDER_AUTH_FAILED"],
    ["400 invalid_request_error: prompt is too long", "PROVIDER_INVALID_REQUEST"],
    ["completely novel failure mode", "PROVIDER_ERROR"],
  ] as const)("classifies %j → %s", (message, expected) => {
    expect(classifyProviderError(new Error(message))).toBe(expected);
  });

  it("classifies nested causes", () => {
    const err = new Error("provider call failed", {
      cause: new Error("getaddrinfo ENOTFOUND api.anthropic.com"),
    });
    expect(classifyProviderError(err)).toBe("PROVIDER_UNREACHABLE");
  });
});

describe("toPiProviderError (retryable vs terminal)", () => {
  it.each([
    ["PROVIDER_TIMEOUT", true],
    ["PROVIDER_UNREACHABLE", true],
    ["PROVIDER_RATE_LIMITED", true],
    ["PROVIDER_UNAVAILABLE", true],
    ["PROVIDER_AUTH_FAILED", false],
    ["PROVIDER_INVALID_REQUEST", false],
    ["PROVIDER_ERROR", false],
  ] as const)("%s → retryable=%s", (code, retryable) => {
    expect(new PiProviderError({ code, message: "x" }).retryable).toBe(retryable);
  });

  it("is idempotent on an existing PiProviderError", () => {
    const original = new PiProviderError({ code: "PROVIDER_TIMEOUT", message: "t" });
    expect(toPiProviderError(original)).toBe(original);
  });

  it("wraps foreign errors with classification + provider/model tags", () => {
    const wrapped = toPiProviderError(new Error("429 rate limit"), {
      provider: "anthropic",
      model: "m1",
    });
    expect(wrapped.code).toBe("PROVIDER_RATE_LIMITED");
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.provider).toBe("anthropic");
    expect(wrapped.model).toBe("m1");
  });
});

describe("isAbortError", () => {
  it("matches AbortError-named and abort-worded rejections; rejects others", () => {
    const abort = new Error("The operation was aborted");
    const named = new Error("x");
    named.name = "AbortError";
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(named)).toBe(true);
    expect(isAbortError(new Error("429 rate limit"))).toBe(false);
    expect(isAbortError("not an error")).toBe(false);
  });
});
