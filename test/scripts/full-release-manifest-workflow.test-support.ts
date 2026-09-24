import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";

// Keep the real workflow command, provenance verifier, archive verifier, and input
// sealer. Only GitHub/npm I/O is synthetic; no ambient credential or network is used.
export async function createManifestWorkflowFixture(
  directory: string,
  identity: { targetSha: string; workflowSha: string; workflowFullRef: string },
) {
  const repository = "openclaw/openclaw";
  const workflow = ".github/workflows/full-release-artifacts.yml";
  const producer = {
    repository,
    workflowRef: repository + "/" + workflow + "@" + identity.workflowFullRef,
    workflowSha: identity.workflowSha,
    runId: "81",
    runAttempt: "1",
    jobId: "902",
    jobName: "Prepare npm artifacts / Qualify prepared npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const diff = { entrypointsAdded: [], entrypointsRemoved: [], exports: [] };
  const sdkDigest = createHash("sha256").update(JSON.stringify(diff)).digest("hex");
  const npmManifest = Buffer.from(
    JSON.stringify({
      version: 3,
      releaseSha: identity.targetSha,
      producer,
      pluginSdkApi: createPluginSdkApiReleaseEvidence({
        baseRef: "v2026.9.8",
        baseSha: "c".repeat(40),
        headSha: identity.targetSha,
        workflowSha: identity.workflowSha,
        diff: { ...diff, digest: sdkDigest },
      }),
    }),
  );
  const zip = new JSZip();
  zip.file("preflight-manifest.json", npmManifest);
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const archivePath = join(directory, "preflight.zip");
  writeFileSync(archivePath, archive);
  const archiveDigest = createHash("sha256").update(archive).digest("hex");
  const qualified = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: { sha: identity.targetSha },
    producer,
    manifestSha256: createHash("sha256").update(npmManifest).digest("hex"),
    artifact: {
      id: "402",
      name: "openclaw-npm-preflight-" + identity.targetSha,
      digest: archiveDigest,
      runId: producer.runId,
      runAttempt: producer.runAttempt,
    },
  };
  const run = {
    id: 81,
    run_attempt: 1,
    head_sha: identity.workflowSha,
    path: workflow + "@" + identity.workflowFullRef,
    head_branch: identity.workflowFullRef.replace(/^refs\/(?:heads|tags)\//u, ""),
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  };
  const artifact = {
    id: 402,
    name: qualified.artifact.name,
    digest: "sha256:" + archiveDigest,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: 81, head_sha: identity.workflowSha },
  };
  const prefix = "repos/" + repository + "/actions/";
  const responses = {
    [prefix + "runs/81"]: run,
    [prefix + "runs/81/attempts/1"]: run,
    [prefix + "runs/81/attempts/1/jobs?per_page=100&page=1"]: {
      total_count: 1,
      jobs: [
        {
          id: 902,
          name: producer.jobName,
          run_id: 81,
          run_attempt: 1,
          head_sha: identity.workflowSha,
          status: "completed",
          conclusion: "success",
        },
      ],
    },
    [prefix + "artifacts/402"]: artifact,
  };
  const responsesPath = join(directory, "responses.json");
  const callsPath = join(directory, "calls.jsonl");
  writeFileSync(responsesPath, JSON.stringify({ responses, archivePath }));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'if (args[0] !== "api") throw new Error("Unexpected GitHub command");',
      'for (let i = 2; i < args.length; i += 2) { if (!["--method", "--jq"].includes(args[i]) || !args[i + 1] || (args[i] === "--method" && args[i + 1] !== "GET")) throw new Error("Unexpected GitHub options"); }',
      'const {responses} = JSON.parse(fs.readFileSync(process.env.FIXTURE_RESPONSES, "utf8"));',
      'if (!Object.hasOwn(responses, args[1])) throw new Error("Unexpected GitHub endpoint: " + args[1]);',
      'fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(["gh", args[1]]) + "\\n");',
      "process.stdout.write(JSON.stringify(responses[args[1]]));",
    ].join("\n"),
    { mode: 0o755 },
  );
  const preload = join(directory, "fetch-preload.mjs");
  writeFileSync(
    preload,
    [
      'import fs from "node:fs";',
      'const {responses, archivePath} = JSON.parse(fs.readFileSync(process.env.FIXTURE_RESPONSES, "utf8"));',
      "globalThis.fetch = async (input, options) => {",
      "  const url = new URL(input instanceof Request ? input.url : String(input));",
      '  if (options?.method && options.method !== "GET") throw new Error("Unexpected HTTP mutation");',
      '  fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(["fetch", url.href]) + "\\n");',
      '  if (url.href === "https://registry.npmjs.org/openclaw") return Response.json({versions:{"2026.9.8":{}},"dist-tags":{latest:"2026.9.8",beta:"2026.9.8"}});',
      '  if (url.origin !== "https://api.github.com") throw new Error("Unexpected fetch origin: " + url.origin);',
      "  const endpoint = url.pathname.slice(1) + url.search;",
      '  if (endpoint === "repos/openclaw/openclaw/actions/artifacts/402/zip") return new Response(fs.readFileSync(archivePath));',
      "  if (Object.hasOwn(responses, endpoint)) return Response.json(responses[endpoint]);",
      '  throw new Error("Unexpected fetch endpoint: " + endpoint);',
      "};",
    ].join("\n"),
  );
  return {
    sdkDigest,
    env: {
      GH_TOKEN: "synthetic-manifest-token",
      GITHUB_TOKEN: "",
      NODE_OPTIONS: "--import=" + pathToFileURL(preload).href,
      PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
      QUALIFIED_NPM_BUNDLE_JSON: JSON.stringify(qualified),
      FIXTURE_RESPONSES: responsesPath,
      FIXTURE_CALLS: callsPath,
    },
    readCalls: () =>
      readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}
