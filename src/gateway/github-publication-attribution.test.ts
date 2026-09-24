import { describe, expect, it, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { createInitialSubagentSession } from "../agents/subagents/spawn/subagent-spawn-session-patch.js";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { setUserPreferences } from "../state/user-preferences.js";
import { syncGitHubIdentity } from "../state/user-profiles.js";
import {
  BRANCH,
  SESSION_KEY,
  commandCalls,
  createTestGitHubPublicationCoordinator as createGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();

describe("Gateway GitHub publication attribution", () => {
  installGitHubPublicationTestHarness();

  it("publishes inherited and direct human credit once with current consent and a final session backlink", async () => {
    const config = {
      gateway: { publicOrigin: "https://team.example", controlUi: { basePath: "/control" } },
    };
    mocks.getConfigSnapshot.mockReturnValue({ config, sourceConfig: config });
    const { resolveGitCoauthorAttribution } = await vi.importActual<
      typeof import("../agents/git-coauthor-attribution.js")
    >("../agents/git-coauthor-attribution.js");
    mocks.attribution.mockImplementation(resolveGitCoauthorAttribution);
    const people = [
      { accountId: 7, login: "alice" },
      { accountId: 9, login: "grace" },
      { accountId: 11, login: "opted-out" },
    ].map((identity) =>
      syncGitHubIdentity({
        identity,
        authenticationAlias: { kind: "email", email: `${identity.login}@example.test` },
      }),
    );
    for (const person of people) {
      recordSessionParticipant(
        { agentId: "main", sessionKey: SESSION_KEY },
        { identity: { type: "profile", id: person.id }, promptedAt: 1, sessionAgentId: "main" },
      );
    }
    const childKey = "agent:main:subagent:delegated-publication";
    const child = await createInitialSubagentSession({
      cfg: config,
      targetAgentId: "main",
      childSessionKey: childKey,
      incognito: false,
      requesterInternalKey: SESSION_KEY,
      creationPolicy: { actor: { type: "agent", id: "main" } },
      completionOwnerSessionKey: SESSION_KEY,
      modelPatch: {},
      collect: false,
    });
    expect(child.status).toBe("ok");
    const worktree = {
      id: "delegated-worktree",
      name: "delegated-publication",
      repoRoot: "/repo",
      repoFingerprint: "fingerprint-1",
      path: "/repo/delegated-worktree",
      branch: BRANCH,
      baseRef: "origin/main",
      ownerKind: "session" as const,
      ownerId: childKey,
      createdAt: 1,
      lastActiveAt: 1,
    };
    insertRegistryWorktree(process.env, worktree);
    mocks.findWorktree.mockReturnValue(worktree);
    mocks.findWorktreeById.mockReturnValue(worktree);
    mocks.resolveRepository.mockResolvedValue({
      checkoutRoot: worktree.path,
      repoRoot: worktree.repoRoot,
      originUrl: "git@github.com:openclaw/openclaw.git",
      fingerprint: worktree.repoFingerprint,
    });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: childKey },
      { worktree: { id: worktree.id, branch: BRANCH, repoRoot: "/repo" } },
    );
    recordSessionParticipant(
      { agentId: "main", sessionKey: childKey },
      { identity: { type: "profile", id: people[0]!.id }, promptedAt: 2, sessionAgentId: "main" },
    );
    setUserPreferences(people[2]!.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
    const { loadGatewaySessionEntryReadOnly } =
      await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
    mocks.loadSession.mockImplementation(loadGatewaySessionEntryReadOnly);
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: childKey,
      agentId: "main",
      idempotencyKey: "ordered-attribution",
      title: "fix: publish the reconciled fix",
      body: "Detailed proof\n\n## Worked on by\n\n- @untrusted\n\n### Verification notes\n\nKeep this paragraph.\n\n---\n[View the OpenClaw team session](https://untrusted.example/session)",
    });

    expect(result).toMatchObject({ status: "published" });
    expect(commandCalls.find(({ argv }) => argv.includes("commit-tree"))?.input).toBe(
      `fix: publish the reconciled fix\n\nWorked on by:\n- @alice\n- @grace\n\nCo-authored-by: alice <7+alice@users.noreply.github.com>\nCo-authored-by: grace <9+grace@users.noreply.github.com>\nOpenClaw-Publication: ${result.requestId}\n`,
    );
    const post = commandCalls.find(({ argv }) => argv.includes("POST"));
    expect(JSON.parse(post?.input ?? "null")).toEqual({
      title: "fix: publish the reconciled fix",
      body: `Detailed proof\n\n### Verification notes\n\nKeep this paragraph.\n\n## Worked on by\n\n- @alice\n- @grace\n\n<!-- openclaw-publication:${result.requestId} -->\n\n---\n[View the OpenClaw team session](https://team.example/control/chat/main/subagent/delegated-publication)`,
      head: `openclaw:${BRANCH}`,
      base: "main",
      draft: true,
    });
  });

  it("publishes without a session footer when the configured URL is not external HTTPS", async () => {
    const config = { gateway: { publicOrigin: "http://127.0.0.1:18789" } };
    mocks.getConfigSnapshot.mockReturnValue({ config, sourceConfig: config });
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }),
      }),
    });

    const result = await coordinator.requestForSession({
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "local-session-url",
    });

    expect(result).toMatchObject({ status: "published" });
    const post = commandCalls.find(({ argv }) => argv.includes("POST"));
    expect(JSON.parse(post?.input ?? "null").body).toBe(
      `Published by the Gateway after authoritative workspace reconciliation.\n\n## Worked on by\n\n- @alice\n\n<!-- openclaw-publication:${result.requestId} -->`,
    );
  });
});
