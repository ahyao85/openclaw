import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";

export function loadManifestWriter() {
  const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
  return workflow.jobs.summary.steps.find(
    (step: { name: string }) => step.name === "Write release validation manifest",
  );
}

/** Keep the workflow writer and sealing policy real while replacing external artifact/registry I/O. */
export function manifestWriterEnvironment(
  directory: string,
  sourceSha: string,
  toolingSha: string,
) {
  const changes = { entrypointsAdded: [], entrypointsRemoved: [], exports: [] };
  const npmManifest = {
    releaseSha: sourceSha,
    pluginSdkApi: createPluginSdkApiReleaseEvidence({
      baseRef: "v2026.9.8",
      baseSha: "e".repeat(40),
      headSha: sourceSha,
      workflowSha: toolingSha,
      diff: {
        ...changes,
        digest: createHash("sha256").update(JSON.stringify(changes)).digest("hex"),
      },
    }),
  };
  const npmBytes = JSON.stringify(npmManifest);
  const manifestSha256 = createHash("sha256").update(npmBytes).digest("hex");
  const qualified = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: { sha: sourceSha },
    manifestSha256,
    artifact: {
      id: "500",
      name: "openclaw-npm-preflight-fixture",
      digest: "f".repeat(64),
      runId: "501",
      runAttempt: "1",
    },
    producer: {
      repository: "openclaw/openclaw",
      runId: "501",
      runAttempt: "1",
      workflowSha: toolingSha,
      workflowRef:
        "openclaw/openclaw/.github/workflows/full-release-artifacts.yml@refs/heads/release-ci/test",
    },
  };
  const artifactModule = pathToFileURL(resolve("scripts/npm-preflight-tooling-identity.mjs")).href;
  const preload = join(directory, "manifest-writer-fixture.mjs");
  const proxy = `${pathToFileURL(preload).href}?artifact-transport`;
  const transportSource = `
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateFullReleaseNpmPreflight } from ${JSON.stringify(artifactModule)};
export * from ${JSON.stringify(artifactModule)};
export async function downloadFullReleaseNpmPreflight({ outputDir, token, ...options }) {
  if (token !== 'synthetic-manifest-fixture') throw new Error('Unexpected fixture credential');
  const descriptor = validateFullReleaseNpmPreflight(options);
  const bytes = ${JSON.stringify(npmBytes)};
  if (createHash('sha256').update(bytes).digest('hex') !== descriptor.manifestSha256) {
    throw new Error('Fixture artifact does not match its qualified descriptor');
  }
  writeFileSync(join(outputDir, 'preflight-manifest.json'), bytes);
}
`;
  writeFileSync(
    preload,
    `
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    return resolved.url === ${JSON.stringify(artifactModule)} && context.parentURL !== ${JSON.stringify(proxy)}
      ? { url: ${JSON.stringify(proxy)}, shortCircuit: true } : resolved;
  },
  load(url, context, next) {
    return url === ${JSON.stringify(proxy)}
      ? { format: 'module', source: ${JSON.stringify(transportSource)}, shortCircuit: true }
      : next(url, context);
  },
});
globalThis.fetch = async (input) => {
  if (String(input) !== 'https://registry.npmjs.org/openclaw') {
    throw new Error('Unexpected external request: ' + String(input));
  }
  return Response.json({ versions: { '2026.9.8': {} }, 'dist-tags': { latest: '2026.9.8' } });
};
`,
  );
  return {
    PATH: process.env.PATH,
    GH_TOKEN: "synthetic-manifest-fixture",
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    QUALIFIED_NPM_BUNDLE_JSON: JSON.stringify(qualified),
  };
}
