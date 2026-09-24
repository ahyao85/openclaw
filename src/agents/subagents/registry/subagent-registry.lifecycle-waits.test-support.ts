import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { onSubagentRegistryPersisted } from "./subagent-registry-state.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import * as mod from "./subagent-registry.test-helpers.js";

/** Worker publications, not fake clock ticks, make registry state observable. */
async function waitForRegistryState<T>(read: () => T | undefined): Promise<T> {
  const ready = createDeferred<T>();
  const inspect = () => {
    try {
      const value = read();
      if (value !== undefined) {
        ready.resolve(value);
      }
    } catch (error) {
      // Registry observers are best-effort; fixture read failures must reach the test.
      ready.reject(error);
    }
  };
  const unsubscribe = onSubagentRegistryPersisted(inspect);
  onTestFinished(unsubscribe);
  try {
    inspect();
    return await ready.promise;
  } finally {
    unsubscribe();
  }
}

export function createLifecycleWaits(requesterSessionKey: string) {
  let settleRootWork: ReturnType<typeof observeRootWork>;
  const start = () => {
    settleRootWork = observeRootWork();
  };
  const flushAsync = async () => {
    await vi.dynamicImportSettled();
    await settleRootWork(true);
  };
  const finish = async () => {
    await vi.dynamicImportSettled();
    await settleRootWork();
  };

  const findRun = (runId: string) =>
    mod.listSubagentRunsForRequester(requesterSessionKey).find((run) => run.runId === runId);

  const waitForCleanupHandledFalse = async (runId: string) => {
    await waitForRegistryState(() => {
      const run = findRun(runId);
      return run?.cleanupHandled === false &&
        run.delivery?.status === "pending" &&
        run.delivery.payload
        ? run
        : undefined;
    });
  };

  const waitForDeliveredCleanup = async (
    runId: string,
    options?: { allowPendingRequesterSettleWake?: boolean },
  ) => {
    await waitForRegistryState(() => {
      const run = findRun(runId);
      return run?.delivery?.status === "delivered" &&
        typeof run.cleanupCompletedAt === "number" &&
        (options?.allowPendingRequesterSettleWake === true || run.requesterSettleWake === undefined)
        ? run
        : undefined;
    });
  };

  const waitForFrozenResult = (runId: string, matches: (resultText: string) => boolean) =>
    waitForRegistryState(() => {
      const run = findRun(runId);
      const resultText = run?.completion?.resultText;
      return run && typeof resultText === "string" && matches(resultText) ? run : undefined;
    });

  const waitForFrozenResultText = (runId: string, expectedText: string) =>
    waitForFrozenResult(runId, (resultText) => resultText === expectedText);

  return {
    start,
    finish,
    flushAsync,
    waitForCleanupHandledFalse,
    waitForDeliveredCleanup,
    waitForFrozenResult,
    waitForFrozenResultText,
  };
}
