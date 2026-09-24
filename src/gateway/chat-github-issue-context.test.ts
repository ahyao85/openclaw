import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../auto-reply/templating.js";

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  getWorkspace: vi.fn(),
  parseTarget: vi.fn(),
  prepareIdentity: vi.fn(),
  readJson: vi.fn(),
}));

vi.mock("../state/session-repository-workspaces.js", () => ({
  getSessionRepositoryWorkspaceStore: () => ({ get: mocks.getWorkspace }),
}));
vi.mock("./project-github-identity.js", () => ({
  prepareGatewayProjectGitHubIdentity: mocks.prepareIdentity,
}));
vi.mock("./github-public-api.js", () => ({
  gitHubPublicApi: {
    GITHUB_API_ORIGIN: "https://api.microsoft.ghe.com",
    ControlUiGitHubError: class extends Error {
      constructor(
        readonly statusCode: number,
        message: string,
      ) {
        super(message);
      }
    },
    fetchGitHubApi: mocks.fetchApi,
    isRecord: (value: unknown) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
    optionalNumber: (value: Record<string, unknown>, key: string) =>
      typeof value[key] === "number" ? value[key] : undefined,
    parseGitHubTarget: mocks.parseTarget,
    readGitHubJsonResponse: mocks.readJson,
    readOptionalGitHubString: (value: Record<string, unknown>, key: string) =>
      typeof value[key] === "string" && value[key] ? value[key] : undefined,
    requiredString: (value: Record<string, unknown>, key: string) => {
      const result = value[key];
      if (typeof result !== "string" || !result) throw new Error(`missing ${key}`);
      return result;
    },
  },
}));

import {
  attachSessionGitHubIssueContext,
  parseSessionGitHubIssueTarget,
} from "./chat-github-issue-context.js";

describe("Gateway GitHub issue context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_GITHUB_HOST", "microsoft.ghe.com");
    mocks.parseTarget.mockImplementation((value) => value);
    mocks.fetchApi.mockResolvedValue(new Response());
    mocks.readJson.mockReset();
  });

  it("accepts only the selected enterprise repository's exact issue URL", () => {
    expect(
      parseSessionGitHubIssueTarget({
        message: "Read https://microsoft.ghe.com/bic/lobster/issues/15938.",
        repositoryUrl: "https://microsoft.ghe.com/bic/lobster.git",
      }),
    ).toMatchObject({ owner: "bic", repo: "lobster", number: 15938 });
    for (const message of [
      "https://github.com/bic/lobster/issues/15938",
      "https://microsoft.ghe.com/bic/other/issues/15938",
      "https://microsoft.ghe.com/bic/lobster/pull/15938",
      "https://microsoft.ghe.com/bic/lobster/issues/15938?token=private",
    ]) {
      expect(
        parseSessionGitHubIssueTarget({
          message,
          repositoryUrl: "https://microsoft.ghe.com/bic/lobster.git",
        }),
      ).toBeUndefined();
    }
  });

  it("injects bounded untrusted issue data without forwarding the credential", async () => {
    const assertSelected = vi.fn();
    mocks.getWorkspace.mockReturnValue({
      agentId: "main",
      url: "https://microsoft.ghe.com/bic/lobster.git",
    });
    mocks.prepareIdentity.mockResolvedValue({
      token: "must-not-enter-context",
      assertSelected,
      start: async (operation: () => unknown) => await operation(),
    });
    mocks.readJson
      .mockResolvedValueOnce({
        title: "Synthetic issue",
        body: "b".repeat(30_000),
        state: "open",
        user: { login: "owner" },
        comments: 9,
        created_at: "2026-09-24T00:00:00Z",
        updated_at: "2026-09-24T01:00:00Z",
      })
      .mockResolvedValueOnce(
        Array.from({ length: 9 }, (_, index) => ({
          user: { login: `author-${index}` },
          body: "c".repeat(3_000),
          created_at: "2026-09-24T02:00:00Z",
        })),
      );
    const templateContext: TemplateContext = {};
    await attachSessionGitHubIssueContext({
      agentId: "main",
      assertActive: vi.fn(),
      config: {},
      context: { getRuntimeConfig: () => ({}) },
      message: "Read https://microsoft.ghe.com/bic/lobster/issues/15938",
      repositoryWorkspaceId: "workspace-1",
      templateContext,
    });

    expect(assertSelected).toHaveBeenCalled();
    expect(mocks.fetchApi).toHaveBeenCalledWith(
      "https://api.microsoft.ghe.com/repos/bic/lobster/issues/15938",
      expect.any(Function),
      "must-not-enter-context",
      expect.any(Function),
      expect.objectContaining({ token: "must-not-enter-context" }),
    );
    const serialized = JSON.stringify(templateContext);
    expect(serialized).toContain("GitHub issue context (untrusted external content)");
    expect(serialized).toContain("Synthetic issue");
    expect(serialized).not.toContain("must-not-enter-context");
    const payload = templateContext.ChannelStructuredContext?.[0]?.payload as {
      body: string;
      comments: Array<{ body: string }>;
      comments_truncated: boolean;
    };
    expect(payload.body).toHaveLength(24 * 1024);
    expect(payload.comments).toHaveLength(8);
    expect(payload.comments[0]?.body).toHaveLength(2 * 1024);
    expect(payload.comments_truncated).toBe(true);
  });
});
