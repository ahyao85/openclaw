// Mention gating tests cover channel mention requirements before inbound messages trigger agents.
import { describe, expect, it } from "vitest";
import {
  allowedImplicitMentionKindsFromConfig,
  implicitMentionKindWhen,
  resolveBotThreadMentionPolicy,
  resolveInboundMentionDecision,
  type InboundImplicitMentionKind,
} from "./mention-gating.js";

describe("resolveInboundMentionDecision", () => {
  it("allows matching implicit mention kinds by default", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ["reply_to_bot"],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(res.implicitMention).toBe(true);
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot"]);
    expect(res.effectiveWasMentioned).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("filters implicit mention kinds through the allowlist", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ["reply_to_bot", "bot_thread_participant"],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowedImplicitMentionKinds: ["reply_to_bot"],
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(res.implicitMention).toBe(true);
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot"]);
    expect(res.shouldSkip).toBe(false);
  });

  it("blocks implicit mention kinds excluded by policy", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ["reply_to_bot"],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowedImplicitMentionKinds: [],
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(res.implicitMention).toBe(false);
    expect(res.matchedImplicitMentionKinds).toStrictEqual([]);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

  it("translates positive implicit mention config inside the evaluator", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ["reply_to_bot", "bot_thread_participant", "native"],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        implicitMentions: {
          replyToBot: false,
          quotedBot: true,
          threadParticipation: false,
        },
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(res.matchedImplicitMentionKinds).toEqual(["native"]);
  });

  it("keeps an explicit plugin allowlist ahead of implicit mention config", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ["reply_to_bot", "bot_thread_participant"],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        implicitMentions: { replyToBot: false, threadParticipation: true },
        allowedImplicitMentionKinds: ["reply_to_bot"],
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot"]);
  });

  it("dedupes repeated implicit mention kinds", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        implicitMentionKinds: ["reply_to_bot", "reply_to_bot", "native"],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(res.matchedImplicitMentionKinds).toEqual(["reply_to_bot", "native"]);
  });

  it("keeps command bypass behavior unchanged", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: false,
        implicitMentionKinds: [],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: true,
        commandAuthorized: true,
      },
    });
    expect(res.shouldBypassMention).toBe(true);
    expect(res.effectiveWasMentioned).toBe(true);
    expect(res.shouldSkip).toBe(false);
  });

  it("does not allow command bypass when some other mention is present", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: true,
        implicitMentionKinds: [],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: true,
        commandAuthorized: true,
      },
    });
    expect(res.shouldBypassMention).toBe(false);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

  it("does not allow command bypass outside groups", () => {
    const res = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: false,
        hasAnyMention: false,
        implicitMentionKinds: [],
      },
      policy: {
        isGroup: false,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: true,
        commandAuthorized: true,
      },
    });
    expect(res.shouldBypassMention).toBe(false);
    expect(res.effectiveWasMentioned).toBe(false);
    expect(res.shouldSkip).toBe(true);
  });

  it("keeps the flat call shape for compatibility", () => {
    const res = resolveInboundMentionDecision({
      isGroup: true,
      requireMention: true,
      canDetectMention: true,
      wasMentioned: false,
      implicitMentionKinds: ["reply_to_bot"],
      allowTextCommands: true,
      hasControlCommand: false,
      commandAuthorized: false,
    });
    expect(res.effectiveWasMentioned).toBe(true);
  });
});

describe("unavailable mention detection", () => {
  it("does not skip when mention detection is unavailable", () => {
    const decision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: false,
        wasMentioned: false,
        implicitMentionKinds: [],
      },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: false,
        commandAuthorized: false,
      },
    });
    expect(decision.shouldSkip).toBe(false);
  });
});

describe("bot-owned thread mention policy", () => {
  it.each<{
    name: string;
    isBotOwnedThread: boolean;
    requireMentionInBotThreads?: boolean;
    requireMention: boolean;
    implicitMentionKinds?: readonly InboundImplicitMentionKind[];
    wasMentioned?: boolean;
    commandAuthorized?: boolean;
    shouldSkip: boolean;
  }>([
    {
      name: "admits an unmentioned reply when mentions are disabled for owned threads",
      isBotOwnedThread: true,
      requireMentionInBotThreads: false,
      requireMention: true,
      shouldSkip: false,
    },
    {
      name: "keeps the ordinary mention requirement when ownership is unproven",
      isBotOwnedThread: false,
      requireMentionInBotThreads: false,
      requireMention: true,
      shouldSkip: true,
    },
    {
      name: "does not impose a bot-thread requirement on a foreign thread",
      isBotOwnedThread: false,
      requireMentionInBotThreads: true,
      requireMention: false,
      shouldSkip: false,
    },
    {
      name: "preserves the existing requirement when the override is unset",
      isBotOwnedThread: true,
      requireMention: true,
      shouldSkip: true,
    },
    {
      name: "preserves existing implicit mentions when the override is unset",
      isBotOwnedThread: true,
      requireMention: true,
      implicitMentionKinds: ["bot_thread_participant"],
      shouldSkip: false,
    },
    {
      name: "requires mentions in owned threads even when the ordinary gate is disabled",
      isBotOwnedThread: true,
      requireMentionInBotThreads: true,
      requireMention: false,
      implicitMentionKinds: ["reply_to_bot", "quoted_bot", "bot_thread_participant"],
      shouldSkip: true,
    },
    {
      name: "accepts native mention evidence under the owned-thread requirement",
      isBotOwnedThread: true,
      requireMentionInBotThreads: true,
      requireMention: true,
      implicitMentionKinds: ["reply_to_bot", "native"],
      shouldSkip: false,
    },
    {
      name: "accepts explicit mentions under the owned-thread requirement",
      isBotOwnedThread: true,
      requireMentionInBotThreads: true,
      requireMention: true,
      wasMentioned: true,
      shouldSkip: false,
    },
    {
      name: "preserves authorized command bypass under the owned-thread requirement",
      isBotOwnedThread: true,
      requireMentionInBotThreads: true,
      requireMention: true,
      commandAuthorized: true,
      shouldSkip: false,
    },
  ])("$name", ({ wasMentioned = false, commandAuthorized = false, shouldSkip, ...input }) => {
    const threadPolicy = resolveBotThreadMentionPolicy(input);
    const decision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned,
        implicitMentionKinds: threadPolicy.implicitMentionKinds,
      },
      policy: {
        isGroup: true,
        requireMention: threadPolicy.requireMention,
        allowTextCommands: true,
        hasControlCommand: commandAuthorized,
        commandAuthorized,
      },
    });
    expect(decision.shouldSkip).toBe(shouldSkip);
  });
});

describe("implicitMentionKindWhen", () => {
  it("returns a one-item list when enabled", () => {
    expect(implicitMentionKindWhen("reply_to_bot", true)).toEqual(["reply_to_bot"]);
  });

  it("returns an empty list when disabled", () => {
    expect(implicitMentionKindWhen("reply_to_bot", false)).toStrictEqual([]);
  });
});

describe("allowedImplicitMentionKindsFromConfig", () => {
  it("maps positive config flags to evaluator kinds while preserving native mentions", () => {
    expect(
      allowedImplicitMentionKindsFromConfig({
        replyToBot: true,
        quotedBot: false,
        threadParticipation: false,
      }),
    ).toEqual(["reply_to_bot", "native"]);
  });

  it("keeps unset kinds allowed for shipped-behavior compatibility", () => {
    expect(allowedImplicitMentionKindsFromConfig({})).toEqual([
      "reply_to_bot",
      "quoted_bot",
      "bot_thread_participant",
      "native",
    ]);
  });
});
