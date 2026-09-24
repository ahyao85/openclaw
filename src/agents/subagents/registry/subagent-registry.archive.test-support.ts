import type { finalizeTaskRunByRunIdAsync } from "../../../tasks/detached-task-runtime.async.js";

/** Archive tests control task settlement while exercising the real registry sweeper. */
export const finalizeArchiveFixtureTask: typeof finalizeTaskRunByRunIdAsync = async (
  params,
  assertCurrent,
) => {
  await Promise.resolve();
  assertCurrent?.();
  return [
    {
      taskId: params.taskId ?? `task-${params.runId}`,
      runtime: params.runtime ?? "subagent",
      runId: params.runId,
      childSessionKey: params.sessionKey,
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Finalized archive fixture task",
      status: params.status,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 0,
      endedAt: params.endedAt,
      error: params.error,
    },
  ];
};
