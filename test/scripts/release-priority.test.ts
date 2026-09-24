import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { prioritizeRelease, restoreReleasePriority } from "../../scripts/frv.mjs";
import {
  RELEASE_PRIORITY_VARIABLE,
  RELEASE_PRIORITY_WORKFLOWS,
  isDeferredCiJobSet,
  isReleaseBranch,
  selectDeferredRunCandidates,
  selectLatestRunsPerLane,
  selectQueuedRunsToCancel,
} from "../../scripts/lib/release-priority.mjs";

const WORKFLOWS = ".github/workflows";
const PARENT = {
  id: 77,
  path: ".github/workflows/full-release-validation.yml",
  status: "in_progress",
};

function run(
  id: number,
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    conclusion: null,
    created_at: "2026-09-22T12:00:00Z",
    event: "pull_request",
    head_branch: "feat/thing",
    head_repository: { id: 100 },
    html_url: `https://example.invalid/runs/${id}`,
    id,
    name,
    status: "queued",
    ...overrides,
  };
}

function client(
  options: {
    queued?: Record<string, unknown>[];
    runs?: Record<string, unknown>[];
    variable?: string;
    jobs?: Record<string, Record<string, unknown>[]>;
  } = {},
) {
  const calls: string[] = [];
  let variable = options.variable ?? "";
  return {
    calls,
    cancelRun: async (id: string) => void calls.push(`cancel:${id}`),
    deleteVariable: async (name: string) => {
      calls.push(`delete:${name}`);
      variable = "";
    },
    getParentJobs: async (id: string) => options.jobs?.[id] ?? [],
    getRun: async (id: string) =>
      id === "77"
        ? PARENT
        : ((options.queued ?? []).find((entry) => String(entry.id) === id) ?? {
            id,
            status: "completed",
          }),
    getVariable: async () => variable,
    listRuns: async (query: string) => {
      calls.push(`list:${query}`);
      return query.startsWith("status=queued")
        ? (options.queued ?? [])
        : query.startsWith("created=")
          ? (options.runs ?? [])
          : [];
    },
    repository: "openclaw/openclaw",
    rerunRun: async (id: string) => void calls.push(`rerun:${id}`),
    setVariable: async (name: string, value: string) => {
      calls.push(`set:${name}=${value}`);
      variable = value;
    },
  };
}

describe("release priority selection", () => {
  it("cancels only queued hosted-runner runs outside release branches and dispatches", () => {
    const runs = [
      run(1, "CI"),
      run(2, "CI", { head_branch: "release/2026.9.6" }),
      run(3, "CI", { head_branch: "release-ci/abcdef012345-77" }),
      run(4, "CI", { head_branch: "release-publish/abcdef012345-77" }),
      run(5, "CI", { event: "workflow_dispatch" }),
      run(6, "CI", { status: "in_progress" }),
      run(7, "OpenClaw Release Checks"),
      run(8, "Labeler", { event: "pull_request_target" }),
      run(77, "CI"),
    ];
    expect(selectQueuedRunsToCancel(runs, "77").map((entry) => entry.id)).toEqual(["1", "8"]);
    expect(["release/x", "release-ci/x", "release-publish/x"].every(isReleaseBranch)).toBe(true);
    expect(isReleaseBranch("feat/release/x")).toBe(false);
  });

  it("restores skipped gated runs and CI runs that only failed their deferral gate", () => {
    const record = { parentRunId: "77", recordedAt: "2026-09-22T12:00:00Z" };
    const candidates = selectDeferredRunCandidates(
      [
        run(1, "Labeler", { status: "completed", conclusion: "skipped" }),
        run(2, "CI", { status: "completed", conclusion: "failure" }),
        run(3, "CI", { status: "completed", conclusion: "success" }),
        run(4, "Labeler", {
          status: "completed",
          conclusion: "skipped",
          created_at: "2026-09-22T11:59:59Z",
        }),
        run(5, "CI", { status: "completed", conclusion: "skipped", event: "workflow_dispatch" }),
        // Draft CI skips its gate too; unlike release deferral, there is no failed gate to restore.
        run(6, "CI", { status: "completed", conclusion: "skipped" }),
      ],
      record,
    );
    expect(candidates.map((entry) => entry.id)).toEqual([1, 2]);
    const gate = { name: "openclaw/ci-gate", conclusion: "failure" };
    const preflight = { name: "preflight", conclusion: "skipped" };
    expect(isDeferredCiJobSet([preflight, gate])).toBe(true);
    expect(
      isDeferredCiJobSet([preflight, gate, { name: "security-fast", conclusion: "success" }]),
    ).toBe(true);
    expect(
      isDeferredCiJobSet([preflight, gate, { name: "macos-node", conclusion: "failure" }]),
    ).toBe(false);
    expect(isDeferredCiJobSet([{ name: "preflight", conclusion: "success" }, gate])).toBe(false);
    expect(isDeferredCiJobSet([])).toBe(false);
    expect(
      selectLatestRunsPerLane([
        { id: "1", name: "CI", lane: "pr:1", headBranch: "a", event: "pull_request", url: "" },
        { id: "9", name: "CI", lane: "pr:1", headBranch: "a", event: "pull_request", url: "" },
        { id: "2", name: "CI", lane: "pr:2", headBranch: "b", event: "pull_request", url: "" },
      ]).map((entry) => entry.id),
    ).toEqual(["9", "2"]);
  });

  it("gates every root job of the listed hosted-runner workflows", () => {
    const files = new Map(
      RELEASE_PRIORITY_WORKFLOWS.map((name) => [name, undefined as string | undefined]),
    );
    for (const entry of readdirSync(WORKFLOWS)) {
      if (!entry.endsWith(".yml")) {
        continue;
      }
      const doc = parse(readFileSync(join(WORKFLOWS, entry), "utf8"), {
        merge: true,
        maxAliasCount: -1,
      });
      if (!files.has(doc?.name)) {
        continue;
      }
      files.set(doc.name, entry);
      for (const [jobName, job] of Object.entries(
        doc.jobs as Record<string, { needs?: unknown; if?: unknown }>,
      )) {
        if (job.needs || String(job.if) === "github.event_name == 'workflow_dispatch'") {
          continue;
        }
        expect(String(job.if), `${entry} ${jobName}`).toContain(
          `vars.${RELEASE_PRIORITY_VARIABLE} == ''`,
        );
        expect(String(job.if), `${entry} ${jobName}`).toContain(
          "github.event_name == 'workflow_dispatch'",
        );
      }
    }
    expect([...files.entries()].filter(([, file]) => !file)).toEqual([]);
  });
});

describe("pnpm frv prioritize", () => {
  it("records intent, sets the variable, cancels still-queued runs, and restores newest-per-lane", async () => {
    const fake = client({
      queued: [
        run(1, "CI"),
        run(2, "CI", { event: "workflow_dispatch" }),
        run(6, "Labeler", { event: "pull_request_target", head_branch: "other" }),
        run(15, "CI", { head_branch: "already-restored" }),
      ],
    });
    fake.getRun = async (id: string) =>
      id === "77"
        ? PARENT
        : id === "6"
          ? run(6, "Labeler", { status: "in_progress" })
          : run(Number(id), "CI");
    const outPath = join(mkdtempSync(join(tmpdir(), "frv-priority-")), "record.json");
    await expect(prioritizeRelease("77", fake, { dryRun: true })).resolves.toMatchObject({
      action: "would-prioritize",
    });
    expect(fake.calls.filter((call) => !call.startsWith("list:"))).toEqual([]);
    const result = await prioritizeRelease("77", fake, { outPath });
    expect(result).toMatchObject({
      action: "prioritized",
      failures: [],
      recordPath: outPath,
      skipped: [{ id: "6" }],
    });
    expect(fake.calls.filter((call) => !call.startsWith("list:"))).toEqual([
      `set:${RELEASE_PRIORITY_VARIABLE}=77`,
      "cancel:1",
      "cancel:15",
    ]);
    const record = JSON.parse(readFileSync(outPath, "utf8"));
    expect(record).toMatchObject({
      parentRunId: "77",
      cancelled: [
        { id: "1", name: "CI" },
        { id: "15", name: "CI" },
      ],
    });
    // A repeated call keeps the original window and cancellations.
    const again = client({ queued: [run(8, "CI", { head_branch: "later" })] });
    again.getRun = async (id: string) => (id === "77" ? PARENT : run(Number(id), "CI"));
    await prioritizeRelease("77", again, { outPath });
    const merged = JSON.parse(readFileSync(outPath, "utf8"));
    expect(merged.recordedAt).toBe(record.recordedAt);
    expect(merged.cancelled.map((entry: { id: string }) => entry.id)).toEqual(["1", "15", "8"]);
    // Older pause records have no run-lane identity; restore resolves it from current run facts.
    for (const cancelled of merged.cancelled) {
      delete cancelled.lane;
      cancelled.id = Number(cancelled.id);
    }
    writeFileSync(outPath, JSON.stringify(merged));

    const after = { created_at: "2999-01-01T00:00:00Z", status: "completed" };
    const restoreClient = client({
      variable: "77",
      runs: [
        run(1, "CI", { ...after, conclusion: "cancelled" }),
        run(3, "CI", { ...after, conclusion: "failure" }),
        run(4, "CI", { ...after, conclusion: "failure" }),
        run(5, "Labeler", { ...after, conclusion: "skipped", event: "pull_request_target" }),
        run(8, "CI", { ...after, conclusion: "cancelled", head_branch: "later" }),
        run(9, "CI", { ...after, conclusion: "failure", head_branch: "later" }),
        run(10, "CI", { ...after, status: "in_progress", head_branch: "later" }),
        run(11, "Labeler", { ...after, conclusion: "success" }),
        run(12, "Labeler", { ...after, conclusion: "skipped", head_branch: "other" }),
        run(13, "CI", { ...after, conclusion: "failure", head_branch: "manual-shared" }),
        run(14, "CI", {
          ...after,
          status: "in_progress",
          head_branch: "manual-shared",
          event: "workflow_dispatch",
        }),
        run(15, "CI", { ...after, conclusion: "success", head_branch: "already-restored" }),
        run(17, "CI", {
          ...after,
          conclusion: "failure",
          head_branch: "main",
          head_repository: { id: 201 },
          pull_requests: [{ number: 501 }],
        }),
        run(18, "CI", {
          ...after,
          conclusion: "success",
          head_branch: "main",
          head_repository: { id: 202 },
          pull_requests: [{ number: 502 }],
        }),
      ],
      jobs: {
        "3": [
          { name: "preflight", conclusion: "skipped" },
          { name: "security-fast", conclusion: "success" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
        "4": [
          { name: "preflight", conclusion: "success" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
        "9": [
          { name: "preflight", conclusion: "skipped" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
        "13": [
          { name: "preflight", conclusion: "skipped" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
        "17": [
          { name: "preflight", conclusion: "skipped" },
          { name: "openclaw/ci-gate", conclusion: "failure" },
        ],
      },
    });
    // Executed run 4 and active run 10 supersede the deferred CI attempts.
    // Successful run 11 likewise owns its lane. Manual run 14 is independent of PR run 13.
    await expect(restoreReleasePriority(outPath, restoreClient)).resolves.toMatchObject({
      action: "restored",
      cleared: true,
      failures: [],
      rerun: [{ id: "12" }, { id: "13" }, { id: "17" }],
    });
    expect(restoreClient.calls.filter((call) => !call.startsWith("list:"))).toEqual([
      `delete:${RELEASE_PRIORITY_VARIABLE}`,
      "rerun:12",
      "rerun:13",
      "rerun:17",
    ]);
  });

  it("refuses a parent that is not an active Full Release Validation and keeps a foreign variable", async () => {
    const fake = { ...client(), getRun: async () => ({ ...PARENT, status: "completed" }) };
    await expect(prioritizeRelease("77", fake)).rejects.toThrow(
      "run 77 is not an active Full Release Validation parent",
    );
    const other = client({ variable: "99" });
    const outPath = join(mkdtempSync(join(tmpdir(), "frv-priority-")), "record.json");
    await prioritizeRelease("77", other, { outPath });
    other.calls.length = 0;
    await expect(
      restoreReleasePriority(outPath, { ...other, getVariable: async () => "99" }),
    ).resolves.toMatchObject({ cleared: false });
    expect(other.calls).not.toContain(`delete:${RELEASE_PRIORITY_VARIABLE}`);
  });
});
