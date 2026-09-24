import "./update-command-service-consumers.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.ts";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import * as processRunner from "../../process/exec.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const { reads, execution, executionParams, withServiceHome, fixture } =
  await import("./update-command-service-consumers.test-support.js");

it.each(["same", "changed"] as const)(
  "classifies a %s staged artifact before shared-installation mutation",
  (identity) =>
    withServiceHome(async (home) => {
      const prefix = path.join(home, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const root = path.join(globalRoot, "openclaw");
      const writeIdentity = async (packageRoot: string, buildId: string) => {
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(path.join(packageRoot, "openclaw.mjs"), "export {};\n");
        await fs.writeFile(
          path.join(packageRoot, "dist", "build-info.json"),
          JSON.stringify({ buildId }),
        );
        await writePackageDistInventory(packageRoot);
      };
      await writeIdentity(root, "installed-build");
      const launcher = path.join(prefix, "bin", "openclaw");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.writeFile(launcher, "installed launcher\n");
      const retained = path.join(globalRoot, ".openclaw-retained", "witness");
      await fs.mkdir(path.dirname(retained));
      await fs.writeFile(retained, "retained rename contents\n");
      const f = await fixture(home, root);
      const independent = path.join(home, "independent");
      await writeIdentity(independent, "independent-build");
      const independentSource = path.join(home, "independent.service");
      await fs.writeFile(independentSource, "independent native definition\n");
      reads.inventory.mockResolvedValue({
        services: [
          {
            platform: "linux",
            scope: "user",
            label: "sibling.service",
            sourcePath: f.sourcePath,
            detail: "shared",
          },
          {
            platform: "linux",
            scope: "user",
            label: "independent.service",
            sourcePath: independentSource,
            detail: "independent",
          },
        ],
        errors: [],
      });
      reads.command.mockImplementation(async (_env, options) => {
        options.onCommandInspection?.({ kind: "present" });
        return options.systemdReadTarget?.unitName === "independent.service"
          ? {
              ...f.command,
              sourcePath: independentSource,
              programArguments: [
                process.execPath,
                path.join(independent, "openclaw.mjs"),
                "gateway",
              ],
            }
          : f.command;
      });
      reads.runtime.mockImplementation(async (_env, options) => ({
        status: "running",
        pid: options.systemdReadTarget?.unitName === "independent.service" ? 45002 : 45001,
        systemd: { scope: "user", unit: options.systemdReadTarget?.unitName, managerUid: 2001 },
      }));
      const preserved = await Promise.all(
        [root, launcher, retained, independent].map(async (file) => ({
          file,
          before: await fs.stat(file),
        })),
      );
      const installed = await fs.readFile(path.join(root, "dist", "build-info.json"));
      const { runPackageInstallUpdate } = await vi.importActual<
        typeof import("./update-command-package.js")
      >("./update-command-package.js");
      execution.runPackageUpdate.mockImplementation(runPackageInstallUpdate);
      execution.maybeStopService.mockImplementation(maybeStopManagedServiceBeforeMutableUpdate);
      execution.nativeSupport.mockResolvedValue(true);
      vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv) => {
        const stagePrefix = argv[argv.indexOf("--prefix") + 1];
        if (argv[0] !== "npm" || !argv.includes("--prefix") || !stagePrefix) {
          throw new Error(`Unexpected package command: ${argv.join(" ")}`);
        }
        expect(stagePrefix).not.toBe(prefix);
        await writeIdentity(
          path.join(stagePrefix, "lib", "node_modules", "openclaw"),
          identity === "same" ? "installed-build" : "candidate-build",
        );
        await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
        await fs.writeFile(path.join(stagePrefix, "bin", "openclaw"), "candidate launcher\n");
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      });
      const env = { ...process.env };
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const result = await withUpdateCommandExecutor(runId, async (executor) => {
        execution.prepareMutableUpdate.mockImplementation(async (_env, _timeout, admitExecutor) => {
          admitExecutor(await executor.enter(root));
        });
        return executeMutableUpdate({
          ...executionParams("package"),
          root,
          invocationCwd: home,
          tag: path.join(home, "candidate.tgz"),
          packageInstallSpec: path.join(home, "candidate.tgz"),
          packageTargetVersion: undefined,
          packageInstallTarget: createNpmTarget(globalRoot),
          packageInstallEnv: env,
          opts: { json: true, run: { runId, env } },
        });
      });
      expect(result, JSON.stringify(result?.failure)).toMatchObject({
        mutationStarted: false,
        result:
          identity === "same"
            ? { status: "skipped", reason: "already-current" }
            : { status: "error", reason: "managed-service-preflight" },
      });
      if (identity === "same") {
        expect(execution.prepareMutableUpdate).not.toHaveBeenCalled();
        expect(execution.pluginPreflight).not.toHaveBeenCalled();
        expect(execution.validateCanary).not.toHaveBeenCalled();
      } else {
        expect(result?.result.failedStep?.stderrTail).toContain(f.sourcePath);
        expect(result?.result.failedStep?.stderrTail).toContain(
          "Stop this service before retrying",
        );
      }
      expect(f.effects).toEqual([]);
      for (const action of [
        f.service.stop,
        f.service.start,
        f.service.restart,
        f.service.install,
      ]) {
        expect(action).not.toHaveBeenCalled();
      }
      const { handoffUpdateFromGateway } = await import("./update-command-handoff.js");
      expect(handoffUpdateFromGateway).not.toHaveBeenCalled();
      for (const { file, before } of preserved) {
        expect(await fs.stat(file)).toMatchObject({
          ino: before.ino,
          mtimeMs: before.mtimeMs,
        });
      }
      expect(await fs.readFile(path.join(root, "dist", "build-info.json"))).toEqual(installed);
      expect(await fs.readFile(launcher, "utf8")).toBe("installed launcher\n");
      expect(await fs.readFile(retained, "utf8")).toBe("retained rename contents\n");
    }),
);
