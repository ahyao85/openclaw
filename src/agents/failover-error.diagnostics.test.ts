import { describe, expect, it, vi } from "vitest";
import { diagnosticErrorFailureKind } from "../infra/diagnostic-error-metadata.js";
import { attachErrorDiagnostic, formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  buildFailoverRemediationHint,
  buildProviderReauthCommand,
  coerceToFailoverError,
  describeFailoverError,
  FailoverError,
  hasProviderRequestSizeCeiling,
  isTimeoutError,
} from "./failover-error.js";
import { isLikelyContextOverflowError } from "./failover/classify.js";

// Provider hooks do not classify these native process-exit fixtures.
vi.mock("../plugins/provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-hook-runtime.js")>();
  return {
    ...actual,
    resolveProviderHookPlugin: () => undefined,
    resolveProviderPluginsForHooks: () => [],
  };
});

describe("failover diagnostic isolation", () => {
  it.each(["raw", "typed", "serialized"] as const)(
    "normalizes published local-profile HTTP status from a %s error without changing its owner",
    (shape) => {
      const message =
        'Codex app-server auth profile "openai:default" was not found. Select an existing OpenAI profile or sign in again with OpenClaw, then retry.';
      const cause = new Error("profile store lookup missed");
      const context = {
        provider: "openai",
        model: "gpt-5.5",
        profileId: "openai:default",
        authMode: "oauth",
        sessionId: "session:local-profile",
        lane: "main",
      };
      const facts = {
        ...context,
        reason: "auth" as const,
        status: 401,
        code: "selected_auth_profile_unavailable",
        rawError: message,
        cause,
      };
      const original = Object.freeze(
        shape === "serialized"
          ? { ...facts, name: "FailoverError", message }
          : shape === "typed"
            ? new FailoverError(message, facts)
            : Object.assign(new Error(message, { cause }), facts),
      );
      if (original instanceof Error) {
        attachErrorDiagnostic(original, "profile owner: OpenClaw credential store");
      }

      expect.soft(describeFailoverError(original)).toMatchObject({
        message,
        code: facts.code,
        status: undefined,
      });
      const normalized = coerceToFailoverError(original, shape === "raw" ? context : undefined);
      expect.soft(normalized).toMatchObject({
        ...facts,
        status: undefined,
        cause: shape === "raw" ? original : cause,
      });
      expect(normalized?.message).toBe(message);
      expect(buildFailoverRemediationHint(normalized)).toBeUndefined();
      expect(original.status).toBe(401);
      expect(original.message).toBe(message);
      if (shape === "typed") {
        expect(formatErrorMessageForDisplay(normalized)).toContain("profile owner: OpenClaw");
      }
    },
  );

  it("retains a genuine provider HTTP 401 and its recovery hint", () => {
    const original = Object.freeze(Object.assign(new Error("invalid_api_key"), { status: 401 }));
    const normalized = coerceToFailoverError(original, { provider: "openai" });

    expect(describeFailoverError(original).status).toBe(401);
    expect(normalized).toMatchObject({ reason: "auth", status: 401, cause: original });
    expect(buildFailoverRemediationHint(normalized)).toContain("Re-authenticate with:");
  });

  it.each([
    "Rate limit exceeded",
    "Authentication failed: invalid_api_key",
    "Request timed out; operation was aborted",
    "INVALID_ARGUMENT: input exceeds the maximum number of tokens",
    "413 Request too large on tokens per minute (TPM): Limit 8000, Requested 8098",
  ])("keeps supplemental process diagnostics out of failure policy: %s", (diagnostic) => {
    const native = Object.freeze(new Error("Claude Code process exited with code 1"));
    const error = attachErrorDiagnostic(native, diagnostic);

    expect(error).toBe(native);
    expect(formatErrorMessageForDisplay(error)).toContain(diagnostic);
    for (const candidate of [error, new Error("Plugin execution failed", { cause: error })]) {
      expect(coerceToFailoverError(candidate)).toBeNull();
      expect(isTimeoutError(candidate)).toBe(false);
      expect(diagnosticErrorFailureKind(candidate)).toBeUndefined();
      expect(hasProviderRequestSizeCeiling(candidate)).toBe(false);
      expect(isLikelyContextOverflowError(formatErrorMessage(candidate))).toBe(false);
      expect(formatErrorMessage(candidate)).not.toContain(diagnostic);
    }
    expect(
      hasProviderRequestSizeCeiling(new AggregateError([{ error }], "Plugin execution failed")),
    ).toBe(false);
  });
});

describe("buildFailoverRemediationHint", () => {
  it("returns a copy-pasteable login command for auth failures", () => {
    const err = new FailoverError("missing token", {
      reason: "auth",
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(buildFailoverRemediationHint(err)).toBe(
      "Re-authenticate with: openclaw models auth login --provider 'anthropic' --force",
    );
  });

  it("routes Gemini CLI auth failures to supported recovery paths", () => {
    const err = new FailoverError("revoked", {
      reason: "auth_permanent",
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
    });
    expect(buildFailoverRemediationHint(err)).toBe(
      "Authenticate in Gemini CLI directly, or configure a supported Google API key with: openclaw configure",
    );
  });

  it("quotes provider ids that contain shell metacharacters", () => {
    expect(buildProviderReauthCommand("custom;touch /tmp/pwned")).toBe(
      "openclaw models auth login --provider 'custom;touch /tmp/pwned' --force",
    );
    expect(buildProviderReauthCommand("custom'provider")).toBe(
      "openclaw models auth login --provider 'custom'\\''provider' --force",
    );
  });

  it("refuses control characters in rendered provider commands", () => {
    expect(buildProviderReauthCommand("custom\nprovider")).toBeUndefined();
  });

  it("wraps rendered provider commands in the standard CLI formatter", () => {
    expect(buildProviderReauthCommand("anthropic", { OPENCLAW_PROFILE: "work" })).toBe(
      "openclaw --profile work models auth login --provider 'anthropic' --force",
    );
    expect(buildProviderReauthCommand("anthropic", { OPENCLAW_CONTAINER_HINT: "dev" })).toBe(
      "openclaw --container dev models auth login --provider 'anthropic' --force",
    );
  });

  it("returns undefined for non-auth reasons", () => {
    const err = new FailoverError("429", {
      reason: "rate_limit",
      provider: "openai",
      model: "gpt-5",
    });
    expect(buildFailoverRemediationHint(err)).toBeUndefined();
  });

  it("returns undefined when provider is not attributed", () => {
    const err = new FailoverError("no token", {
      reason: "auth",
      model: "claude-opus-4-7",
    });
    expect(buildFailoverRemediationHint(err)).toBeUndefined();
  });

  it("returns undefined for non-FailoverError inputs", () => {
    expect(buildFailoverRemediationHint(new Error("oops"))).toBeUndefined();
    expect(buildFailoverRemediationHint(undefined)).toBeUndefined();
    expect(buildFailoverRemediationHint("just a string")).toBeUndefined();
  });
});
