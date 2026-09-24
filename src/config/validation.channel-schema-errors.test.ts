// Verifies channel schema failures follow the plugin manifest trust boundary.

import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

const malformedSchema = {
  type: "object",
  properties: { mode: { $ref: "#/$defs/Mode" } },
};

function createRegistry(origin: PluginManifestRecord["origin"]): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "schema-owner",
        channels: ["schema-channel"],
        channelConfigs: { "schema-channel": { schema: malformedSchema } },
        cliBackends: [],
        hooks: [],
        manifestPath: "/plugins/schema-owner/openclaw.plugin.json",
        origin,
        providers: [],
        rootDir: "/plugins/schema-owner",
        skills: [],
        source: "/plugins/schema-owner/index.js",
      },
    ],
  };
}

function validate(origin: PluginManifestRecord["origin"]) {
  return validateConfigObjectRawWithPlugins(
    { channels: { "schema-channel": {} } },
    { pluginMetadataSnapshot: { manifestRegistry: createRegistry(origin) } },
  );
}

describe("channel schema error ownership", () => {
  it.each(["bundled", "global"] as const)("projects extras using the %s schema owner", (origin) => {
    const registry = createRegistry(origin);
    registry.plugins[0].channelConfigs = {
      "schema-channel": {
        schema: {
          type: "object",
          properties: {
            auth: {
              type: "object",
              properties: { mode: { type: "string" } },
              additionalProperties: false,
            },
            entries: {
              type: "object",
              properties: { documented: { type: "string" } },
              additionalProperties: {
                type: "object",
                properties: { enabled: { type: "boolean" } },
                required: ["enabled"],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    };
    const value = { entries: { "01.a/~1": { enabled: true, "extra./~": { keep: true } } } };
    const raw = { channels: { "schema-channel": value } };
    const result = validateConfigObjectRawWithPlugins(raw, {
      schemaValidation: "runtime",
      pluginMetadataSnapshot: { manifestRegistry: registry },
    });
    expect(result).toMatchObject({
      ok: true,
      config: { channels: { "schema-channel": { entries: { "01.a/~1": { enabled: true } } } } },
      ignoredPaths: [["channels", "schema-channel", "entries", "01.a/~1", "extra./~"]],
    });
    expect(raw.channels["schema-channel"].entries["01.a/~1"]["extra./~"]).toEqual({ keep: true });
    expect(
      validateConfigObjectRawWithPlugins(
        { channels: { "schema-channel": { auth: { mode: "token", requireMfa: true } } } },
        { schemaValidation: "runtime", pluginMetadataSnapshot: { manifestRegistry: registry } },
      ).ok,
    ).toBe(false);
    expect(
      validateConfigObjectRawWithPlugins(raw, {
        pluginMetadataSnapshot: { manifestRegistry: registry },
      }).ok,
    ).toBe(false);
    expect(
      validateConfigObjectRawWithPlugins(
        { channels: { "schema-channel": { entries: { broken: { enabled: "yes", extra: 1 } } } } },
        { schemaValidation: "runtime", pluginMetadataSnapshot: { manifestRegistry: registry } },
      ).ok,
    ).toBe(false);
  });

  it("reports malformed external channel schemas as scoped issues", () => {
    const result = validate("global");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "channels.schema-channel",
          message: expect.stringContaining("invalid schema"),
        }),
      );
    }
  });

  it("keeps malformed bundled channel schemas on the throwing path", () => {
    expect(() => validate("bundled")).toThrow("invalid schema");
  });
});
