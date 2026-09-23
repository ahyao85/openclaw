import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("GitHub API origin", () => {
  it("defaults to public GitHub", async () => {
    vi.stubEnv("OPENCLAW_GITHUB_API_BASE_URL", "");
    const { GITHUB_API_ORIGIN } = await import("./github-api.js");
    expect(GITHUB_API_ORIGIN).toBe("https://api.github.com");
  });

  it("uses the configured enterprise API origin", async () => {
    vi.stubEnv("OPENCLAW_GITHUB_API_BASE_URL", "https://api.microsoft.ghe.com/");
    const { GITHUB_API_ORIGIN } = await import("./github-api.js");
    expect(GITHUB_API_ORIGIN).toBe("https://api.microsoft.ghe.com");
  });

  it.each([
    "http://api.microsoft.ghe.com",
    "https://user@example.com",
    "https://api.microsoft.ghe.com/api/v3",
  ])("rejects unsafe configured API origin %s", async (origin) => {
    vi.stubEnv("OPENCLAW_GITHUB_API_BASE_URL", origin);
    await expect(import("./github-api.js")).rejects.toThrow(
      "OPENCLAW_GITHUB_API_BASE_URL must be an HTTPS origin",
    );
  });
});
