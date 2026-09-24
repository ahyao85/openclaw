// A yielded requester's settle final: deliverable, yet bound to the parent
// incarnation that produced its private findings.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import type { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";

afterEach(() => {
  testing.setDepsForTest();
  vi.restoreAllMocks();
});

describe("yielded requester settle delivery", () => {
  it.each([
    { name: "current parent", current: "requester-session-dm", admitted: true },
    { name: "replaced parent", current: "replacement-parent", admitted: false },
  ])(
    "delivers a yielded settle final bound to its private findings' parent: $name",
    async ({ current, admitted }) => {
      const callGateway = vi.fn<typeof runtimeCallGateway>().mockImplementation(async (opts) => {
        opts.onAccepted?.({ status: "accepted" });
        return { status: "ok", result: { payloads: [{ text: "parent answer" }] } };
      });
      const sendMessage = vi.fn<typeof runtimeSendMessage>();
      const origin = { channel: "discord", to: "dm:U123", accountId: "acct-1" };
      const requesterSessionKey = "agent:main:discord:dm:U123";
      testing.setDepsForTest({
        callGateway,
        getRequesterSessionActivity: () => ({ sessionId: current, isActive: false }),
        getRuntimeConfig: () => ({}),
        sendMessage,
      });
      const result = await deliverSubagentAnnouncement({
        requesterSessionKey,
        targetRequesterSessionKey: requesterSessionKey,
        triggerMessage: "settled findings",
        steerMessage: "settled findings",
        requesterSessionOrigin: origin,
        directOrigin: origin,
        sourceTool: "subagent_settle",
        requesterIsSubagent: false,
        expectsCompletionMessage: false,
        requireDirectDelivery: true,
        completionRequesterSessionId: "requester-session-dm",
        directIdempotencyKey: "announce:requester-settle:test",
      });
      if (!admitted) {
        expect(result).toMatchObject({
          delivered: false,
          reason: "completion_handoff_unavailable",
          terminal: true,
        });
        expect(callGateway).not.toHaveBeenCalled();
        return;
      }
      expect(callGateway.mock.calls[0]?.[0]).toMatchObject({
        method: "agent",
        params: {
          deliver: true,
          channel: "discord",
          to: "dm:U123",
          sourceReplyDeliveryMode: "automatic",
          expectedExistingSessionId: "requester-session-dm",
        },
      });
      // The requester's own final is delivered by the agent turn; no raw child fallback.
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );
});
