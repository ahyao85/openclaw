import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { ExtraGatewayService } from "./inspect.js";
import { readWindowsServiceProcessObservation } from "./schtasks-process-inspection.js";
import { readScheduledTaskRuntime } from "./schtasks-runtime.js";
import {
  ScheduledTaskInspectionError,
  WindowsServiceObservationChangedError,
} from "./schtasks-state-probe.js";
import { inspectServicePublicationConsumers } from "./service-publication-consumers.js";
import { inspectServicePublicationFootprint } from "./service-publication-footprint.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";

const native = vi.hoisted(() => ({
  snapshot: vi.fn<typeof import("node:child_process").spawnSync>(),
  task: vi.fn<typeof import("./schtasks-state-probe.js").probeScheduledTaskState>(),
  taskCommand: vi.fn<typeof import("./schtasks-layout.js").readRegisteredScheduledTaskCommand>(),
  startupCommand: vi.fn<typeof import("./schtasks-layout.js").readStartupEntryCommand>(),
  selectedRuntime:
    vi.fn<typeof import("./schtasks-process.js").resolveListenerBackedScheduledTaskRuntime>(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: native.snapshot,
}));
vi.mock("./schtasks-state-probe.js", async (original) => ({
  ...(await original<typeof import("./schtasks-state-probe.js")>()),
  probeScheduledTaskState: native.task,
}));
vi.mock("./schtasks-layout.js", async (original) => ({
  ...(await original<typeof import("./schtasks-layout.js")>()),
  readRegisteredScheduledTaskCommand: native.taskCommand,
  readStartupEntryCommand: native.startupCommand,
}));

vi.mock("./schtasks-process.js", async (original) => ({
  ...(await original<typeof import("./schtasks-process.js")>()),
  resolveListenerBackedScheduledTaskRuntime: native.selectedRuntime,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function processRow(
  pid: number,
  argv: readonly string[] | null,
  startedAt: string | null = "638940000000000022",
  parentPid = 800,
) {
  return {
    ProcessId: pid,
    ParentProcessId: parentPid,
    CreationDate: startedAt,
    Name: "node.exe",
    CommandLine: argv?.map((arg) => `"${arg}"`).join(" ") ?? null,
  };
}

function snapshot(rows: ReturnType<typeof processRow>[] | null) {
  const stdout =
    rows === null ? "" : JSON.stringify([processRow(9999, ["powershell.exe"]), ...rows]);
  return {
    pid: 9999,
    output: [null, stdout, ""],
    status: rows === null ? 1 : 0,
    stdout,
    stderr: "",
    signal: null,
  };
}

async function fixture(kind: "task" | "startup" = "task") {
  mockProcessPlatform("win32");
  const home = dirs.make("windows-publication-consumers-");
  const active = path.join(home, "active %% ^!");
  const unrelated = path.join(home, "unrelated");
  for (const root of [active, unrelated]) {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n");
  }
  const sourcePath = path.join(home, "gateway.cmd");
  const startupPath = path.join(home, "gateway.vbs");
  const service: ExtraGatewayService = {
    platform: "win32",
    scope: kind === "task" ? "system" : "user",
    label: "\\Ops\\Sibling Gateway",
    detail: "synthetic native consumer",
    sourcePath,
    ...(kind === "startup" ? { windowsStartupEntry: startupPath } : {}),
  };
  const command = (root = active): GatewayServiceCommandConfig => ({
    sourcePath,
    definitionPaths: kind === "startup" ? [startupPath, sourcePath] : [sourcePath],
    programArguments: [
      process.execPath,
      path.join(root, "openclaw.mjs"),
      "gateway",
      "--port",
      "19789",
    ],
  });
  const relativeCommand = (root = active): GatewayServiceCommandConfig => ({
    ...command(root),
    workingDirectory: root,
    programArguments: [process.execPath, "openclaw.mjs", "gateway", "--port", "19789"],
  });
  let currentCommand = command();
  let processes: ReturnType<typeof processRow>[] | null = [
    processRow(45001, currentCommand.programArguments),
  ];
  native.snapshot.mockImplementation(() => snapshot(processes));
  native.task.mockReturnValue({ status: "found", taskPath: service.label, state: 3 });
  native.taskCommand.mockImplementation(async () => ({ command: currentCommand, state: 3 }));
  native.startupCommand.mockImplementation(async () => currentCommand);
  const params = {
    inventory: { services: [service], errors: [] },
    targets: [await inspectServicePublicationFootprint(active, () => {})],
    mode: "whole-package" as const,
    env: { USERPROFILE: home, OPENCLAW_WINDOWS_TASK_NAME: service.label },
    assertCurrent: () => {},
    timeoutMs: 30_000,
  };
  return {
    params,
    service,
    active,
    unrelated,
    command,
    relativeCommand,
    setCommand(value: GatewayServiceCommandConfig) {
      currentCommand = value;
    },
    setProcesses(value: typeof processes) {
      processes = value;
    },
    capture(pid: number) {
      const observation = readWindowsServiceProcessObservation(params.env);
      if (!observation) {
        throw new Error("Expected synthetic native observation");
      }
      return observation.family(pid);
    },
  };
}

it.each(["task", "startup"] as const)(
  "retains positive relative-launcher association until the %s process exits",
  async (kind) => {
    const f = await fixture(kind);
    const command = f.relativeCommand();
    f.setCommand(command);
    f.setProcesses([processRow(45001, command.programArguments)]);
    const first = await inspectServicePublicationConsumers(f.params);
    expect(first.blockers.length).toBeGreaterThan(0);
    const retained = {
      ...f.params,
      knownWindowsProcesses: first.windowsProcesses,
      knownOverlappingConsumers: first.overlappingConsumers,
    };
    f.setCommand(f.relativeCommand(f.unrelated));
    const retargeted = await inspectServicePublicationConsumers(retained);
    expect(retargeted.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "Windows process 45001" })]),
    );
    f.setProcesses([]);
    expect(await inspectServicePublicationConsumers(retained)).toMatchObject({
      blockers: [],
      warnings: [],
    });
  },
);

it.each(["current", "retargeted"] as const)(
  "retains a direct Task's relative process with initially %s registration until it exits",
  async (registration) => {
    const f = await fixture();
    delete f.service.sourcePath;
    const { readRegisteredScheduledTaskCommand } =
      await vi.importActual<typeof import("./schtasks-layout.js")>("./schtasks-layout.js");
    native.taskCommand.mockImplementation(readRegisteredScheduledTaskCommand);
    const action = {
      type: 0,
      path: "C:\\Node\\node.exe",
      arguments: "dist/index.js gateway",
      workingDirectory: registration === "current" ? "C:\\Install A" : "C:\\Install B",
    };
    const registered = { status: "found" as const, taskPath: f.service.label, state: 3 };
    native.task.mockImplementation(() => ({ ...registered, actions: [{ ...action }] }));
    const entrypoints = new Map<string, string>();
    for (const [directory, root] of [
      ["C:\\Install A", f.active],
      ["C:\\Install B", f.unrelated],
    ] as const) {
      const entrypoint = path.join(root, "dist", "index.js");
      await fs.mkdir(path.dirname(entrypoint));
      await fs.writeFile(entrypoint, "export {};\n");
      entrypoints.set(path.resolve(path.win32.join(directory, "dist", "index.js")), entrypoint);
    }
    // Map only the two synthetic Windows entrypoints onto the test's real package files.
    const realpath = fs.realpath;
    vi.spyOn(fs, "realpath").mockImplementation(async (file) =>
      realpath(entrypoints.get(String(file)) ?? file),
    );
    const argv = [action.path, "dist/index.js", "gateway"];
    f.setProcesses([processRow(45001, argv)]);
    const first = await inspectServicePublicationConsumers(f.params);
    expect(first.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "Windows process 45001" })]),
    );
    expect(first.windowsProcesses).toEqual([
      {
        pid: 45001,
        parentPid: 800,
        startedAt: "638940000000000022",
        programArguments: argv,
      },
    ]);
    const retained = {
      ...f.params,
      knownWindowsProcesses: first.windowsProcesses,
      knownOverlappingConsumers: first.overlappingConsumers,
    };
    action.workingDirectory = "C:\\Install B";
    expect((await inspectServicePublicationConsumers(retained)).blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "Windows process 45001" })]),
    );
    f.setProcesses([]);
    expect(await inspectServicePublicationConsumers(retained)).toMatchObject({
      blockers: [],
      warnings: [],
      windowsProcesses: [],
    });
  },
);

it("refuses a relative live command when its registered directory is disjoint", async () => {
  const f = await fixture();
  const command = f.relativeCommand(f.unrelated);
  f.setCommand(command);
  f.setProcesses([processRow(45001, command.programArguments)]);
  const result = await inspectServicePublicationConsumers(f.params);
  expect(result.blockers).toEqual([
    expect.objectContaining({
      source: "Windows process 45001",
      message: expect.stringContaining("could not be verified"),
    }),
  ]);
  expect(result.warnings.length).toBeGreaterThan(0);
  expect(result.overlappingConsumers.size).toBe(0);
});

it("parks only the authorized foreground PID among unresolved relative processes", async () => {
  const f = await fixture();
  const command = f.relativeCommand(f.unrelated);
  f.setCommand(command);
  f.setProcesses([
    processRow(45001, command.programArguments),
    processRow(45002, command.programArguments, "638940000000000023"),
  ]);
  const readParkedForegroundPid = vi.fn(async () => 45001);
  const result = await inspectServicePublicationConsumers({ ...f.params, readParkedForegroundPid });
  expect(readParkedForegroundPid).toHaveBeenCalledOnce();
  expect(result.blockers).toEqual([
    expect.objectContaining({
      source: "Windows process 45002",
      message: expect.stringContaining("could not be verified"),
    }),
  ]);
  expect(result.overlappingConsumers.size).toBe(0);
});

it("does not let a registered directory override an absolute live entrypoint", async () => {
  const f = await fixture();
  f.setCommand(f.relativeCommand());
  f.setProcesses([processRow(45001, f.command(f.unrelated).programArguments)]);
  expect(await inspectServicePublicationConsumers(f.params)).toMatchObject({ blockers: [] });
});

it("does not revoke absolute native disjointness when only the registered directory changes", async () => {
  const f = await fixture();
  const command = f.command(f.unrelated);
  f.setProcesses([processRow(45001, command.programArguments)]);
  native.taskCommand
    .mockResolvedValueOnce({ command: { ...command, workingDirectory: f.active }, state: 3 })
    .mockResolvedValue({ command: { ...command, workingDirectory: f.unrelated }, state: 3 });
  expect(await inspectServicePublicationConsumers(f.params)).toMatchObject({
    blockers: [],
    warnings: [],
  });
});

it("rejects registered-directory drift while inspecting a relative live command", async () => {
  const f = await fixture();
  const command = f.relativeCommand();
  f.setCommand(command);
  f.setProcesses([processRow(45001, command.programArguments)]);
  native.taskCommand
    .mockResolvedValueOnce({ command, state: 3 })
    .mockResolvedValue({ command: f.relativeCommand(f.unrelated), state: 3 });
  await expect(inspectServicePublicationConsumers(f.params)).rejects.toThrow(
    "changed during consumer inspection",
  );
});

it("retains every relative process association without delegating an unverified directory", async () => {
  const f = await fixture();
  const command = f.relativeCommand();
  f.setCommand(command);
  const firstProcess = processRow(45001, command.programArguments);
  const sibling = processRow(45002, command.programArguments, "638940000000000023");
  f.setProcesses([firstProcess, sibling]);
  const selected = { service: f.service, command, windowsProcesses: f.capture(45001) };
  const first = await inspectServicePublicationConsumers({
    ...f.params,
    selected,
  });
  expect(first.blockers).toEqual(
    expect.arrayContaining([expect.objectContaining({ source: "Windows process 45002" })]),
  );
  const withoutRegistration = await inspectServicePublicationConsumers({
    ...f.params,
    inventory: { services: [], errors: [] },
    selected,
    knownWindowsProcesses: first.windowsProcesses,
    knownOverlappingConsumers: first.overlappingConsumers,
  });
  expect(withoutRegistration.blockers.map(({ source }) => source)).toEqual([
    "Windows process 45001",
    "Windows process 45002",
  ]);
  f.setProcesses([sibling]);
  f.setCommand(f.relativeCommand(f.unrelated));
  const retained = {
    ...f.params,
    knownWindowsProcesses: first.windowsProcesses,
    knownOverlappingConsumers: first.overlappingConsumers,
  };
  expect((await inspectServicePublicationConsumers(retained)).blockers).toEqual(
    expect.arrayContaining([expect.objectContaining({ source: "Windows process 45002" })]),
  );
  native.taskCommand.mockResolvedValue(null);
  expect((await inspectServicePublicationConsumers(retained)).blockers).toEqual(
    expect.arrayContaining([expect.objectContaining({ source: "Windows process 45002" })]),
  );
});

it.each(["parked", "sibling", "birth changed", "unidentified", "revoked"] as const)(
  "requires current foreground closure and stable native process identity: %s",
  async (outcome) => {
    const f = await fixture();
    f.params.inventory.services = [];
    const parent = processRow(45001, f.command().programArguments);
    f.setProcesses(
      outcome === "unidentified"
        ? [{ ...parent, CreationDate: null }]
        : outcome === "sibling"
          ? [parent, processRow(45002, f.command().programArguments, "638940000000000023")]
          : [parent],
    );
    const revoked = new Error("foreground helper lost its live claim");
    const readParkedForegroundPid = vi.fn(async () => {
      await Promise.resolve();
      if (outcome === "revoked") {
        throw revoked;
      }
      if (outcome === "birth changed") {
        f.setProcesses([{ ...parent, CreationDate: "638940000000000023" }]);
      }
      return 45001;
    });
    const inspect = inspectServicePublicationConsumers({ ...f.params, readParkedForegroundPid });
    if (outcome === "revoked") {
      await expect(inspect).rejects.toBe(revoked);
    } else if (outcome === "birth changed") {
      await expect(inspect).rejects.toBeInstanceOf(WindowsServiceObservationChangedError);
    } else {
      const result = await inspect;
      expect(result.blockers).toHaveLength(outcome === "parked" ? 0 : 1);
      if (outcome === "sibling") {
        expect(result.blockers[0]?.source).toBe("Windows process 45002");
        expect(readParkedForegroundPid).toHaveBeenCalledOnce();
      } else if (outcome === "unidentified") {
        expect(readParkedForegroundPid).not.toHaveBeenCalled();
      }
    }
  },
);

it.each(["task", "startup"] as const)(
  "refuses the live shared %s process after its definition changes or disappears",
  async (kind) => {
    const f = await fixture(kind);
    f.setCommand(f.command(f.unrelated));
    for (const services of [[f.service], []]) {
      const result = await inspectServicePublicationConsumers({
        ...f.params,
        inventory: { services, errors: [] },
      });
      expect(result.blockers).toEqual([
        {
          source: "Windows process 45001",
          message: expect.stringContaining("consumes the installation"),
        },
      ]);
      expect(result.warnings).toEqual([]);
      expect(result.windowsProcesses?.map(({ pid }) => pid)).toEqual([45001]);
    }
    f.setProcesses([]);
    expect(
      await inspectServicePublicationConsumers({
        ...f.params,
        inventory: { services: [], errors: [] },
      }),
    ).toMatchObject({ blockers: [], warnings: [], windowsProcesses: [] });
  },
);

it("does not mistake Scheduler Ready for extinction of its matching Gateway", async () => {
  const f = await fixture();
  const result = await inspectServicePublicationConsumers(f.params);
  expect(result.blockers).toEqual([
    {
      source: "Windows process 45001",
      message: expect.stringContaining("consumes the installation"),
    },
  ]);
  expect(result.warnings).toEqual([]);
});

it.each(["missing", "redirected"] as const)(
  "retains every observed process overlap when its entrypoint becomes %s",
  async (change) => {
    const f = await fixture();
    const command = f.command();
    const sibling = processRow(45002, command.programArguments, "638940000000000023");
    f.setProcesses([processRow(45001, command.programArguments), sibling]);
    native.taskCommand.mockResolvedValueOnce({ command, state: 3 }).mockImplementation(async () => {
      const entrypoint = path.join(f.active, "openclaw.mjs");
      await fs.unlink(entrypoint);
      if (change === "redirected") {
        await fs.symlink(path.join(f.unrelated, "openclaw.mjs"), entrypoint);
      }
      return { command, state: 3 };
    });
    const observed = await inspectServicePublicationConsumers(f.params);
    expect(observed.blockers.map(({ source }) => source)).toEqual([
      "Windows process 45001",
      "Windows process 45002",
    ]);
    expect(observed.warnings).toEqual([]);

    const retained = {
      ...f.params,
      inventory: { services: [], errors: [] },
      knownWindowsProcesses: observed.windowsProcesses,
      knownOverlappingConsumers: observed.overlappingConsumers,
    };
    f.setProcesses([sibling]);
    const surviving = await inspectServicePublicationConsumers(retained);
    expect(surviving.blockers.map(({ source }) => source)).toEqual(["Windows process 45002"]);
    expect(surviving.warnings).toEqual([]);
    f.setProcesses([{ ...sibling, CreationDate: "638940000000000024" }]);
    const replacement = await inspectServicePublicationConsumers(retained);
    expect(replacement.blockers).toEqual([]);
    expect(replacement.warnings).toHaveLength(change === "missing" ? 1 : 0);
  },
);

it.each(["birth", "argv", "family", "duplicate"] as const)(
  "delegates only the captured selected family when %s changes",
  async (change) => {
    const f = await fixture();
    const argv = f.command().programArguments;
    const supervisor = processRow(45000, [...argv, "--task-supervisor"], "638940000000000021");
    const child = processRow(
      45001,
      [...argv, "--task-supervisor-child=305419896"],
      "638940000000000022",
      45000,
    );
    f.setProcesses([supervisor, child]);
    const selected = {
      service: f.service,
      command: f.command(),
      windowsProcesses: f.capture(child.ProcessId),
    };
    const params = { ...f.params, selected };
    expect(await inspectServicePublicationConsumers(params)).toMatchObject({
      blockers: [],
      warnings: [],
    });
    f.setProcesses(
      change === "family"
        ? [child]
        : [
            supervisor,
            change === "birth"
              ? { ...child, CreationDate: "638940000000000023" }
              : change === "argv"
                ? processRow(
                    45001,
                    [...argv, "--debug", "--task-supervisor-child=305419896"],
                    child.CreationDate,
                    45000,
                  )
                : child,
            ...(change === "duplicate" ? [processRow(45002, argv)] : []),
          ],
    );
    const result = await inspectServicePublicationConsumers(params);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(
      result.blockers.every(({ message }) => message.includes("consumes the installation")),
    ).toBe(true);
    expect(result.warnings).toEqual([]);
    if (change === "duplicate") {
      expect(result.blockers.map(({ source }) => source)).toEqual(["Windows process 45002"]);
    }
  },
);

it("warns for initial unavailable inspection, but refuses after an overlapping process was observed", async () => {
  const f = await fixture();
  const params = { ...f.params, inventory: { services: [], errors: [] } };
  f.setProcesses(null);
  const initial = await inspectServicePublicationConsumers(params);
  expect(initial.blockers).toEqual([]);
  expect(initial.warnings).toHaveLength(1);
  expect(initial.overlappingConsumers.size).toBe(0);
  f.setProcesses([processRow(45001, f.command().programArguments)]);
  const known = await inspectServicePublicationConsumers(params);
  expect(known.blockers).toHaveLength(1);
  f.setProcesses(null);
  const unavailable = await inspectServicePublicationConsumers({
    ...params,
    knownWindowsProcesses: known.windowsProcesses,
    knownOverlappingConsumers: known.overlappingConsumers,
  });
  expect(unavailable.blockers).toHaveLength(1);
  expect(unavailable.warnings).toEqual([]);
});

it("retains overlap when the same process becomes unreadable, and releases it only after proven exit", async () => {
  const f = await fixture();
  const params = { ...f.params, inventory: { services: [], errors: [] } };
  const known = await inspectServicePublicationConsumers(params);
  const retained = {
    ...params,
    knownWindowsProcesses: known.windowsProcesses,
    knownOverlappingConsumers: known.overlappingConsumers,
  };
  f.setProcesses([processRow(45001, null)]);
  const unavailable = await inspectServicePublicationConsumers(retained);
  expect(unavailable.blockers).toHaveLength(1);
  expect(unavailable.warnings).toEqual([]);
  f.setProcesses([]);
  expect(await inspectServicePublicationConsumers(retained)).toMatchObject({
    blockers: [],
    warnings: [],
  });
});

it("propagates process currentness loss even when the first observed installation was disjoint", async () => {
  const f = await fixture();
  const observed = processRow(45001, f.command(f.unrelated).programArguments);
  native.snapshot
    .mockImplementationOnce(() => snapshot([observed]))
    .mockImplementation(() => snapshot([{ ...observed, CreationDate: "638940000000000023" }]));
  await expect(
    inspectServicePublicationConsumers({
      ...f.params,
      inventory: { services: [], errors: [] },
    }),
  ).rejects.toBeInstanceOf(WindowsServiceObservationChangedError);
});

it.each(["primary", "supervisor"] as const)(
  "does not capture a replacement %s identity after selected-runtime lookup yields",
  async (changed) => {
    const f = await fixture();
    const argv = f.command().programArguments;
    const supervisor = processRow(45000, [...argv, "--task-supervisor"], "638940000000000021");
    const child = processRow(
      45001,
      [...argv, "--task-supervisor-child=305419896"],
      "638940000000000022",
      45000,
    );
    f.setProcesses([supervisor, child]);
    native.selectedRuntime.mockImplementation(async () => {
      await Promise.resolve();
      f.setProcesses([
        changed === "supervisor"
          ? { ...supervisor, CreationDate: "638940000000000023" }
          : supervisor,
        changed === "primary" ? { ...child, CreationDate: "638940000000000023" } : child,
      ]);
      return { status: "running", pid: child.ProcessId };
    });
    await expect(readScheduledTaskRuntime(f.params.env)).rejects.toBeInstanceOf(
      WindowsServiceObservationChangedError,
    );
  },
);

it("an unverified disjoint candidate cannot hide a separate live shared consumer", async () => {
  const f = await fixture();
  f.setProcesses([
    processRow(44000, f.command(f.unrelated).programArguments, null),
    processRow(45001, f.command().programArguments),
  ]);
  const result = await inspectServicePublicationConsumers({
    ...f.params,
    inventory: { services: [], errors: [] },
  });
  expect(result.blockers).toEqual([
    {
      source: "Windows process 45001",
      message: expect.stringContaining("consumes the installation"),
    },
  ]);
  expect(result.warnings).toHaveLength(1);
  expect(result.windowsProcesses?.map(({ pid }) => pid)).toEqual([45001]);
});

it("refuses a recognizably shared candidate without inventing a delegable process identity", async () => {
  const f = await fixture();
  f.setProcesses([processRow(45001, f.command().programArguments, null)]);
  const result = await inspectServicePublicationConsumers({
    ...f.params,
    inventory: { services: [], errors: [] },
  });
  expect(result.blockers).toHaveLength(1);
  expect(result.warnings).toEqual([]);
  expect(result.windowsProcesses).toEqual([]);
});

it.each(["active", "unrelated"] as const)(
  "handles an unavailable native re-read after observing %s code by its demonstrated relation",
  async (root) => {
    const f = await fixture();
    const observed = processRow(45001, f.command(f[root]).programArguments);
    native.snapshot
      .mockImplementationOnce(() => snapshot([observed]))
      .mockImplementation(() => snapshot(null));
    const result = await inspectServicePublicationConsumers({
      ...f.params,
      inventory: { services: [], errors: [] },
    });
    if (root === "active") {
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(result.warnings).toEqual([]);
      expect(result.overlappingConsumers.size).toBeGreaterThan(0);
    } else {
      expect(result.blockers).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.overlappingConsumers.size).toBe(0);
    }
  },
);

it.each(["active", "unrelated"] as const)(
  "uses demonstrated overlap when %s Task command re-inspection becomes unavailable",
  async (root) => {
    const f = await fixture();
    f.setProcesses([]);
    native.taskCommand
      .mockResolvedValueOnce({ command: f.command(f[root]), state: 3 })
      .mockRejectedValue(
        new ScheduledTaskInspectionError({
          status: "unknown",
          detail: "Synthetic transient native probe failure",
        }),
      );
    const result = await inspectServicePublicationConsumers(f.params);
    expect(result.blockers).toHaveLength(root === "active" ? 1 : 0);
    expect(result.warnings).toHaveLength(root === "active" ? 0 : 1);
    expect(result.overlappingConsumers.size).toBe(root === "active" ? 1 : 0);
  },
);

it.each(["missing", "different identity"] as const)(
  "refuses a disjoint Task whose registered command verification reports %s",
  async (changed) => {
    const f = await fixture();
    f.setProcesses([]);
    f.setCommand(f.command(f.unrelated));
    native.taskCommand.mockResolvedValueOnce({ command: f.command(f.unrelated), state: 3 });
    if (changed === "missing") {
      native.taskCommand.mockResolvedValue(null);
    } else {
      native.taskCommand.mockRejectedValue(
        new WindowsServiceObservationChangedError(
          "Scheduled Task identity changed during inspection.",
        ),
      );
    }
    await expect(inspectServicePublicationConsumers(f.params)).rejects.toBeInstanceOf(
      WindowsServiceObservationChangedError,
    );
  },
);

it("keeps an initially missing Task diagnostic when no overlapping process was observed", async () => {
  const f = await fixture();
  f.setProcesses([]);
  native.taskCommand.mockResolvedValue(null);
  const result = await inspectServicePublicationConsumers(f.params);
  expect(result.blockers).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.overlappingConsumers.size).toBe(0);
  expect(native.taskCommand).toHaveBeenCalledOnce();
});
