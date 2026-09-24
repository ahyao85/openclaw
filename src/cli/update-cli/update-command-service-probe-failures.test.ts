// Install the native service fixtures before loading the maintenance owner.
import "./update-command-service-maintenance.test-support.js";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import * as doctorServicePolicy from "../../commands/doctor-service-repair-policy.js";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const { mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

it.each([
  { code: "ETIMEDOUT", failures: 1, recovered: true },
  { code: "ETIMEDOUT", failures: 2, recovered: false },
  { code: "ETIMEDOUT", failures: 2, recovered: false, admitted: true },
  { code: "ENOENT", failures: 1, recovered: false },
])("handles Scheduled Task probe failures before update: %j", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    mocks.taskState = 4;
    vi.mocked(spawnSync).mockReset();
    for (let attempt = 0; attempt < scenario.failures; attempt++) {
      vi.mocked(spawnSync).mockReturnValueOnce({
        pid: 0,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: null,
        signal: null,
        error: Object.assign(new Error(`spawnSync powershell.exe ${scenario.code}`), {
          code: scenario.code,
        }),
      });
    }
    const service = createMockGatewayService({
      readCommand: vi.fn(async () => ({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      })),
      readRuntime: readScheduledTaskRuntime,
      isLoaded: async () => true,
    });
    mocks.service.mockReturnValue(service);

    const inspection = maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      phase: "inspect",
      jsonMode: true,
      timeoutMs: 30_000,
      expectedService: scenario.admitted
        ? {
            serviceUpdateVerdict: {
              kind: "owned",
              root: process.cwd(),
              fingerprint: "admitted-definition",
              refreshDefinition: true,
            },
          }
        : undefined,
    });

    if (scenario.admitted) {
      await expect(inspection).rejects.toThrow("Scheduled Task probe timed out after 30000 ms");
    } else {
      const inspected = await inspection;
      expect(inspected.blockMessage).toBeUndefined();
      if (scenario.recovered) {
        expect(inspected.serviceUpdateVerdict?.kind).toBe("owned");
        expect(inspected.running).toBe(true);
      } else {
        expect(inspected.serviceUpdateVerdict?.kind).toBe("unavailable");
        expect(inspected.serviceMutationSkipMessage).toContain(
          "Restart the Gateway you launched manually after the update.",
        );
        if (scenario.code === "ETIMEDOUT") {
          expect(inspected.serviceMutationSkipMessage).toContain(
            "Scheduled Task probe timed out after 30000 ms",
          );
          expect(inspected.serviceMutationSkipMessage).toContain("ETIMEDOUT");
        }
      }
    }
    const attempts = scenario.code === "ETIMEDOUT" ? 2 : 1;
    const taskProbes = vi
      .mocked(spawnSync)
      .mock.calls.filter(([, args]) => args?.includes("-EncodedCommand"));
    expect(taskProbes).toHaveLength(attempts);
    expect(service.readCommand).toHaveBeenCalledTimes(attempts);
    for (const call of taskProbes) {
      expect(call[2]?.timeout).toBe(30_000);
    }
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  }),
);

it("preserves a silent Scheduled Task probe failure through update and Doctor warnings", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockResolvedValue(true);
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 2,
      signal: null,
    });
    const service = createMockGatewayService({
      readCommand: async () => ({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      }),
      readRuntime: readScheduledTaskRuntime,
      isLoaded: async () => true,
    });
    mocks.service.mockReturnValue(service);
    const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      phase: "inspect",
      jsonMode: true,
    });
    expect(inspection).toMatchObject({
      stopped: false,
      serviceMutationAllowed: false,
      serviceUpdateVerdict: { kind: "unavailable" },
    });
    const detail = "Scheduled Task probe failed (exit 2): no output from PowerShell.";
    expect(inspection.blockMessage).toBeUndefined();
    expect(inspection.serviceMutationSkipMessage).toContain(detail);
    const maintenance = await beginDoctorMaintenance({
      root: process.cwd(),
      options: { repair: true },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    try {
      expect(maintenance?.warnings).toEqual([expect.stringContaining(detail)]);
      expect(maintenance?.warnings?.[0]).toContain(
        "Restart the Gateway you launched manually after the update.",
      );
      await maintenance?.finish({});
    } finally {
      await maintenance?.release();
    }
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  }));
