import "./update-command-service-maintenance.test-support.js";
import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { prepareUpdateServiceConsumers } from "./update-command-service-consumers.js";

const reads = vi.hoisted(() => ({
  inventory: vi.fn(),
  command: vi.fn(),
  runtime: vi.fn(),
  binding: vi.fn(),
}));
vi.mock("../../daemon/systemd-peer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-peer.js")>()),
  admitSystemdServiceReadBinding: reads.binding,
}));
vi.mock("../../daemon/inspect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/inspect.js")>()),
  findGatewayServices: reads.inventory,
}));
vi.mock("../../daemon/systemd-service-files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-service-files.js")>()),
  readSystemdServiceExecStart: reads.command,
}));
vi.mock("../../daemon/systemd-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-runtime.js")>()),
  readSystemdServiceRuntime: reads.runtime,
}));
vi.mock("../../infra/ports-probe.js", () => ({ probePortUsage: vi.fn(async () => "free") }));
const { mocks: native, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");
const {
  mocks: execution,
  executionParams,
  successfulUpdate,
} = await import("./update-command-execution.test-support.js");

async function fixture(home: string, root = process.cwd()) {
  // The real executor needs the host's self identity before synthetic Linux selects /proc.
  expect(getFileLockProcessStartTime(process.pid)).not.toBeNull();
  mockProcessPlatform("linux");
  const sourcePath = path.join(home, "sibling.service");
  await fs.writeFile(sourcePath, "native definition fixture");
  const command = {
    programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
    sourcePath,
    workingDirectory: home,
    environment: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "sibling-state") },
  };
  reads.inventory.mockResolvedValue({
    services: [
      { platform: "linux", scope: "user", label: "sibling.service", sourcePath, detail: "fixture" },
    ],
    errors: [],
  });
  reads.binding.mockImplementation(async (env) => ({
    unit: `${env.OPENCLAW_SYSTEMD_UNIT.replace(/\.service$/, "")}.service`,
    managerUid: 2001,
    destination: ":1.1",
    verify: () => {},
    close: async () => {},
    query: async () => [],
  }));
  reads.command.mockImplementation(async (_env, options) => {
    options.onCommandInspection?.({ kind: "present" });
    return options.systemdReadTarget?.unitName === "selected.service"
      ? service.readCommand(_env, options)
      : command;
  });
  reads.runtime.mockImplementation(async (_env, options) =>
    options.systemdReadTarget?.unitName === "selected.service"
      ? service.readRuntime(_env, options)
      : {
          status: "stopped",
          systemd: { scope: "user", unit: "sibling.service", managerUid: 2001 },
        },
  );
  const effects: string[] = [];
  let selectedRunning = true;
  const service = createMockGatewayService({
    readCommand: async () => ({
      ...command,
      sourcePath: path.join(home, "selected.service"),
      environment: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
    }),
    readRuntime: async () => ({
      status: selectedRunning ? "running" : "stopped",
      ...(selectedRunning ? { pid: 45010 } : {}),
      systemd: { scope: "user", unit: "selected.service", managerUid: 2001 },
    }),
    isLoaded: async () => true,
    stop: vi.fn(async () => {
      selectedRunning = false;
      effects.push("selected stop");
    }),
  });
  native.service.mockReturnValue(service);
  const params = {
    root,
    updateInstallKind: "package" as const,
    shouldRestart: true,
    jsonMode: true,
  };
  const prepare = (selectedState?: GatewayServiceState) =>
    prepareUpdateServiceConsumers({
      roots: [root],
      mode: "whole-package",
      env: process.env,
      selectedState,
      assertCurrent: () => {},
      timeoutMs: DEFAULT_UPDATE_STEP_TIMEOUT_MS,
      warn: vi.fn(),
    });
  return { root, sourcePath, service, command, effects, params, prepare };
}

export { reads, execution, executionParams, successfulUpdate, withServiceHome, fixture };
