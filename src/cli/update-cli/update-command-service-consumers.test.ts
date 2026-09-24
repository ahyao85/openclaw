import "./update-command-service-consumers.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ExtraGatewayService } from "../../daemon/inspect.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import * as gatewayService from "../../daemon/service.js";
import {
  CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
  UPDATE_RUN_ID_ENV,
} from "../../infra/update-control-plane-sentinel.js";
import * as foregroundHandoff from "../../infra/update-managed-service-handoff.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { prepareUpdateServiceConsumers } from "./update-command-service-consumers.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import * as verification from "./update-command-verification.js";

const hostPlatform = process.platform;
const { reads, execution, executionParams, successfulUpdate, withServiceHome, fixture } =
  await import("./update-command-service-consumers.test-support.js");

it("refuses a sibling sharing a caller-supplied output outside the default runtime paths", () =>
  withServiceHome(async (home) => {
    const servingRoot = path.join(home, "serving");
    await fs.mkdir(servingRoot);
    await fs.writeFile(
      path.join(servingRoot, "package.json"),
      JSON.stringify({ name: "openclaw" }),
    );
    await fs.writeFile(path.join(servingRoot, "openclaw.mjs"), "export {};\n");
    const f = await fixture(home, servingRoot);
    const publishingRoot = path.join(home, "publishing");
    const outputPaths = ["generated/provider-chunks"] as const;
    const target = path.join(publishingRoot, outputPaths[0]);
    const serving = path.join(servingRoot, outputPaths[0]);
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(path.dirname(serving), { recursive: true });
    await fs.symlink(target, serving, "junction");
    reads.runtime.mockResolvedValue({
      status: "running",
      pid: 45001,
      systemd: { scope: "user", unit: "sibling.service", managerUid: 2001 },
    });
    await expect(
      prepareUpdateServiceConsumers({
        roots: [publishingRoot],
        mode: "runtime-artifacts",
        outputPaths,
        env: process.env,
        assertCurrent: () => {},
        timeoutMs: DEFAULT_UPDATE_STEP_TIMEOUT_MS,
        warn: vi.fn(),
      }),
    ).rejects.toThrow("consumes the installation");
    expect(f.effects).toEqual([]);
    await expect(fs.stat(path.join(home, "sibling-state"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }));

it("refuses an active sibling at the execution entry before self-handoff or package work", () =>
  withServiceHome(async (home) => {
    const f = await fixture(home);
    reads.runtime.mockResolvedValue({
      status: "running",
      pid: 45001,
      systemd: { scope: "user", unit: "sibling.service", managerUid: 2001 },
    });
    execution.maybeStopService.mockImplementation(maybeStopManagedServiceBeforeMutableUpdate);
    const params = { ...executionParams("package"), root: f.root, invocationCwd: f.root };
    execution.runPackageUpdate.mockImplementation(async () => {
      f.effects.push("package mutation");
      return successfulUpdate;
    });
    const result = await executeMutableUpdate(params);
    expect(result?.result.status).toBe("error");
    expect(result?.result.reason).toBe("managed-service-preflight");
    expect(reads.inventory).toHaveBeenCalledOnce();
    expect(f.effects).toEqual([]);
    expect(f.service.stop).not.toHaveBeenCalled();
    const { handoffUpdateFromGateway } = await import("./update-command-handoff.js");
    expect(handoffUpdateFromGateway).not.toHaveBeenCalled();
  }));

it.each([
  "running selected",
  "stopped selected",
  "live sibling",
  "late sibling",
  "retargeted sibling",
  "separate sibling",
  "separate serving sibling",
  "shared serving sibling",
  "changed selected",
  "already current",
  "invalid candidate",
] as const)(
  "keeps system-service preparation read-only and refuses live package publication: %s",
  (scenario) =>
    withServiceHome(async (home) => {
      const root = path.join(home, "updating-install");
      await fs.mkdir(path.join(root, "dist-runtime"), { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n");
      const f = await fixture(home, root);
      const unitName = "selected-system.service";
      const sourcePath = path.join(home, unitName);
      await fs.writeFile(sourcePath, "selected system definition fixture");
      const rebind =
        scenario === "separate serving sibling" || scenario === "shared serving sibling";
      const servingRoot = rebind ? path.join(home, "serving-install") : f.root;
      if (rebind) {
        await fs.mkdir(servingRoot);
        await fs.writeFile(
          path.join(servingRoot, "package.json"),
          JSON.stringify({ name: "openclaw" }),
        );
        await fs.writeFile(path.join(servingRoot, "openclaw.mjs"), "export {};\n");
        if (scenario === "shared serving sibling") {
          await fs.symlink(
            path.join(f.root, "dist-runtime"),
            path.join(servingRoot, "dist-runtime"),
            "junction",
          );
        }
      }
      const command = {
        ...f.command,
        programArguments: [process.execPath, path.join(servingRoot, "openclaw.mjs"), "gateway"],
        sourcePath,
        environment: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
      };
      const selectedRunning = ![
        "stopped selected",
        "live sibling",
        "late sibling",
        "retargeted sibling",
        "separate sibling",
        "separate serving sibling",
        "shared serving sibling",
      ].includes(scenario);
      const runtime = {
        status: selectedRunning ? ("running" as const) : ("stopped" as const),
        ...(selectedRunning ? { pid: 45010 } : {}),
        systemd: { scope: "system" as const, unit: unitName, managerUid: 0 },
      };
      const state: GatewayServiceState = {
        installed: true,
        loadState: { status: "loaded" },
        running: selectedRunning,
        env: command.environment,
        command,
        runtime,
        systemdInstallation: {
          kind: "system",
          system: { scope: "system", unitName, unitPath: sourcePath },
        },
      };
      vi.spyOn(gatewayService, "readGatewayServiceState").mockResolvedValue(state);
      vi.spyOn(verification, "verifyPreviousManagedGatewayForUpdate").mockResolvedValue(undefined);
      execution.nativeSupport.mockResolvedValue(true);
      let currentCommand = command;
      let siblingCommand = rebind ? { ...command, sourcePath: f.sourcePath } : f.command;
      let siblingRunning = rebind || scenario === "live sibling" || scenario === "separate sibling";
      const separate = path.join(home, "separate-install");
      const siblingLauncher = path.join(home, "sibling-current");
      if (scenario === "separate sibling" || scenario === "retargeted sibling") {
        await fs.mkdir(separate);
        await fs.writeFile(
          path.join(separate, "package.json"),
          JSON.stringify({ name: "openclaw" }),
        );
        await fs.writeFile(path.join(separate, "openclaw.mjs"), "export {};\n");
        if (scenario === "retargeted sibling") {
          await fs.symlink(f.root, siblingLauncher, "junction");
        }
        siblingCommand = {
          ...siblingCommand,
          programArguments: [
            process.execPath,
            path.join(
              scenario === "retargeted sibling" ? siblingLauncher : separate,
              "openclaw.mjs",
            ),
            "gateway",
          ],
        };
      }
      const services: ExtraGatewayService[] = [
        { platform: "linux", scope: "system", label: unitName, sourcePath, detail: "selected" },
      ];
      if (scenario.includes("sibling")) {
        services.push({
          platform: "linux",
          scope: "user",
          label: "sibling.service",
          sourcePath: f.sourcePath,
          detail: "sibling",
        });
      }
      reads.inventory.mockResolvedValue({ services, errors: [] });
      reads.command.mockImplementation(async (_env, options) => {
        options.onCommandInspection?.({ kind: "present" });
        return options.systemdReadTarget.unitName === unitName ? currentCommand : siblingCommand;
      });
      reads.runtime.mockImplementation(async (_env, options) =>
        options.systemdReadTarget.unitName === unitName
          ? runtime
          : {
              status: siblingRunning ? "running" : "stopped",
              ...(siblingRunning ? { pid: 45001 } : {}),
              systemd: { scope: "user", unit: "sibling.service", managerUid: 2001 },
            },
      );
      let nativePrepared = false;
      let publicationChecked = false;
      execution.maybeStopService.mockImplementation(async (params) => {
        const result = await maybeStopManagedServiceBeforeMutableUpdate(params);
        nativePrepared ||= params.phase === "prepare";
        return result;
      });
      execution.checkTargetSchemas.mockImplementation(async () => {
        if (nativePrepared && !publicationChecked) {
          await Promise.resolve();
          publicationChecked = true;
          if (scenario === "late sibling" || scenario === "retargeted sibling") {
            siblingRunning = true;
            if (scenario === "retargeted sibling") {
              // The sibling started from the original install; its native PID and argv stay unchanged.
              await fs.unlink(siblingLauncher);
              await fs.symlink(separate, siblingLauncher, "junction");
            }
          } else if (scenario === "changed selected") {
            currentCommand = {
              ...command,
              programArguments: [...command.programArguments, "--port", "19490"],
            };
          }
        }
        return { incompatible: [], indeterminate: [] };
      });
      if (scenario === "invalid candidate") {
        execution.validateCanary.mockResolvedValue({
          status: "error",
          reason: "doctor-failed",
          phase: "doctor",
          durationMs: 1,
          steps: [
            { name: "candidate-doctor", command: "doctor --fix", durationMs: 1, exitCode: 1 },
          ],
          logTail: [],
        });
      }
      execution.runPackageUpdate.mockImplementation(
        async ({ beforeActivate, validateCandidate }) => {
          if (scenario === "already current") {
            return { ...successfulUpdate, status: "skipped", reason: "already-current" };
          }
          const steps = await validateCandidate(f.root);
          if (scenario === "invalid candidate") {
            return { ...successfulUpdate, status: "error", steps };
          }
          await beforeActivate();
          f.effects.push("package mutation");
          return successfulUpdate;
        },
      );
      const env = { ...process.env };
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const params = {
        ...executionParams("package"),
        root: f.root,
        invocationCwd: f.root,
        ...(rebind ? { managedServiceRoot: servingRoot } : {}),
        opts: { json: true, run: { runId, env } },
      };
      const result = await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "1" }, () =>
        withUpdateCommandExecutor(runId, async (executor) => {
          execution.prepareMutableUpdate.mockImplementation(
            async (_env, _timeout, admitExecutor) => {
              admitExecutor(await executor.enter(f.root));
            },
          );
          return executeMutableUpdate(params);
        }),
      );
      const allowed = ["stopped selected", "separate sibling", "separate serving sibling"].includes(
        scenario,
      );
      expect(result, JSON.stringify(result?.failure)).toMatchObject({
        mutationStarted: allowed,
        result:
          scenario === "already current"
            ? { status: "skipped", reason: "already-current" }
            : scenario === "invalid candidate"
              ? { status: "error", reason: "doctor-failed" }
              : allowed
                ? { status: "ok" }
                : { status: "error", reason: "managed-service-preflight" },
      });
      expect(f.effects).toEqual(allowed ? ["package mutation"] : []);
      expect(f.service.stop).not.toHaveBeenCalled();
      expect(f.service.start).not.toHaveBeenCalled();
      expect(f.service.restart).not.toHaveBeenCalled();
      if (scenario === "retargeted sibling") {
        expect(result?.failure?.detail).toContain("previously verified");
      }
      if (!["live sibling", "shared serving sibling", "already current"].includes(scenario)) {
        expect(execution.validateCanary).toHaveBeenCalledOnce();
      } else {
        expect(execution.validateCanary).not.toHaveBeenCalled();
      }
      if (
        ![
          "live sibling",
          "shared serving sibling",
          "already current",
          "invalid candidate",
        ].includes(scenario)
      ) {
        expect(publicationChecked).toBe(true);
      } else {
        expect(publicationChecked).toBe(false);
      }
      if (scenario === "running selected") {
        expect(result?.failure?.detail).toContain(`sudo systemctl stop ${unitName}`);
        expect(result?.failure?.detail).toContain("Rerun the original update command");
        expect(result?.failure?.detail).toContain(`sudo systemctl restart ${unitName}`);
      }
      if (allowed) {
        expect(result?.preManagedServiceStop).toMatchObject({
          stopped: false,
          running: false,
          serviceMutationAllowed: false,
          serviceMutationSkipMessage: expect.stringContaining(`sudo systemctl restart ${unitName}`),
        });
      }
    }),
);

it.each([undefined, "relative.service"])(
  "keeps an unusable selected definition diagnostic (source=%s)",
  (sourcePath) =>
    withServiceHome(async (home) => {
      const f = await fixture(home);
      reads.inventory.mockResolvedValue({ services: [], errors: [] });
      const warn = vi.fn();
      const selectedState: GatewayServiceState = {
        env: process.env,
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        command: { ...f.command, sourcePath },
        runtime: {
          status: "running",
          pid: 45001,
          systemd: { scope: "user", unit: "sibling.service", managerUid: 2001 },
        },
      };
      const prepared = await prepareUpdateServiceConsumers({
        roots: [f.root],
        mode: "whole-package",
        env: process.env,
        selectedState,
        assertCurrent: () => {},
        timeoutMs: DEFAULT_UPDATE_STEP_TIMEOUT_MS,
        warn,
      });
      await prepared.revalidate({ selectedState, warn });
      expect(reads.runtime).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(sourcePath ? 2 : 0);
      if (sourcePath) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("inspection is unavailable"));
      }
    }),
);

it.each(
  (["package", "git"] as const).flatMap((kind) =>
    [false, true].map((running) => ({ kind, running })),
  ),
)("checks siblings before foreground $kind publication (running=$running)", ({ kind, running }) =>
  withServiceHome(async (home) => {
    const f = await fixture(home);
    const env = { ...process.env };
    const runId = createUpdateRun({ trigger: "api" }, { env }).runId;
    const claim = path.join(home, "foreground-meta.json");
    await fs.writeFile(
      claim,
      JSON.stringify({ version: 1, meta: { runId, completionOwner: "gateway-restart" } }),
    );
    vi.spyOn(foregroundHandoff, "isCurrentForegroundUpdateHandoffProcess").mockResolvedValue(true);
    vi.spyOn(foregroundHandoff, "parkForegroundUpdateHandoff").mockImplementation(
      async ({ run }) => {
        f.effects.push("foreground parked");
        run.gatewayRestartRequired = true;
        return 45000;
      },
    );
    reads.runtime.mockImplementation(async () => {
      expect(f.effects).toContain("foreground parked");
      return {
        status: running ? "running" : "stopped",
        ...(running ? { pid: 45001 } : {}),
        systemd: { scope: "user", unit: "sibling.service", managerUid: 2001 },
      };
    });
    execution.maybeStopService.mockResolvedValue({
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceUpdateVerdict: { kind: "absent" },
    });
    const params = {
      ...executionParams(kind),
      root: f.root,
      invocationCwd: f.root,
      opts: { json: true, run: { runId, env, completionOwner: "gateway-restart" as const } },
    };
    execution.runPackageUpdate.mockImplementation(async ({ beforeActivate }) => {
      await beforeActivate();
      f.effects.push("publication");
      return successfulUpdate;
    });
    execution.runGitUpdate.mockImplementation(async ({ inspectGitTarget, beforeGitMutation }) => {
      const target = { schemaVersions: { state: 15, agent: 19 } };
      await inspectGitTarget(target);
      await beforeGitMutation(target);
      f.effects.push("publication");
      return { ...successfulUpdate, mode: "git" };
    });
    const result = await withEnvAsync(
      { [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: claim, [UPDATE_RUN_ID_ENV]: runId },
      () =>
        withUpdateCommandExecutor(runId, async (executor) => {
          execution.prepareMutableUpdate.mockImplementation(
            async (_env, _timeout, admitExecutor) => {
              admitExecutor(await executor.enter(f.root));
            },
          );
          return executeMutableUpdate(params);
        }),
    );
    expect(result).toMatchObject({
      mutationStarted: !running,
      result: running ? { status: "error", reason: "managed-service-preflight" } : { status: "ok" },
    });
    expect(f.effects).toEqual(
      running ? ["foreground parked"] : ["foreground parked", "publication"],
    );
    expect(f.service.stop).not.toHaveBeenCalled();
  }),
);

it.each(["restart", "command replacement", "stopped", "separate runtime"] as const)(
  "rechecks the selected service after native stop and schema awaits: %s",
  (change) =>
    withServiceHome(async (home) => {
      const f = await fixture(home);
      const sourcePath = path.join(home, "selected.service");
      await fs.writeFile(sourcePath, "selected native definition fixture");
      let command = {
        ...f.command,
        sourcePath,
        environment: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
      };
      const separate = path.join(home, "separate-runtime");
      if (change === "separate runtime") {
        await fs.mkdir(separate);
        await fs.writeFile(
          path.join(separate, "package.json"),
          JSON.stringify({ name: "openclaw" }),
        );
        await fs.writeFile(path.join(separate, "openclaw.mjs"), "export {};\n");
      }
      let running = false;
      let stopped = false;
      let schemaRechecked = false;
      const readRuntime = async () => ({
        status: running ? "running" : "stopped",
        ...(running ? { pid: 45011 } : {}),
        systemd: { scope: "user" as const, unit: "selected.service", managerUid: 2001 },
      });
      f.service.readCommand = async () => command;
      f.service.readRuntime = readRuntime;
      f.service.stop = vi.fn(async () => {
        running = false;
        stopped = true;
        f.effects.push("selected stop");
      });
      reads.inventory.mockResolvedValue({
        services: [
          {
            platform: "linux",
            scope: "user",
            label: "selected.service",
            sourcePath,
            detail: "selected fixture",
          },
        ],
        errors: [],
      });
      reads.command.mockImplementation(async (_env, options) => {
        options.onCommandInspection?.({ kind: "present" });
        return command;
      });
      reads.runtime.mockImplementation(readRuntime);
      execution.maybeStopService.mockImplementation(maybeStopManagedServiceBeforeMutableUpdate);
      execution.checkTargetSchemas.mockImplementation(async () => {
        if (stopped && !schemaRechecked) {
          await Promise.resolve();
          schemaRechecked = true;
          f.effects.push("schema check after stop");
          running = change !== "stopped";
          if (change === "command replacement") {
            command = {
              ...command,
              programArguments: [...command.programArguments, "--port", "19490"],
            };
          } else if (change === "separate runtime") {
            command = {
              ...command,
              programArguments: [process.execPath, path.join(separate, "openclaw.mjs"), "gateway"],
            };
          }
        }
        return { incompatible: [], indeterminate: [] };
      });
      execution.runPackageUpdate.mockImplementation(
        async (
          options: Parameters<
            typeof import("./update-command-package.js").runPackageInstallUpdate
          >[0],
        ) => {
          // The selected service starts during online preparation, then the real activation owner stops it.
          running = true;
          await options.beforeActivate();
          f.effects.push("package mutation");
          return successfulUpdate;
        },
      );
      const env = { ...process.env };
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const params = {
        ...executionParams("package"),
        root: f.root,
        invocationCwd: f.root,
        opts: { json: true, run: { runId, env } },
      };
      const result = await withUpdateCommandExecutor(runId, async (executor) => {
        execution.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
          admitExecutor(await executor.enter(f.root));
        });
        return executeMutableUpdate(params);
      });
      expect(schemaRechecked, JSON.stringify(result?.failure)).toBe(true);
      expect(f.service.stop).toHaveBeenCalledOnce();
      // Changing installations cannot retire this invocation's obligation to keep the service stopped.
      if (change !== "stopped") {
        expect(result).toMatchObject({
          mutationStarted: false,
          result: { status: "error", reason: "managed-service-preflight" },
        });
        expect(f.effects).toEqual(["selected stop", "schema check after stop"]);
      } else {
        expect(result?.result.status, JSON.stringify(result?.failure)).toBe("ok");
        expect(f.effects).toEqual(["selected stop", "schema check after stop", "package mutation"]);
      }
    }),
);

it.each([1, 2])("accepts %s stopped siblings before the selected native stop", (count) =>
  withServiceHome(async (home) => {
    const f = await fixture(home);
    const selected: ExtraGatewayService = {
      platform: "linux",
      scope: "user",
      label: "selected.service",
      sourcePath: path.join(home, "selected.service"),
      detail: "selected fixture",
    };
    if (count === 1) {
      reads.inventory.mockResolvedValue({
        services: [
          selected,
          {
            platform: "linux",
            scope: "user",
            label: "sibling.service",
            sourcePath: f.sourcePath,
            detail: "sibling fixture",
          },
        ],
        errors: [],
      });
    } else {
      reads.inventory.mockResolvedValue({
        services: [
          selected,
          ...["sibling", "second"].map((name) => ({
            platform: "linux",
            scope: "user",
            label: `${name}.service`,
            sourcePath: path.join(home, `${name}.service`),
            detail: "fixture",
          })),
        ],
        errors: [],
      });
      reads.command.mockImplementation(async (_env, options) => {
        options.onCommandInspection?.({ kind: "present" });
        return { ...f.command, sourcePath: options.systemdReadTarget.unitPath };
      });
      reads.runtime.mockImplementation(async (_env, options) => ({
        status: "stopped",
        systemd: { scope: "user", unit: options.systemdReadTarget.unitName, managerUid: 2001 },
      }));
    }
    await maybeStopManagedServiceBeforeMutableUpdate({
      ...f.params,
      beforeNativePreparation: async (state) => {
        await f.prepare(state);
      },
    });
    expect(f.effects).toEqual(["selected stop"]);
  }),
);

it.each(["unavailable", "prohibited", "absent"] as const)(
  "keeps sibling inspection on the selected service's %s early return",
  (selected) =>
    withServiceHome(async (home) => {
      const f = await fixture(home);
      reads.runtime.mockResolvedValue({
        status: "running",
        pid: 45002,
        systemd: { scope: "user", unit: "sibling.service", managerUid: 2001 },
      });
      if (selected === "absent") {
        f.service.readCommand = async () => null;
        f.service.readRuntime = async () => ({ status: "stopped", missingUnit: true });
        f.service.isLoaded = async () => false;
      }
      const beforeNativePreparation = async (state?: GatewayServiceState) => {
        await f.prepare(state);
      };
      const expectedService =
        selected === "unavailable"
          ? {
              serviceUpdateVerdict: {
                kind: "unavailable" as const,
                message: "unavailable selected fixture",
              },
            }
          : selected === "prohibited"
            ? { serviceEnv: { ...process.env, OPENCLAW_SUPERVISOR_MODE: "external" } }
            : undefined;
      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({
          ...f.params,
          phase: "inspect",
          expectedService,
          beforeNativePreparation,
        }),
      ).rejects.toThrow("consumes the installation");
      expect(f.effects).toEqual([]);
    }),
);

it("admits staged package-to-Git publication before the destination exists", () =>
  withServiceHome(async (home) => {
    const f = await fixture(home);
    mockProcessPlatform(hostPlatform);
    f.service.readRuntime = async () => ({
      status: "stopped",
      systemd: { managerUid: process.getuid?.() ?? 2001 },
    });
    f.service.isLoaded = async () => false;
    execution.maybeStopService.mockImplementation(maybeStopManagedServiceBeforeMutableUpdate);
    const destination = path.join(home, "new-checkout");
    await withEnvAsync({ OPENCLAW_GIT_DIR: destination }, async () => {
      const env = { ...process.env };
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const params = {
        ...executionParams("git"),
        root: f.root,
        invocationCwd: f.root,
        installKind: "package" as const,
        switchToGit: true,
        shouldRestart: false,
        opts: { json: true, run: { runId, env } },
      };
      execution.runGitUpdate.mockImplementation(
        async (git: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0]) => {
          if (!git.inspectGitTarget || !git.beforeGitMutation) {
            throw new Error("Missing Git admission callbacks");
          }
          const target = { schemaVersions: { state: 15, agent: 19 } };
          await git.inspectGitTarget(target);
          await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
          await git.beforeGitMutation(target);
          f.effects.push("publish checkout");
          await fs.mkdir(destination);
          return { ...successfulUpdate, mode: "git", root: destination };
        },
      );
      const result = await withUpdateCommandExecutor(runId, async (executor) => {
        execution.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
          admitExecutor(await executor.enter(f.root));
        });
        return executeMutableUpdate(params);
      });
      expect(result?.result.status, JSON.stringify(result?.failure)).toBe("ok");
      expect(f.effects).toEqual(["publish checkout"]);
      expect((await fs.stat(destination)).isDirectory()).toBe(true);
    });
  }));

it("refuses a dangling staged target instead of projecting through its missing link", () =>
  withServiceHome(async (home) => {
    const f = await fixture(home);
    const destination = path.join(home, "new-checkout");
    await fs.symlink(path.join(home, "missing"), destination, "junction");
    await expect(
      prepareUpdateServiceConsumers({
        roots: [f.root, destination],
        mode: "whole-package",
        env: process.env,
        assertCurrent: () => {},
        timeoutMs: DEFAULT_UPDATE_STEP_TIMEOUT_MS,
        warn: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.effects).toEqual([]);
  }));

it("rechecks a separate active runtime before publication when its native command changes", () =>
  withServiceHome(async (home) => {
    const f = await fixture(home);
    const unrelated = path.join(home, "unrelated");
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(unrelated, "package.json"), JSON.stringify({ name: "openclaw" }));
    await fs.writeFile(path.join(unrelated, "openclaw.mjs"), "export {};\n");
    reads.command.mockImplementation(async (_env, options) => {
      options.onCommandInspection?.({ kind: "present" });
      return {
        ...f.command,
        programArguments: [process.execPath, path.join(unrelated, "openclaw.mjs"), "gateway"],
      };
    });
    reads.runtime.mockResolvedValue({
      status: "running",
      pid: 45004,
      systemd: { scope: "user", unit: "sibling.service", managerUid: 2001 },
    });
    const consumers = await f.prepare();
    reads.command.mockImplementation(async (_env, options) => {
      options.onCommandInspection?.({ kind: "present" });
      return f.command;
    });
    await expect(consumers.revalidate({ warn: vi.fn() })).rejects.toThrow(
      "consumes the installation",
    );
    expect(f.effects).toEqual([]);
  }));

it.each(["unknown", "running", "stopped"] as const)(
  "rechecks an identified systemd unit omitted by later discovery: %s",
  (state) =>
    withServiceHome(async (home) => {
      const f = await fixture(home);
      const consumers = await f.prepare();
      reads.inventory.mockResolvedValue({ services: [], errors: [] });
      reads.runtime.mockResolvedValue({
        status: state,
        ...(state === "running" ? { pid: 45012 } : {}),
        systemd: { scope: "user", unit: "sibling.service", managerUid: 2001 },
      });
      if (state === "stopped") {
        await expect(consumers.revalidate({ warn: vi.fn() })).resolves.toBeUndefined();
      } else {
        await expect(consumers.revalidate({ warn: vi.fn() })).rejects.toThrow(
          state === "running" ? "consumes the installation" : "previously verified",
        );
      }
      expect(f.effects).toEqual([]);
    }),
);

it.each(["stale unavailable", "system-only", "known overlap lost"] as const)(
  "runs the execution entry with %s service evidence",
  (scenario) =>
    withServiceHome(async (home) => {
      const f = await fixture(home);
      const sourcePath = path.join(home, "selected.service");
      if (scenario === "stale unavailable") {
        const stale = {
          ...f.command,
          sourcePath,
          programArguments: [process.execPath, "/stale/openclaw/openclaw.mjs", "gateway"],
          environment: { OPENCLAW_STATE_DIR: path.join(home, "stale-state") },
        };
        f.service.readCommand = async () => stale;
        f.service.readRuntime = async () => ({
          status: "unknown",
          inspectionReason: "service-manager-unavailable",
        });
        f.service.isLoaded = async () => {
          throw new Error("service manager unavailable");
        };
        reads.inventory.mockResolvedValue({
          services: [
            {
              platform: "linux",
              scope: "user",
              label: "selected.service",
              sourcePath,
              detail: "stale record",
            },
          ],
          errors: [],
        });
        reads.runtime.mockResolvedValue({
          status: "unknown",
          systemd: { scope: "user", unit: "selected.service", managerUid: 2001 },
        });
      } else {
        f.service.readRuntime = async () => ({
          status: "stopped",
          systemd: { scope: "system", unit: "selected.service", managerUid: 0 },
        });
        if (scenario === "system-only") {
          reads.inventory.mockResolvedValue({ services: [], errors: [] });
        }
      }
      execution.maybeStopService.mockImplementation(maybeStopManagedServiceBeforeMutableUpdate);
      execution.runPackageUpdate.mockImplementation(async (options) => {
        expect(options.root).toBe(f.root);
        if (scenario === "known overlap lost") {
          reads.runtime.mockImplementation(async (env, readOptions) =>
            readOptions.systemdReadTarget?.unitName === "selected.service"
              ? f.service.readRuntime(env, readOptions)
              : {
                  status: "unknown",
                  systemd: { scope: "user", unit: "sibling.service", managerUid: 2001 },
                },
          );
        }
        await options.beforeActivate();
        f.effects.push("package mutation");
        return { ...successfulUpdate, root: f.root };
      });
      const env = { ...process.env };
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const params = {
        ...executionParams("package"),
        root: f.root,
        invocationCwd: f.root,
        opts: { json: true, run: { runId, env } },
      };
      const result = await withUpdateCommandExecutor(runId, async (executor) => {
        execution.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
          admitExecutor(await executor.enter(f.root));
        });
        return executeMutableUpdate(params);
      });
      expect(f.service.stop).not.toHaveBeenCalled();
      const { handoffUpdateFromGateway } = await import("./update-command-handoff.js");
      expect(handoffUpdateFromGateway).not.toHaveBeenCalled();
      if (scenario === "known overlap lost") {
        expect(result).toMatchObject({
          mutationStarted: false,
          result: { status: "error", reason: "managed-service-preflight" },
        });
        expect(result?.failure?.detail).toContain(f.sourcePath);
        expect(f.effects).toEqual([]);
      } else {
        expect(result?.result.status, JSON.stringify(result?.failure)).toBe("ok");
        expect(f.effects).toEqual(["package mutation"]);
        if (scenario === "stale unavailable") {
          expect(execution.runtimeError).toHaveBeenCalledWith(
            expect.stringContaining("inspection is unavailable"),
          );
          expect(result?.ownedManagedUpdateContext).toBeUndefined();
        }
      }
    }),
);
