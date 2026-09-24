import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { ExtraGatewayService } from "./inspect.js";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
} from "./service-inspection-error.js";
import { inspectServicePublicationConsumers } from "./service-publication-consumers.js";
import * as publicationPaths from "./service-publication-footprint.js";
import type { GatewayServiceCommandConfig } from "./service-types.js";
import { GatewayServiceAuthorityError } from "./service-update-authority.js";

const reads = vi.hoisted(() => ({
  command: vi.fn(),
  runtime: vi.fn(),
  binding: vi.fn(),
  close: vi.fn(),
  launchd: vi.fn(),
  launchdCommand: vi.fn(),
}));
vi.mock("./systemd-peer.js", () => ({ admitSystemdServiceReadBinding: reads.binding }));
vi.mock("./systemd-service-files.js", () => ({ readSystemdServiceExecStart: reads.command }));
vi.mock("./systemd-runtime.js", () => ({ readSystemdServiceRuntime: reads.runtime }));
vi.mock("./launchd-runtime.js", () => ({
  probeLaunchAgentState: reads.launchd,
  readLoadedLaunchdProgramArguments: reads.launchdCommand,
  resolveLaunchAgentGuiDomain: () => "gui/501",
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const platforms = ["linux", "darwin"] as const;

async function fixture(
  platform: (typeof platforms)[number] = "linux",
  scope: "user" | "system" = "user",
) {
  mockProcessPlatform(platform);
  const home = dirs.make("unix-publication-consumers-");
  const active = path.join(home, "active"),
    candidate = path.join(home, "candidate"),
    unrelated = path.join(home, "unrelated");
  for (const root of [active, candidate, unrelated]) {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n");
  }
  const sourcePath = path.join(home, "sibling.definition");
  await fs.writeFile(sourcePath, "fixture definition");
  const service: ExtraGatewayService = {
    platform,
    scope,
    label: platform === "linux" ? "sibling.service" : "org.fixture.sibling",
    sourcePath,
    detail: "fixture",
  };
  const command = (root: string, kind = "gateway"): GatewayServiceCommandConfig => ({
    sourcePath,
    programArguments: [
      process.execPath,
      path.join(root, "openclaw.mjs"),
      kind,
      ...(kind === "node" ? ["run"] : []),
    ],
  });
  let currentCommand = command(active);
  const setCommand = (value: GatewayServiceCommandConfig) => {
    currentCommand = value;
  };
  reads.command.mockImplementation(async (_env, options) => {
    options.onCommandInspection?.({ kind: "present" });
    return currentCommand;
  });
  reads.launchdCommand.mockImplementation(async () => currentCommand);
  const setRuntime = (status: string, pid = 45001) => {
    reads.runtime.mockResolvedValue({
      status,
      ...(status === "running" ? { pid } : {}),
      systemd: { unit: service.label, scope, managerUid: scope === "system" ? 0 : 501 },
    });
    reads.launchd.mockResolvedValue({
      state: status,
      runtime: { state: status, ...(status === "running" ? { pid } : {}) },
    });
  };
  setRuntime("running");
  reads.binding.mockResolvedValue({
    unit: service.label,
    managerUid: 501,
    destination: ":1.1",
    verify: () => {},
    close: reads.close,
    query: async () => [],
  });
  const params = {
    inventory: { services: [service], errors: [] },
    targets: await Promise.all(
      [active, candidate].map((root) =>
        publicationPaths.inspectServicePublicationFootprint(root, () => {}),
      ),
    ),
    mode: "whole-package" as const,
    env: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "selected-state") },
    assertCurrent: () => {},
    timeoutMs: 30_000,
  };
  return {
    params,
    home,
    active,
    candidate,
    unrelated,
    service,
    sourcePath,
    command,
    setCommand,
    setRuntime,
  };
}

it.each(platforms)("refuses live %s consumers of either publication root", async (platform) => {
  const f = await fixture(platform);
  for (const root of [f.active, f.candidate]) {
    f.setCommand(f.command(root));
    const result = await inspectServicePublicationConsumers(f.params);
    expect(result.blockers).toEqual([
      expect.objectContaining({ message: expect.stringContaining("consumes the installation") }),
    ]);
    expect(result.warnings).toEqual([]);
  }
});

it("retains positive overlap when a later footprint inspection is unavailable", async () => {
  const f = await fixture();
  const inspect = publicationPaths.inspectServicePublicationFootprint;
  vi.spyOn(publicationPaths, "inspectServicePublicationFootprint")
    .mockImplementationOnce(inspect)
    .mockRejectedValueOnce(Object.assign(new Error("inspection denied"), { code: "EACCES" }));
  const result = await inspectServicePublicationConsumers(f.params);
  expect(result.blockers).toHaveLength(1);
  expect(result.warnings).toEqual([]);
});

it("does not renew the caller budget for a later consumer", async () => {
  const f = await fixture();
  f.setCommand(f.command(f.unrelated));
  let time = 0;
  vi.spyOn(performance, "now").mockImplementation(() => time);
  const inspected: string[] = [];
  reads.runtime.mockImplementation(async (_env, options) => {
    inspected.push(options.systemdReadTarget.unitName);
    const budget = options.timeoutMs;
    time += Math.min(60, budget);
    if (budget < 60) {
      throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
    }
    return {
      status: "stopped",
      systemd: { unit: options.systemdReadTarget.unitName, scope: "user", managerUid: 501 },
    };
  });
  const result = await inspectServicePublicationConsumers({
    ...f.params,
    timeoutMs: 100,
    inventory: { services: [f.service, { ...f.service, label: "later.service" }], errors: [] },
  });
  expect(inspected).toEqual([f.service.label, f.service.label]);
  expect(result.blockers).toEqual([]);
  expect(result.warnings).toHaveLength(2);
});

it.each(platforms)(
  "allows disjoint or affirmatively stopped %s consumers without preparing state",
  async (platform) => {
    const f = await fixture(platform);
    f.setCommand(f.command(f.unrelated));
    expect(await inspectServicePublicationConsumers(f.params)).toMatchObject({
      blockers: [],
      warnings: [],
    });
    f.setCommand(f.command(f.active));
    f.setRuntime(platform === "darwin" ? "not-loaded" : "stopped");
    expect(await inspectServicePublicationConsumers(f.params)).toMatchObject({
      blockers: [],
      warnings: [],
    });
    await expect(fs.stat(f.params.env.OPENCLAW_STATE_DIR)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.each(platforms)(
  "warns for initially unknown %s bindings without inventing overlap",
  async (platform) => {
    const f = await fixture(platform);
    f.setRuntime("unknown");
    const result = await inspectServicePublicationConsumers(f.params);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.overlappingConsumers.size).toBe(0);
  },
);

it("retains verified stopped overlap when later systemd inspection is unavailable", async () => {
  const f = await fixture();
  f.setRuntime("stopped");
  const initial = await inspectServicePublicationConsumers(f.params);
  expect(initial.blockers).toEqual([]);
  expect(initial.overlappingConsumers.size).toBe(1);
  f.setRuntime("unknown");
  const result = await inspectServicePublicationConsumers({
    ...f.params,
    knownOverlappingConsumers: initial.overlappingConsumers,
  });
  expect(result.blockers).toHaveLength(1);
  expect(result.warnings).toEqual([]);
});

it.each(["runtime", "command"])(
  "retains a current shared command when the second %s observation is unavailable",
  async (failure) => {
    const f = await fixture();
    if (failure === "runtime") {
      f.setRuntime("unknown");
      reads.runtime.mockResolvedValueOnce({
        status: "running",
        pid: 45001,
        systemd: { unit: f.service.label, scope: "user", managerUid: 501 },
      });
    } else {
      reads.command.mockImplementation(async (_env, options) => {
        options.onCommandInspection({
          kind: "unavailable",
          error: new Error("manager unavailable"),
        });
        return null;
      });
      reads.command.mockImplementationOnce(async (_env, options) => {
        options.onCommandInspection({ kind: "present" });
        return f.command(f.active);
      });
    }
    const result = await inspectServicePublicationConsumers(f.params);
    expect(result.blockers).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    expect(result.overlappingConsumers.size).toBe(1);
  },
);

it("delegates only the selected definition and remembers its verified overlap", async () => {
  const f = await fixture();
  const selected = {
    service: f.service,
    command: f.command(f.active),
  };
  const admitted = await inspectServicePublicationConsumers({ ...f.params, selected });
  expect(admitted.blockers).toEqual([]);
  expect(admitted.overlappingConsumers.size).toBe(1);
  expect(reads.runtime).not.toHaveBeenCalled();
  const otherPath = {
    ...selected,
    service: { ...selected.service, sourcePath: path.join(f.home, "other.service") },
  };
  expect(
    (await inspectServicePublicationConsumers({ ...f.params, selected: otherPath })).blockers,
  ).toHaveLength(1);
  f.setRuntime("unknown");
  expect(
    (
      await inspectServicePublicationConsumers({
        ...f.params,
        knownOverlappingConsumers: admitted.overlappingConsumers,
      })
    ).blockers,
  ).toHaveLength(1);
});

it.each(platforms)("retains %s overlap after a live launcher's symlink moves", async (platform) => {
  const f = await fixture(platform);
  const launcher = path.join(f.home, "current");
  await fs.symlink(f.active, launcher, "junction");
  const command = f.command(launcher);
  f.setCommand(command);
  const admitted = await inspectServicePublicationConsumers({
    ...f.params,
    selected: { service: f.service, command },
  });
  expect(admitted.blockers).toEqual([]);
  await fs.unlink(launcher);
  await fs.symlink(f.unrelated, launcher, "junction");
  const retained = { ...f.params, knownOverlappingConsumers: admitted.overlappingConsumers };
  expect(await inspectServicePublicationConsumers(retained)).toMatchObject({
    blockers: [
      expect.objectContaining({ message: expect.stringContaining("previously verified") }),
    ],
    warnings: [],
  });
  if (platform === "darwin") {
    f.setRuntime("stopped");
    expect((await inspectServicePublicationConsumers(retained)).blockers).toHaveLength(1);
  }
  f.setRuntime(platform === "darwin" ? "not-loaded" : "stopped");
  expect(await inspectServicePublicationConsumers(retained)).toMatchObject({
    blockers: [],
    warnings: [],
  });
  f.setRuntime("running");
  expect(await inspectServicePublicationConsumers(f.params)).toMatchObject({
    blockers: [],
    warnings: [],
  });
});

it.each(["missing provenance", "unavailable fallback"])(
  "does not infer overlap from a stopped disk command with %s",
  async (kind) => {
    const f = await fixture();
    f.setRuntime("stopped");
    reads.command.mockImplementation(async (_env, options) => {
      if (kind === "unavailable fallback") {
        options.onCommandInspection?.({
          kind: "unavailable",
          error: new Error("manager unavailable"),
        });
      }
      return f.command(f.active);
    });
    const result = await inspectServicePublicationConsumers(f.params);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.overlappingConsumers.size).toBe(0);
  },
);

it.each(platforms)(
  "checks %s Node consumers and shared physical output aliases",
  async (platform) => {
    const f = await fixture(platform);
    f.setCommand(f.command(f.active, "node"));
    expect((await inspectServicePublicationConsumers(f.params)).blockers).toHaveLength(1);
    await fs.mkdir(path.join(f.active, "dist-runtime"));
    await fs.symlink(
      path.join(f.active, "dist-runtime"),
      path.join(f.unrelated, "dist-runtime"),
      "junction",
    );
    f.setCommand(f.command(f.unrelated));
    expect((await inspectServicePublicationConsumers(f.params)).blockers).toHaveLength(1);
  },
);

it.each(["user", "system"] as const)(
  "reads the exact %s manager and current execution PID",
  async (scope) => {
    const f = await fixture("linux", scope);
    reads.binding.mockResolvedValue(undefined);
    f.setCommand(f.command(f.unrelated));
    expect((await inspectServicePublicationConsumers(f.params)).blockers).toEqual([]);
    expect(reads.command).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        expectedRunningPid: 45001,
        systemdReadTarget: { scope, unitName: f.service.label, unitPath: f.sourcePath },
      }),
    );
  },
);

it.each(["command", "PID"])(
  "propagates a changed %s even when the first command is disjoint",
  async (changed) => {
    const f = await fixture();
    f.setCommand(f.command(f.unrelated));
    if (changed === "PID") {
      reads.runtime
        .mockResolvedValueOnce({
          status: "running",
          pid: 45001,
          systemd: { unit: f.service.label, scope: "user", managerUid: 501 },
        })
        .mockResolvedValue({
          status: "running",
          pid: 45002,
          systemd: { unit: f.service.label, scope: "user", managerUid: 501 },
        });
    } else {
      reads.command.mockImplementationOnce(async (_env, options) => {
        options.onCommandInspection?.({ kind: "present" });
        return f.command(f.active);
      });
    }
    await expect(inspectServicePublicationConsumers(f.params)).rejects.toThrow("changed during");
  },
);

it.each(["caller", "manager", "cleanup", "native authority"])(
  "propagates %s custody loss rather than warning",
  async (kind) => {
    const f = await fixture();
    let current = true;
    const failure =
      kind === "manager"
        ? new ServiceOwnershipRefusalError("systemd-manager-changed")
        : kind === "native authority"
          ? new GatewayServiceAuthorityError(new Error("native owner retired"))
          : new CommandProcessCleanupError();
    reads.runtime.mockImplementation(async () => {
      current = false;
      if (kind !== "caller") {
        throw failure;
      }
      return { status: "unknown" };
    });
    await expect(
      inspectServicePublicationConsumers({
        ...f.params,
        assertCurrent: () => {
          if (!current && kind === "caller") {
            throw new Error("caller retired");
          }
        },
      }),
    ).rejects.toThrow();
    expect(reads.close).toHaveBeenCalledOnce();
  },
);

it.each(["active", "unrelated"] as const)(
  "classifies an unavailable launchd recheck of %s code using its verified relation",
  async (root) => {
    const f = await fixture("darwin");
    f.setCommand(f.command(f[root]));
    reads.launchd.mockResolvedValue({ state: "unknown", detail: "inspection timed out" });
    reads.launchd.mockResolvedValueOnce({
      state: "running",
      runtime: { state: "running", pid: 45001 },
    });
    const result = await inspectServicePublicationConsumers(f.params);
    expect(result.blockers).toHaveLength(root === "active" ? 1 : 0);
    expect(result.warnings).toHaveLength(root === "unrelated" ? 1 : 0);
  },
);

it.each(["active", "unrelated"] as const)(
  "inspects retained %s code for a loaded PID-less launchd orphan",
  async (root) => {
    const f = await fixture("darwin");
    f.setRuntime("stopped");
    f.setCommand(f.command(f[root]));
    const result = await inspectServicePublicationConsumers({
      ...f.params,
      inventory: {
        services: [{ ...f.service, sourcePath: undefined, launchdDomain: "gui/501" }],
        errors: [],
      },
    });
    expect(result.blockers).toHaveLength(root === "active" ? 1 : 0);
    expect(result.warnings).toEqual([]);
    expect(reads.launchdCommand).toHaveBeenCalled();
  },
);

it("warns for an uninspectable initial launchd orphan and never substitutes its disk plist", async () => {
  const f = await fixture("darwin");
  reads.launchdCommand.mockRejectedValue(new Error("retained command unavailable"));
  const result = await inspectServicePublicationConsumers(f.params);
  expect(result.blockers).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.overlappingConsumers.size).toBe(0);
});

it("warns for an unavailable inventory without manufacturing a shared consumer", async () => {
  const f = await fixture();
  const result = await inspectServicePublicationConsumers({
    ...f.params,
    inventory: {
      services: [],
      errors: [{ source: "systemd:user", message: "User manager unavailable" }],
    },
  });
  expect(result.blockers).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(result.overlappingConsumers.size).toBe(0);
});
