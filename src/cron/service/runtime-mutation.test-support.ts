import { deserialize } from "node:v8";
import { MessagePort, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import type { CronRuntimeMutationType } from "../store/runtime-worker.types.js";

export function loseFirstCronMutationReply(type: CronRuntimeMutationType = "cron.repairRun") {
  let target: { worker: Worker; requestId: number; nonce: string } | undefined;
  let stopped: Promise<number> | undefined;
  let dropped = false;
  const attempts: string[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
  const originalPost = Worker.prototype.postMessage;
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted message port remains the receiver.
  const originalOn = MessagePort.prototype.on;
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (
        isRecord(command) &&
        command.type === type &&
        isRecord(command.input) &&
        typeof command.input.nonce === "string"
      ) {
        attempts.push(
          isRecord(command.input.proposal) && typeof command.input.proposal.jobId === "string"
            ? command.input.proposal.jobId
            : type,
        );
        target ??= { worker: this, requestId: request.id, nonce: command.input.nonce };
      }
    }
    return originalPost.call(this, request, transferList);
  });
  const on = vi.spyOn(MessagePort.prototype, "on").mockImplementation(function (
    this: MessagePort,
    event,
    listener,
  ) {
    if (event !== "message") {
      return originalOn.call(this, event, listener);
    }
    return originalOn.call(this, event, function (this: MessagePort, ...args: unknown[]) {
      const message = args[0];
      const reply = isRecord(message) && message.type === "result" ? message.reply : undefined;
      if (
        !dropped &&
        target &&
        isRecord(reply) &&
        reply.id === target.requestId &&
        reply.ok === true &&
        reply.value instanceof Uint8Array
      ) {
        const result: unknown = deserialize(reply.value);
        if (isRecord(result) && result.nonce === target.nonce) {
          // Withhold only the successful reply; real commit receipts and native settlement still flow.
          dropped = true;
          stopped = target.worker.terminate();
          return;
        }
      }
      Reflect.apply(listener, this, args);
    });
  });
  return {
    attempts,
    wasDropped: () => dropped,
    waitForExit: () => stopped,
    async close() {
      if (target) {
        stopped ??= target.worker.terminate();
      }
      await stopped;
      post.mockRestore();
      on.mockRestore();
    },
  };
}
