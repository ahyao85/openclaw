import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { refreshSerializedOAuthCredential } from "./oauth-refresh-fence.js";
import { createCredential } from "./oauth-refresh-fence.test-support.js";
import { isPendingOAuthRefreshFence } from "./oauth-refresh-marker.js";
import type { OAuthCredential } from "./types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("serialized OAuth refresh generation fence", () => {
  it("keeps serialized provider I/O outside locks and settles after observer timeout", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const profileId = "openai:default";
    const expired = createCredential({
      access: "serialized-access",
      refresh: "serialized-refresh",
      expires: 1,
      accountId: "acct-123",
    });
    let persisted = JSON.stringify({ [profileId]: expired });
    let lockDepth = 0;
    const backend = {
      withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
        expect(lockDepth).toBe(0);
        lockDepth += 1;
        try {
          const update = fn(persisted);
          if (update.next !== undefined) {
            persisted = update.next;
          }
          return update.result;
        } finally {
          lockDepth -= 1;
        }
      },
    };
    const started = createDeferredCore();
    const release = createDeferredCore<{ apiKey: string; credential: OAuthCredential }>();
    const refresh = vi.fn(async () => {
      expect(lockDepth).toBe(0);
      started.resolve();
      return await release.promise;
    });
    const run = async (
      refreshOwner: (
        credential: OAuthCredential,
      ) => Promise<{ apiKey: string; credential: OAuthCredential } | null>,
    ) =>
      await refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: "test serialized refresh",
        timeoutMs: 100,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
        canRefresh: async () => true,
        refresh: refreshOwner,
        resolve: async (credential) => ({ apiKey: credential.access, credential }),
        commit: () => {},
      });

    const work = new AsyncWorkScope();
    const first = work.run(() => run(refresh));
    await started.promise;
    expect(JSON.parse(persisted)[profileId].access).toMatch(
      /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:access:[a-f0-9]{64}$/,
    );
    const firstTimedOut = expect(first).rejects.toThrow("exceeded hard timeout (100ms)");
    await vi.advanceTimersByTimeAsync(100);
    await firstTimedOut;
    const drained = vi.fn();
    const drain = work.drain().then(drained);
    await vi.advanceTimersByTimeAsync(0);
    const drainedBeforeSettlement = drained.mock.calls.length;
    const peerRefresh = vi.fn(async () => null);
    const peer = run(peerRefresh);

    release.resolve({
      apiKey: "serialized-rotated-access",
      credential: createCredential({
        access: "serialized-rotated-access",
        refresh: "serialized-rotated-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-123",
      }),
    });
    await drain;
    // A peer may have read the fence before rotation; drive its poll, not microtask ordering.
    await vi.advanceTimersByTimeAsync(25);
    await expect(peer).resolves.toMatchObject({ apiKey: "serialized-rotated-access" });
    expect(drainedBeforeSettlement).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
    expect(peerRefresh).not.toHaveBeenCalled();
    expect(JSON.parse(persisted)[profileId]).toMatchObject({
      access: "serialized-rotated-access",
      refresh: "serialized-rotated-refresh",
    });
  });

  it("rejects a different-account replacement for serialized owner and observer settlement", async () => {
    const profileId = "openai:default";
    const expired = createCredential({
      access: "account-a-access",
      refresh: "account-a-refresh",
      expires: 1,
      accountId: "acct-a",
    });
    let persisted = JSON.stringify({ [profileId]: expired });
    const backend = {
      withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
    };
    const started = createDeferredCore();
    const release = createDeferredCore<{ apiKey: string; credential: OAuthCredential }>();
    const refresh = vi.fn(() => {
      started.resolve();
      return release.promise;
    });
    const run = (
      refreshOwner: (
        credential: OAuthCredential,
      ) => Promise<{ apiKey: string; credential: OAuthCredential } | null>,
    ) =>
      refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: "test serialized identity replacement",
        timeoutMs: 1_000,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
        canRefresh: async () => true,
        refresh: refreshOwner,
        resolve: async (credential) => ({ apiKey: credential.access, credential }),
        commit: () => {},
      });

    const owner = run(refresh);
    await started.promise;
    const peerRefresh = vi.fn(async () => null);
    const observer = run(peerRefresh);
    persisted = JSON.stringify({
      [profileId]: createCredential({
        access: "account-b-access",
        refresh: "account-b-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-b",
      }),
    });

    await expect(observer).resolves.toBeNull();
    release.resolve({
      apiKey: "rotated-a-access",
      credential: createCredential({
        access: "rotated-a-access",
        refresh: "rotated-a-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-a",
      }),
    });
    await expect(owner).rejects.toThrow("owner changed");
    expect(refresh).toHaveBeenCalledOnce();
    expect(peerRefresh).not.toHaveBeenCalled();
    expect(JSON.parse(persisted)[profileId]).toMatchObject({
      access: "account-b-access",
      refresh: "account-b-refresh",
      accountId: "acct-b",
    });
  });

  it("terminally fences invalid serialized provider outcomes", async () => {
    const profileId = "openai:default";
    const expired = createCredential({
      access: "account-a-access",
      refresh: "account-a-refresh",
      expires: 1,
      accountId: "acct-a",
    });
    let persisted = JSON.stringify({ [profileId]: expired });
    const backend = {
      withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
    };
    const run = (refresh: () => Promise<{ apiKey: string; credential: OAuthCredential } | null>) =>
      refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: "test serialized provider identity mismatch",
        timeoutMs: 1_000,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
        canRefresh: async () => true,
        refresh,
        resolve: async (credential) => ({ apiKey: credential.access, credential }),
        commit: () => {},
      });

    await expect(
      run(async () => ({
        apiKey: "account-b-access",
        credential: createCredential({
          access: "account-b-access",
          refresh: "account-b-refresh",
          expires: Date.now() + 600_000,
          accountId: "acct-b",
        }),
      })),
    ).rejects.toThrow("different OAuth account");

    let stored = JSON.parse(persisted)[profileId] as OAuthCredential;
    expect(stored).toMatchObject({
      type: "oauth",
      provider: "openai",
      accountId: "acct-a",
      expires: 1,
    });
    expect(stored.access).toContain(":failed:access:");
    expect(JSON.stringify(stored)).not.toContain("account-b-access");

    for (const providerRejection of [{ reason: "invalid_grant", status: 401 }, undefined]) {
      persisted = JSON.stringify({ [profileId]: expired });
      // oxlint-disable-next-line prefer-promise-reject-errors -- providers can reject with unknown non-Error values.
      const failure = await run(() => Promise.reject(providerRejection)).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message: "OAuth refresh failed", cause: providerRejection });
      if (providerRejection) {
        expect(failure).toMatchObject(providerRejection);
      }
      stored = JSON.parse(persisted)[profileId] as OAuthCredential;
      expect(isPendingOAuthRefreshFence(stored)).toBe(false);
      expect(stored.access).toContain(":failed:access:");
    }
  });

  it.each([{ outcome: "throw" as const }, { outcome: "null" as const }])(
    "surfaces one failed serialized terminal write after a $outcome refresh",
    async ({ outcome }) => {
      const profileId = "openai:default";
      const expired = createCredential({
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
        accountId: "acct-123",
      });
      let persisted = JSON.stringify({ [profileId]: expired });
      let lockDepth = 0;
      let terminalAttempts = 0;
      const terminalError = new Error("failed to persist serialized terminal fence");
      const backend = {
        withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
          expect(lockDepth).toBe(0);
          lockDepth += 1;
          try {
            const update = fn(persisted);
            if (update.next?.includes(":failed:access:")) {
              terminalAttempts += 1;
              throw terminalError;
            }
            if (update.next !== undefined) {
              persisted = update.next;
            }
            return update.result;
          } finally {
            lockDepth -= 1;
          }
        },
      };
      const initiatingError = new Error("provider refresh failed");
      const run = refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: `test serialized ${outcome} terminal failure`,
        timeoutMs: 1_000,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
        canRefresh: async () => true,
        refresh: async () => {
          if (outcome === "throw") {
            throw initiatingError;
          }
          return null;
        },
        resolve: async (credential) => ({ apiKey: credential.access, credential }),
        commit: () => {},
      });

      if (outcome === "throw") {
        await expect(run).rejects.toSatisfy((caught: unknown) => {
          expect(caught).toBeInstanceOf(AggregateError);
          const aggregate = caught as AggregateError;
          expect(aggregate.errors).toEqual([initiatingError, terminalError]);
          expect(aggregate.cause).toBe(initiatingError);
          return true;
        });
      } else {
        await expect(run).rejects.toBe(terminalError);
      }
      expect(terminalAttempts).toBe(1);
      expect(lockDepth).toBe(0);
      expect(backend.withLock(() => ({ result: "reacquired" }))).toBe("reacquired");
    },
  );

  it("rejects a late settlement after an identity-less generation is restored and reclaimed", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const profileId = "openai:default";
    const firstCredential = createCredential({
      access: "first-access",
      refresh: "stable-refresh",
      expires: 1,
    });
    let persisted = JSON.stringify({ [profileId]: firstCredential });
    const backend = {
      withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
    };
    const run = (
      refresh: (
        credential: OAuthCredential,
      ) => Promise<{ apiKey: string; credential: OAuthCredential } | null>,
    ) =>
      refreshSerializedOAuthCredential({
        backend,
        provider: "openai",
        profileId,
        label: "test ABA refresh",
        timeoutMs: 10,
        parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
        serialize: JSON.stringify,
        readCredential: (data) => data[profileId],
        writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
        canRefresh: async () => true,
        refresh,
        resolve: async (credential) => ({ apiKey: credential.access, credential }),
        commit: () => {},
      });
    let settleFirst:
      | ((result: { apiKey: string; credential: OAuthCredential }) => void)
      | undefined;
    const first = run(
      () =>
        new Promise((resolve) => {
          settleFirst = resolve;
        }),
    );
    const firstTimedOut = expect(first).rejects.toThrow("exceeded hard timeout (10ms)");
    await vi.advanceTimersByTimeAsync(10);
    await firstTimedOut;

    persisted = JSON.stringify({ [profileId]: firstCredential });
    await expect(
      run(async () => ({
        apiKey: "second-rotated-access",
        credential: createCredential({
          access: "second-rotated-access",
          refresh: "second-rotated-refresh",
          expires: Date.now() + 600_000,
        }),
      })),
    ).resolves.toMatchObject({ apiKey: "second-rotated-access" });

    settleFirst?.({
      apiKey: "late-first-access",
      credential: createCredential({
        access: "late-first-access",
        refresh: "late-first-refresh",
        expires: Date.now() + 600_000,
      }),
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(JSON.parse(persisted)[profileId]).toMatchObject({
      access: "second-rotated-access",
      refresh: "second-rotated-refresh",
    });
  });
});
