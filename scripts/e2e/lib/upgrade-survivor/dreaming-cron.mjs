import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const baselineVersion = "2026.9.6";
const baselineCommit = "eb377ac59e6c9fd6c7705028034812becf00271b";
const declarationKey = "memory-core:memory-dreaming-promotion";
const dreamingName = "Memory Dreaming Promotion";
const dreamingTag = "[managed-by=memory-core.short-term-promotion]";
const dreamingMessage = "__openclaw_memory_core_short_term_promotion_dream__";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

function installedIdentity(root) {
  const manifestBytes = fs.readFileSync(path.join(root, "package.json"));
  const buildBytes = fs.readFileSync(path.join(root, "dist/build-info.json"));
  const manifest = JSON.parse(manifestBytes);
  const build = JSON.parse(buildBytes);
  assert.equal(manifest.name, "openclaw");
  assert.equal(manifest.version, build.version);
  return {
    version: manifest.version,
    commit: build.commit,
    manifestSha256: hash(manifestBytes),
    buildInfoSha256: hash(buildBytes),
  };
}

function inspectRows(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM cron_jobs ORDER BY store_key, sort_order, job_id")
      .all()
      .map((row) => Object.assign({}, row));
  } finally {
    db.close();
  }
}

function inspectBackups(databasePath) {
  const directory = path.dirname(databasePath);
  const prefix = `${path.basename(databasePath)}.doctor-cron-`;
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .toSorted()
    .map((name) => ({ name, sha256: hash(fs.readFileSync(path.join(directory, name))) }));
}

function snapshot(fixture) {
  return { rows: inspectRows(fixture.databasePath), backups: inspectBackups(fixture.databasePath) };
}

function configure(stateDir) {
  fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
  writeJson(process.env.OPENCLAW_CONFIG_PATH, {
    gateway: {
      mode: "local",
      bind: "loopback",
      controlUi: { enabled: false },
      auth: { mode: "token", token: "upgrade-survivor-token" },
    },
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: path.join(stateDir, "workspace") } },
    },
    cron: { enabled: false },
    plugins: {
      allow: ["memory-core"],
      slots: { memory: "memory-core" },
      entries: { "memory-core": { enabled: true, config: { dreaming: { enabled: true } } } },
    },
  });
}

// These are historical persisted rows, not jobs created by candidate helpers.
// The shipped schema and definition digest format make them otherwise current.
function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function seed(stateDir, artifacts, baselineRoot, candidateTarball) {
  const baseline = installedIdentity(baselineRoot);
  assert.equal(baseline.version, baselineVersion);
  assert.equal(baseline.commit, baselineCommit);
  const scratch = fs.mkdtempSync(
    path.join(process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT, "dreaming-package-"),
  );
  let candidate;
  try {
    execFileSync("tar", [
      "-xzf",
      candidateTarball,
      "-C",
      scratch,
      "package/package.json",
      "package/openclaw.mjs",
      "package/dist",
    ]);
    const root = path.join(scratch, "package");
    candidate = installedIdentity(root);
    assert.notEqual(candidate.buildInfoSha256, baseline.buildInfoSha256);
    writeJson(
      path.join(artifacts, "dreaming-cron-candidate-package.json"),
      readWorkerCellPackageIdentity(root),
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const databasePath = path.join(stateDir, "state/openclaw.sqlite");
  assert(fs.statSync(databasePath).isFile(), "Baseline preparation did not create SQLite state");
  const active = path.resolve(stateDir, "cron/jobs.json");
  const inactive = path.resolve(stateDir, "cron/retired-profile.json");
  const phaseOnly = path.resolve(stateDir, "cron/phase-only.json");
  const baselineRows = inspectRows(databasePath);
  writeJson(path.join(artifacts, "dreaming-cron-baseline-rows.json"), baselineRows);
  // Published Doctor materializes the default heartbeat even with cron execution disabled.
  assert.equal(baselineRows.length, 1, "Prepared baseline must contain only the main heartbeat");
  const heartbeat = baselineRows[0];
  assert.equal(heartbeat.store_key, active);
  assert.equal(heartbeat.declaration_key, "heartbeat:main");
  assert.equal(heartbeat.agent_id, "main");
  assert.equal(heartbeat.payload_kind, "heartbeat");
  assert.equal(heartbeat.enabled, 1);
  const heartbeatDefinition = JSON.parse(heartbeat.job_json);
  assert.equal(heartbeatDefinition.id, heartbeat.job_id);
  assert.equal(heartbeatDefinition.declarationKey, "heartbeat:main");
  assert.equal(heartbeatDefinition.name, "heartbeat-main");
  assert.equal(heartbeatDefinition.agentId, "main");
  assert.equal(heartbeatDefinition.enabled, true);
  assert.deepEqual(heartbeatDefinition.payload, { kind: "heartbeat" });
  assert.equal(heartbeatDefinition.schedule.kind, "every");
  assert.equal(heartbeatDefinition.schedule.everyMs, 1_800_000);
  assert.equal(heartbeatDefinition.sessionTarget, "main");
  assert.equal(heartbeatDefinition.wakeMode, "next-heartbeat");
  const make = (storeKey, id, createdAtMs, overrides = {}) => ({
    storeKey,
    definition: {
      id,
      name: dreamingName,
      description: dreamingTag,
      enabled: false,
      agentId: "main",
      owner: { agentId: "main" },
      createdAtMs,
      schedule: { kind: "cron", expr: "17 3 * * *", tz: "UTC", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: dreamingMessage },
      delivery: { mode: "none" },
      state: {},
      ...overrides,
    },
  });
  const phase = (kind) => ({
    name: `Memory ${kind === "light" ? "Light" : "REM"} Dreaming`,
    description: `[managed-by=memory-core.dreaming.${kind}]`,
    payload: {
      kind: "systemEvent",
      text: `__openclaw_memory_core_${kind === "light" ? "light" : "rem"}_sleep__`,
    },
  });
  const jobs = [
    make(active, "dreaming-active-declared", 200, {
      declarationKey,
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: dreamingMessage,
        lightContext: false,
        timeoutSeconds: 60,
      },
    }),
    make(active, "dreaming-active-older-unkeyed", 100),
    make(active, "dreaming-active-light", 90, phase("light")),
    make(inactive, "dreaming-inactive-survivor", 100),
    make(inactive, "dreaming-inactive-duplicate", 200),
    make(inactive, "dreaming-inactive-rem", 90, phase("rem")),
    make(phaseOnly, "dreaming-phase-survivor", 100, phase("light")),
    make(phaseOnly, "dreaming-phase-duplicate", 200, phase("rem")),
    make(active, "dreaming-authored-lookalike", 50, {
      description: "An operator-authored reminder",
      payload: { kind: "systemEvent", text: "Write a personal dream diary" },
    }),
    make(active, "dreaming-foreign-declaration", 25, {
      declarationKey: "another-plugin:owned-job",
    }),
  ];
  const db = new DatabaseSync(databasePath);
  try {
    const insert = db.prepare(`INSERT INTO cron_jobs (
      store_key, job_id, declaration_key, owner_agent_id, name, description, enabled,
      agent_id, payload_kind, job_json, grant_definition_revision,
      grant_definition_generation, grant_definition_updated_at, state_json,
      runtime_updated_at_ms, schedule_identity, sort_order, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec("BEGIN IMMEDIATE");
    for (const [index, { storeKey, definition }] of jobs.entries()) {
      const updatedAt = 1_800_000_000_000 + index;
      const { enabled: _enabled, state: _state, ...grantDefinition } = definition;
      const revision = `sha256:${createHash("sha256").update(stableJson(grantDefinition)).digest("base64url")}`;
      const runtimeState = {
        lastRunAtMs: updatedAt - 10_000,
        lastRunStatus: "error",
        lastStatus: "error",
        lastDurationMs: 321 + index,
        consecutiveErrors: 2,
        lastError: "synthetic retained error",
      };
      insert.run(
        storeKey,
        definition.id,
        definition.declarationKey ?? null,
        "main",
        definition.name,
        definition.description,
        0,
        "main",
        definition.payload.kind,
        JSON.stringify(definition),
        revision,
        3,
        updatedAt,
        JSON.stringify(runtimeState),
        updatedAt + 10,
        JSON.stringify({
          version: 2,
          enabled: false,
          schedule: definition.schedule,
          hasTrigger: false,
        }),
        10 + index * 3,
        updatedAt,
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const fixture = {
    baseline,
    candidate,
    candidateTarballSha256: hash(fs.readFileSync(candidateTarball)),
    databasePath,
    baselineRows,
  };
  writeJson(path.join(artifacts, "dreaming-cron-fixture.json"), {
    ...fixture,
    before: snapshot(fixture),
  });
}

function assertRepaired(fixture, rows) {
  const survivorIds = [
    "dreaming-active-declared",
    "dreaming-inactive-survivor",
    "dreaming-phase-survivor",
  ];
  const preservedIds = [
    "dreaming-authored-lookalike",
    "dreaming-foreign-declaration",
    ...fixture.baselineRows.map((row) => row.job_id),
  ];
  assert.deepEqual(
    rows.map((row) => row.job_id).toSorted((left, right) => left.localeCompare(right)),
    [...survivorIds, ...preservedIds].toSorted((left, right) => left.localeCompare(right)),
    "Dreaming migration chose the wrong survivors or retained a duplicate/phase",
  );
  for (const row of rows) {
    const before =
      fixture.baselineRows.find((entry) => entry.job_id === row.job_id) ??
      fixture.before.rows.find((entry) => entry.job_id === row.job_id);
    if (preservedIds.includes(row.job_id)) {
      assert.deepEqual(row, before, `Preserved job changed: ${row.job_id}`);
      continue;
    }
    for (const field of [
      "store_key",
      "job_id",
      "sort_order",
      "state_json",
      "runtime_updated_at_ms",
    ]) {
      assert.equal(row[field], before[field], `Survivor ${row.job_id} lost ${field}`);
    }
    const definition = JSON.parse(row.job_json);
    assert.equal(row.declaration_key, declarationKey);
    assert.equal(definition.declarationKey, declarationKey);
    assert.equal(definition.id, row.job_id);
    assert.equal(definition.sessionTarget, "isolated");
    assert.equal(definition.payload.kind, "agentTurn");
    assert.equal(definition.payload.message, dreamingMessage);
    assert.equal(definition.payload.lightContext, true);
    assert.equal(definition.payload.text, undefined);
    assert.equal(definition.delivery.mode, "none");
    const original = JSON.parse(before.job_json);
    for (const field of ["createdAtMs", "schedule", "enabled", "owner", "agentId", "wakeMode"]) {
      assert.deepEqual(
        definition[field],
        original[field],
        `Survivor ${row.job_id} changed ${field}`,
      );
    }
    if (row.job_id === "dreaming-active-declared") {
      assert.equal(definition.payload.timeoutSeconds, 60);
    }
  }
}

function observeProcess() {
  const fixturePath = process.env.OPENCLAW_UPGRADE_SURVIVOR_DREAMING_CRON_FIXTURE;
  const observations = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  const delegatedDoctor =
    process.argv[2] === "--doctor" &&
    path.basename(process.argv[1] ?? "") === "update-migrated-finalize.worker.js";
  const role = delegatedDoctor ? "doctor" : process.argv[2];
  if (!isMainThread || !fixturePath || !observations || !["doctor", "update"].includes(role)) {
    return;
  }
  const receipt = {
    role,
    pid: process.pid,
    parentPid: process.ppid,
    transport: delegatedDoctor ? "delegated-worker" : "cli",
    updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1",
    repair: process.argv.includes("--repair"),
    nonInteractive: process.argv.includes("--non-interactive"),
  };
  let fixture;
  try {
    fixture = readJson(fixturePath);
    assert.equal(
      fixture.databasePath,
      path.join(process.env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite"),
    );
    let root = path.dirname(fs.realpathSync(process.argv[1]));
    for (let depth = 0; depth < 3; depth++, root = path.dirname(root)) {
      if (
        fs.existsSync(path.join(root, "package.json")) &&
        readJson(path.join(root, "package.json")).name === "openclaw"
      ) {
        receipt.identity = installedIdentity(root);
        receipt.entrypoint = path.relative(root, fs.realpathSync(process.argv[1]));
        break;
      }
    }
    receipt.before = snapshot(fixture);
  } catch (error) {
    receipt.observationError = String(error);
  }
  const file = path.join(observations, `dreaming-cron-${role}-${process.pid}.json`);
  writeJson(file, receipt);
  process.once("exit", (exitCode) => {
    try {
      receipt.after = snapshot(fixture);
    } catch (error) {
      receipt.observationError = String(error);
    }
    writeJson(file, { ...receipt, exitCode });
  });
}

function assertUpdated(artifacts, observations, packageRoot, candidateTarball) {
  const fixture = readJson(path.join(artifacts, "dreaming-cron-fixture.json"));
  assert.equal(hash(fs.readFileSync(candidateTarball)), fixture.candidateTarballSha256);
  assertWorkerCellPackageIdentity(
    readWorkerCellPackageIdentity(packageRoot),
    readJson(path.join(artifacts, "dreaming-cron-candidate-package.json")),
  );
  const receipts = fs
    .readdirSync(observations)
    .filter((name) => /^dreaming-cron-(doctor|update)-\d+\.json$/u.test(name))
    .map((name) => readJson(path.join(observations, name)));
  const updater = receipts.find(
    (entry) =>
      entry.role === "update" &&
      entry.identity?.buildInfoSha256 === fixture.baseline.buildInfoSha256,
  );
  assert(updater, "No published updater process observed");
  assert.deepEqual(updater.identity, fixture.baseline);
  assert.deepEqual(
    updater.before,
    fixture.before,
    "Published updater did not receive the seeded rows",
  );
  const doctor = receipts.find(
    (entry) =>
      entry.role === "doctor" &&
      (entry.transport === "delegated-worker" || (entry.repair && entry.nonInteractive)) &&
      entry.identity?.buildInfoSha256 === fixture.candidate.buildInfoSha256 &&
      entry.before?.rows.some((row) => row.job_id === "dreaming-inactive-duplicate"),
  );
  assert(doctor, "Packaged candidate Doctor never received unrepaired dreaming rows");
  assert.deepEqual(doctor.identity, fixture.candidate);
  assert.equal(doctor.updateInProgress, true, "Repair was not the installed updater's child");
  if (doctor.transport === "cli") {
    assert.equal(doctor.repair, true, "Installed updater did not request Doctor repair");
    assert.equal(doctor.nonInteractive, true);
  } else {
    assert.equal(doctor.entrypoint, "dist/infra/update-migrated-finalize.worker.js");
  }
  assert.deepEqual(
    doctor.before,
    fixture.before,
    "Runtime or earlier startup changed the specimen before Doctor",
  );
  for (const witness of [updater, doctor]) {
    assert.equal(witness.observationError, undefined);
    assert.equal(witness.exitCode, 0);
    const exited = readJson(
      path.join(observations, "diagnostics", `process-${witness.pid}-exited.json`),
    );
    assert.equal(exited.pid, witness.pid);
    assert.equal(exited.parentPid, witness.parentPid);
    assert.equal(exited.role, witness.role);
    assert.equal(exited.packageVersion, witness.identity.version);
    assert.equal(exited.exitCode, 0);
  }
  assertRepaired(fixture, doctor.after.rows);
  const current = snapshot(fixture);
  assert.deepEqual(current, doctor.after, "Cron changed after updater Doctor exited");
  const added = current.backups.filter(
    (entry) => !fixture.before.backups.some((before) => before.name === entry.name),
  );
  assert.equal(added.length, 1, "Repair must retain exactly one new cron backup");
  const backupPath = path.join(path.dirname(fixture.databasePath), added[0].name);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.deepEqual(
      backup
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check),
      ["ok"],
    );
    assert.deepEqual(backup.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    backup.close();
  }
  assert.deepEqual(
    inspectRows(backupPath),
    fixture.before.rows,
    "Verified backup did not preserve the pre-repair jobs",
  );
  writeJson(path.join(artifacts, "dreaming-cron-updated.json"), current);
  writeJson(path.join(artifacts, "dreaming-cron-proof.json"), {
    status: "updater-child-repaired",
    baseline: fixture.baseline,
    candidate: fixture.candidate,
    updaterPid: updater.pid,
    doctorPid: doctor.pid,
    doctorTransport: doctor.transport,
    backup: added[0],
    baselineHeartbeatId: fixture.baselineRows[0].job_id,
    survivors: current.rows.map((row) => ({
      id: row.job_id,
      storeKey: row.store_key,
      sortOrder: row.sort_order,
    })),
  });
}

async function reportUpdateFailure(file, packageRoot) {
  const raw = fs.readFileSync(file, "utf8");
  const jsonStart = raw.indexOf("{");
  assert.notEqual(jsonStart, -1, "Update reported no JSON result");
  const result = JSON.parse(raw.slice(jsonStart));
  const step = result.steps?.find((entry) => entry.name === "candidate-gateway-startup");
  assert(step, "Update result has no candidate Gateway startup step");
  const { redactSensitiveText } = await import(
    pathToFileURL(path.join(packageRoot, "dist/plugin-sdk/logging-core.js")).href
  );
  const report = {
    step: step.name,
    exitCode: step.exitCode,
    stderrTail: redactSensitiveText(step.stderrTail ?? "", { mode: "tools" }),
    stdoutTail: redactSensitiveText(step.stdoutTail ?? "", { mode: "tools" }),
  };
  process.stdout.write(`DREAMING_CRON_GATEWAY_STARTUP ${JSON.stringify(report)}\n`);
}

observeProcess();
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  assert(stateDir && artifacts, "Missing isolated survivor paths");
  if (command === "configure") {
    configure(stateDir);
  } else if (command === "seed") {
    seed(stateDir, artifacts, ...args);
  } else if (command === "assert-updated") {
    assertUpdated(artifacts, ...args);
  } else if (command === "report-update-failure") {
    await reportUpdateFailure(...args);
  } else {
    assert.equal(command, "assert-idempotent");
    const fixture = readJson(path.join(artifacts, "dreaming-cron-fixture.json"));
    assert.deepEqual(
      snapshot(fixture),
      readJson(path.join(artifacts, "dreaming-cron-updated.json")),
      "Repeated Doctor rewrote cron rows or created another backup",
    );
    const proofPath = path.join(artifacts, "dreaming-cron-proof.json");
    const proof = {
      ...readJson(proofPath),
      status: "passed",
      explicitDoctorIdempotent: true,
    };
    writeJson(proofPath, proof);
    process.stdout.write(`DREAMING_CRON_PROOF ${JSON.stringify(proof)}\n`);
  }
}
