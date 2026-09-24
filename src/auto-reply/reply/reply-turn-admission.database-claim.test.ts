import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessionEntries from "../../config/sessions/session-accessor.sqlite-entry.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import {
  runExclusiveSessionLifecycleMutation,
  startSessionWorkAdmissionInterruption,
} from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as registry from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  testing.resetReplyRunRegistry();
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
});

it.each(
  (["writer", "active", "delivery"] as const).flatMap((wait) =>
    (["unchanged", "same-inode", "other-inode"] as const).map((replacement) => ({
      wait,
      replacement,
    })),
  ),
)(
  "keeps the exact database owner across $wait wait, replacement=$replacement",
  async ({ wait, replacement }) => {
    const root = tempDirs.make("reply-admission-claim-");
    const originalPath = path.join(root, "original.sqlite");
    const replacementPath = path.join(root, "replacement.sqlite");
    const storePath = path.join(root, "selected.sqlite");
    const sessionKey = "global";
    const sessionId = "copied-session";
    for (const databasePath of [originalPath, replacementPath]) {
      sessionEntries.replaceSessionEntrySync(
        { storePath: databasePath, sessionKey },
        { sessionId, updatedAt: 1 },
      );
    }
    closeOpenClawAgentDatabasesForTest();
    fs.symlinkSync(originalPath, storePath);
    const release = createDeferred();
    const writerStarted = createDeferred();
    let owner: registry.ReplyOperation | undefined;
    let writer: Promise<void> | undefined;
    if (wait === "writer") {
      writer = runExclusiveSessionStoreWrite(storePath, async () => {
        writerStarted.resolve();
        await release.promise;
      });
      await writerStarted.promise;
    } else {
      const admitted = await admitReplyTurn({
        storePath,
        sessionKey,
        sessionId,
        kind: "visible",
        resetTriggered: false,
      });
      expect(admitted.status).toBe("owned");
      if (admitted.status !== "owned") {
        throw new Error("fixture requires an admitted blocking owner");
      }
      owner = admitted.operation;
      if (wait === "delivery") {
        owner.completeWithAfterClearBarrier(release.promise);
      }
    }
    const loaded = vi.spyOn(sessionEntries, "loadSessionEntryForAdmission");
    const waiting =
      wait === "active"
        ? vi.spyOn(registry.replyRunRegistry, "waitForIdle")
        : wait === "delivery"
          ? vi.spyOn(registry, "waitForReplyRunFollowupAdmission")
          : loaded;
    const controller = new AbortController();
    const pending = admitReplyTurn({
      storePath,
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    void pending.catch(() => {});
    try {
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled());
      const observed = loaded.mock.results.at(-1);
      if (observed?.type !== "return") {
        throw new Error("fixture requires a completed authoritative row read");
      }
      const claim = (await observed.value).databaseClaim;
      expect(claim.isCurrent()).toBe(true);
      if (replacement !== "unchanged") {
        expect(closeOpenClawAgentDatabaseByPath(storePath)).toBe(true);
        expect(claim.isCurrent()).toBe(false);
        if (replacement === "other-inode") {
          fs.unlinkSync(storePath);
          fs.symlinkSync(replacementPath, storePath);
        }
      }
      owner?.complete();
      release.resolve();
      const result = await pending;
      if (replacement === "unchanged") {
        expect(result.status).toBe("owned");
        if (result.status === "owned") {
          expect(result.databaseClaim?.incarnation).toBe(claim.incarnation);
          result.operation.complete();
        }
      } else {
        expect(result).toMatchObject({ status: "skipped", reason: "lifecycle-invalidated" });
      }
    } finally {
      owner?.complete();
      release.resolve();
      controller.abort();
      const result = await pending.catch(() => undefined);
      if (result?.status === "owned") {
        result.operation.complete();
      }
      await writer;
    }
  },
);

it("preserves first admission to a missing durable agent store", async () => {
  openOpenClawStateDatabase();
  const storePath = path.join(tempDirs.make("reply-first-admission-"), "agent.sqlite");
  const result = await sessionEntries.loadSessionEntryForAdmission({
    storePath,
    sessionKey: "agent:main:first",
  });
  try {
    expect(result.entry).toBeUndefined();
    expect(result.databaseClaim.isCurrent()).toBe(true);
  } finally {
    result.databaseClaim.release();
  }
});

it("cancels an in-flight admission read when its lifecycle owner interrupts ingress", async () => {
  const storePath = path.join(tempDirs.make("reply-admission-interrupt-"), "agent.sqlite");
  const sessionKey = "agent:main:interrupted-read";
  const started = createDeferred<AbortSignal>();
  vi.spyOn(sessionEntries, "loadSessionEntryForAdmission").mockImplementation(
    async (_scope, preparation) => {
      const signal = preparation?.signal;
      if (!signal) {
        throw new Error("Admission read requires its cancellation signal");
      }
      started.resolve(signal);
      return await new Promise<never>((_resolve, reject) => {
        const abort = () =>
          reject(
            signal.reason instanceof Error ? signal.reason : new Error("Admission read aborted"),
          );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      });
    },
  );
  const upstream = new AbortController();
  const pending = Promise.allSettled([
    admitReplyTurn({
      storePath,
      sessionKey,
      sessionId: "interrupted-read",
      kind: "visible",
      resetTriggered: false,
      upstreamAbortSignal: upstream.signal,
    }),
  ]);
  const target = { scope: storePath, identities: [sessionKey] };
  try {
    const signal = await started.promise;
    const reason = new Error("Synthetic lifecycle interruption");
    const interrupted = startSessionWorkAdmissionInterruption({ ...target, reason });
    expect(signal.aborted).toBe(true);
    expect(upstream.signal.aborted).toBe(false);
    await interrupted.released;
    await runExclusiveSessionLifecycleMutation({ ...target, run: async () => {} });
    expect(await pending).toMatchObject([{ status: "rejected", reason }]);
    expect(registry.replyRunRegistry.get(sessionKey)).toBeUndefined();
  } finally {
    upstream.abort();
    await pending;
    await runExclusiveSessionLifecycleMutation({ ...target, run: async () => {} });
  }
});
