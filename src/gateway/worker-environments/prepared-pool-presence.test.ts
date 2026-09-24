import { describe, expect, it, vi } from "vitest";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence-store.js";
import {
  PREPARATION_KEY,
  PROJECT_KEY,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";
import type { RepositoryWorkerProjectSnapshot } from "./workspace-git-base.js";

describe("authenticated human prepared-pool demand", () => {
  const fixture = usePreparedPoolFixture();
  const repository: RepositoryWorkerProjectSnapshot = {
    key: PROJECT_KEY,
    baseCommit: "d".repeat(40),
    source: {
      kind: "repository",
      url: "https://github.com/bic/lobster.git",
      repositoryId: "R_bic_lobster",
      owner: {
        agent: { agentId: "main", provenance: null },
        identity: { source: "anonymous" },
      },
    },
  };

  function presencePool(
    initial?: PreparedPoolPresenceDemand,
    executionMode: "worker-turn" | "remote-exec" = "remote-exec",
  ) {
    let persisted = initial;
    const write = vi.fn<NonNullable<PoolOptions["presenceDemandStore"]>["write"]>(
      async (value, assertCurrent) => {
        assertCurrent();
        persisted = value ?? undefined;
        return persisted;
      },
    );
    fixture.config.cloudWorkers!.preparedPool = { maxTotal: 3 };
    fixture.developmentProfile.readyWorkers = 3;
    const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>(async (_profileId, options) => {
      const profileSnapshot = fixture.profile(
        PROJECT_KEY,
        PREPARATION_KEY,
        undefined,
        options.projectRepository ?? repository,
      );
      delete profileSnapshot.executionMode;
      if (options.executionMode) {
        profileSnapshot.executionMode = options.executionMode;
      }
      return {
        providerId: fixture.provider.id,
        profileSnapshot,
        preparationKey: PREPARATION_KEY,
      };
    });
    const owner = fixture.pool({
      prepareIntent,
      resolveHumanPresenceDemand: () => ({
        profileId: "development",
        executionMode,
        repository: { agentId: "main", url: repository.source.url, ref: "main" },
      }),
      presenceDemandStore: { read: async () => persisted, write },
    });
    return { owner, prepareIntent, write, read: () => persisted };
  }

  it("fills three exact-repository reserves, stops refill on departure, and retires after 15m", async () => {
    const presence = presencePool();
    await presence.owner.setHumanPresence(true);
    expect(fixture.reserves()).toHaveLength(3);
    expect(fixture.reserves().map((record) => record.profileSnapshot.project)).toEqual([
      expect.objectContaining(repository),
      expect.objectContaining(repository),
      expect.objectContaining(repository),
    ]);
    expect(presence.read()).toMatchObject({
      profileId: "development",
      requestedRef: "main",
      preparationKey: PREPARATION_KEY,
      lastPresentAtMs: 1_000,
      retireAtMs: null,
    });

    await presence.owner.setHumanPresence(false);
    expect(presence.read()?.retireAtMs).toBe(901_000);
    fixture.destroy(fixture.ready(fixture.reserves()[0]!));
    fixture.nowMs = 900_999;
    await fixture.schedule(presence.owner);
    expect(fixture.reserves()).toHaveLength(3);
    expect(fixture.reserves().filter((record) => record.state !== "destroyed")).toHaveLength(2);

    fixture.nowMs = 901_000;
    await fixture.schedule(presence.owner);
    expect(fixture.reserves().filter((record) => record.state !== "destroyed")).toSatisfy(
      (records) => records.every((record) => record.destroyRequestedAtMs === 901_000),
    );
  });

  it("closes a crash-left active marker on restart and reuses its pinned ref until retirement settles", async () => {
    const active: PreparedPoolPresenceDemand = {
      revision: 4,
      profileId: "development",
      requestedRef: "main",
      preparationKey: PREPARATION_KEY,
      project: repository,
      lastPresentAtMs: 500,
      retireAtMs: null,
    };
    fixture.seed("retiring-presence-source", { reserve: true, repository });
    const presence = presencePool(active);

    await presence.owner.setHumanPresence(false);
    expect(presence.read()).toMatchObject({ revision: 5, retireAtMs: 901_000 });

    fixture.nowMs = 901_001;
    await presence.owner.setHumanPresence(true);
    expect(presence.prepareIntent).toHaveBeenCalledWith(
      "development",
      expect.objectContaining({ projectRepository: repository }),
    );
  });

  it("keeps later activation demand eligible after the presence grace expires", async () => {
    const source = fixture.ready(
      fixture.seed("activated-presence-source", { reserve: true, repository }),
    );
    fixture.teardown(fixture.attach(source, "active", 1_400));
    fixture.nowMs = 1_600;
    const presence = presencePool({
      revision: 2,
      profileId: "development",
      requestedRef: "main",
      preparationKey: PREPARATION_KEY,
      project: repository,
      lastPresentAtMs: 500,
      retireAtMs: 1_500,
    });

    await presence.owner.setHumanPresence(false);
    expect(fixture.reserves().filter((record) => record.state !== "destroyed")).toHaveLength(3);
    expect(presence.read()?.retireAtMs).toBe(1_500);
  });

  it("retires stale preparation generations before current presence demand can refill", async () => {
    const staleKey = "e".repeat(64);
    for (let index = 0; index < 3; index += 1) {
      fixture.seed(`stale-presence-${index}`, {
        reserve: true,
        repository,
        preparationKey: staleKey,
      });
    }
    fixture.nowMs = 2_001;
    const presence = presencePool();

    await presence.owner.setHumanPresence(true);
    const stale = fixture.reserves().filter((record) => record.preparation?.key === staleKey);
    expect(stale).toHaveLength(3);
    expect(stale.every((record) => record.destroyRequestedAtMs === 2_001)).toBe(true);
    expect(
      fixture.reserves().filter((record) => record.preparation?.key === PREPARATION_KEY),
    ).toHaveLength(0);

    for (const record of stale) {
      fixture.store.transition({
        environmentId: record.environmentId,
        from: "requested",
        to: "failed",
        patch: { lastError: "fixture cleanup" },
      });
    }
    await fixture.schedule(presence.owner);
    expect(
      fixture
        .reserves()
        .filter(
          (record) => record.state !== "destroyed" && record.preparation?.key === PREPARATION_KEY,
        ),
    ).toHaveLength(3);
  });
});
