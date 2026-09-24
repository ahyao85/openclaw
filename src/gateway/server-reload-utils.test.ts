import { describe, expect, it } from "vitest";
import { restoreCanonicalSecretRefs } from "./server-reload-utils.js";

describe("reload runtime projection", () => {
  it("restores canonical refs without restoring omitted source fields or array entries", () => {
    const ref = { source: "env" as const, provider: "default", id: "FIXTURE_TOKEN" };
    const source = {
      future: true,
      gateway: { auth: { mode: "token" as const, token: ref } },
      channels: { discord: { token: ref, future: true } },
      hooks: { mappings: [{ id: "kept", name: "source" }, { id: "omitted" }] },
    };
    const runtime = {
      gateway: { auth: { mode: "token" as const, token: "resolved" } },
      channels: { discord: { token: undefined } },
      hooks: { mappings: [{ id: "kept", name: "runtime" }] },
    };
    expect(restoreCanonicalSecretRefs(runtime, source)).toEqual({
      gateway: { auth: { mode: "token", token: ref } },
      channels: { discord: { token: ref } },
      hooks: { mappings: [{ id: "kept", name: "runtime" }] },
    });
    expect(runtime.gateway.auth.token).toBe("resolved");
    expect(source.channels.discord.future).toBe(true);
  });
});
