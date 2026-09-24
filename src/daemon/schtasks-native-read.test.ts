import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHiddenLauncherScript,
  buildTaskScript,
  readRegisteredScheduledTaskCommand,
  readScheduledTaskCommand,
  readStartupEntryCommand,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import * as probe from "./schtasks-state-probe.js";

const env = {
  USERPROFILE: "C:\\Users\\test",
  OPENCLAW_WINDOWS_TASK_NAME: "\\Ops\\Gateway",
  OPENCLAW_TASK_SCRIPT: "C:\\Services\\selected.cmd",
};
const installed = [
  "C:\\Node\\node.exe",
  "C:\\Install B\\openclaw.mjs",
  "gateway",
  "--port",
  "19789",
];
const selected = [
  "C:\\Node\\node.exe",
  "C:\\Install A\\openclaw.mjs",
  "gateway",
  "--port",
  "18789",
];
const scriptPath = "C:\\Services\\other.cmd";
const wrapperPath = "C:\\Services\\other.vbs";
let files: Map<string, Buffer>;
let readFailures: Map<string, Error>;

function task(launcherPath = scriptPath) {
  return {
    status: "found" as const,
    taskPath: env.OPENCLAW_WINDOWS_TASK_NAME,
    state: 4,
    actions: [{ type: 0, path: launcherPath, arguments: "", workingDirectory: "" }],
  };
}

beforeEach(() => {
  readFailures = new Map();
  files = new Map([
    [resolveTaskScriptPath(env), Buffer.from(buildTaskScript({ programArguments: selected }))],
    [scriptPath, Buffer.from(buildTaskScript({ programArguments: installed }))],
  ]);
  vi.spyOn(probe, "probeScheduledTaskState").mockReturnValue(task());
  vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
    const failure = typeof pathname === "string" ? readFailures.get(pathname) : undefined;
    if (failure) {
      throw failure;
    }
    const content = typeof pathname === "string" ? files.get(pathname) : undefined;
    if (!content) {
      throw Object.assign(new Error("Synthetic missing launcher"), { code: "ENOENT" });
    }
    return Buffer.from(content);
  });
});

afterEach(() => vi.restoreAllMocks());

describe("native Windows inventory command selection", () => {
  it.each(["cmd", "current", "published", "legacy"] as const)(
    "reads the registered %s target without redirecting the selected lifecycle",
    async (form) => {
      const launcher = form === "cmd" ? scriptPath : wrapperPath;
      const content =
        form === "current"
          ? buildHiddenLauncherScript({ scriptPath, taskSupervisor: true })
          : form === "published"
            ? `WScript.Quit CreateObject("WScript.Shell").Run("""${scriptPath}""", 0, True)\r\n`
            : `CreateObject("WScript.Shell").Run """${scriptPath}""", 0, False\r\n`;
      files.set(wrapperPath, Buffer.from(content));
      vi.mocked(probe.probeScheduledTaskState).mockReturnValue(task(launcher));
      expect(await readRegisteredScheduledTaskCommand(env)).toMatchObject({
        command: {
          sourcePath: scriptPath,
          programArguments: installed,
          definitionPaths: form === "cmd" ? [scriptPath] : [wrapperPath, scriptPath],
        },
        state: 4,
      });
      expect(
        await readScheduledTaskCommand(env, { requireEffective: true, requireLoaded: true }),
      ).toMatchObject({
        sourcePath: resolveTaskScriptPath(env),
        programArguments: selected,
      });
    },
  );

  it.each(["dist/index.js", "C:\\Install B\\dist\\index.js"])(
    "reads the native executable and separate working directory for %s",
    async (entrypoint) => {
      const registered = {
        ...task("C:\\Node\\node.exe"),
        actions: [
          {
            type: 0,
            path: "C:\\Node\\node.exe",
            arguments: `"${entrypoint}" gateway --port 19789`,
            workingDirectory: "C:\\Install B",
          },
        ],
      };
      vi.mocked(probe.probeScheduledTaskState)
        .mockReturnValueOnce(registered)
        .mockReturnValue({ ...registered, state: 3 });
      expect(await readRegisteredScheduledTaskCommand(env)).toEqual({
        command: {
          programArguments: ["C:\\Node\\node.exe", entrypoint, "gateway", "--port", "19789"],
          workingDirectory: "C:\\Install B",
        },
        state: 3,
      });
      expect(fs.readFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    { path: "C:\\Other Node\\node.exe" },
    { arguments: "dist/other.js gateway" },
    { workingDirectory: "C:\\Other Install" },
  ])("rejects native executable action drift: %j", async (changed) => {
    const action = {
      type: 0,
      path: "C:\\Node\\node.exe",
      arguments: "dist/index.js gateway",
      workingDirectory: "C:\\Install B",
    };
    vi.mocked(probe.probeScheduledTaskState)
      .mockReturnValueOnce({ ...task(), actions: [action] })
      .mockReturnValue({ ...task(), actions: [{ ...action, ...changed }] });
    await expect(readRegisteredScheduledTaskCommand(env)).rejects.toBeInstanceOf(
      probe.WindowsServiceObservationChangedError,
    );
  });

  it.each([
    ["node.exe", "dist/index.js gateway"],
    ["%NODE_HOME%\\node.exe", "dist/index.js gateway"],
    ["C:\\Windows\\System32\\cmd.exe", `/c "${scriptPath}"`],
    ["C:\\Windows\\System32\\wscript.exe", `"${wrapperPath}"`],
    ["C:\\Windows\\System32\\cscript.exe", `"${wrapperPath}"`],
    ["C:\\Windows\\powershell.exe", "-Command node dist/index.js gateway"],
    ["C:\\PowerShell\\pwsh.exe", "-File gateway.ps1"],
  ])(
    "does not treat an unresolved executable or script host as a direct action: %s",
    async (executable, args) => {
      vi.mocked(probe.probeScheduledTaskState).mockReturnValue({
        ...task(),
        actions: [
          { type: 0, path: executable, arguments: args, workingDirectory: "C:\\Install B" },
        ],
      });
      await expect(readRegisteredScheduledTaskCommand(env)).rejects.toThrow(
        "could not be inspected",
      );
    },
  );

  it("returns native state bound to the final registered command observation", async () => {
    vi.mocked(probe.probeScheduledTaskState)
      .mockReturnValueOnce(task())
      .mockReturnValue({ ...task(), state: 3 });
    expect(await readRegisteredScheduledTaskCommand(env)).toMatchObject({
      command: { sourcePath: scriptPath, programArguments: installed },
      state: 3,
    });
  });

  it("does not substitute Startup when the registered task is absent", async () => {
    vi.mocked(probe.probeScheduledTaskState).mockReturnValue({ status: "missing" });
    expect(await readRegisteredScheduledTaskCommand(env)).toBeNull();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it("keeps an inaccessible initial registration diagnostic", async () => {
    vi.mocked(probe.probeScheduledTaskState).mockReturnValue({
      status: "unknown",
      detail: "denied",
    });
    await expect(readRegisteredScheduledTaskCommand(env)).rejects.toBeInstanceOf(
      probe.ScheduledTaskInspectionError,
    );
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it.each(["different", "unavailable"] as const)(
    "distinguishes an initially %s task identity before reading its launcher",
    async (identity) => {
      vi.mocked(probe.probeScheduledTaskState).mockReturnValue({
        ...task(),
        taskPath: identity === "different" ? "Other Task" : undefined,
      });
      const reading = readRegisteredScheduledTaskCommand(env);
      if (identity === "different") {
        await expect(reading).rejects.toBeInstanceOf(probe.WindowsServiceObservationChangedError);
      } else {
        await expect(reading).rejects.toThrow("could not be inspected");
        await expect(reading).rejects.not.toBeInstanceOf(
          probe.WindowsServiceObservationChangedError,
        );
      }
      expect(fs.readFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    "registration",
    "registration missing",
    "different task missing actions",
    "empty actions",
    "script",
    "wrapper",
  ] as const)("distinguishes a changed %s from initial unavailability", async (changed) => {
    files.set(wrapperPath, Buffer.from(buildHiddenLauncherScript({ scriptPath })));
    vi.mocked(probe.probeScheduledTaskState).mockReturnValue(task(wrapperPath));
    await expect(
      readRegisteredScheduledTaskCommand(env, {
        onLauncherContent(content) {
          if (content.includes("Install B")) {
            if (changed === "registration") {
              vi.mocked(probe.probeScheduledTaskState).mockReturnValue(
                task("C:\\Other\\gateway.cmd"),
              );
            } else if (changed === "registration missing") {
              vi.mocked(probe.probeScheduledTaskState).mockReturnValue({ status: "missing" });
            } else if (changed === "different task missing actions") {
              vi.mocked(probe.probeScheduledTaskState).mockReturnValue({
                status: "found",
                taskPath: "Other Task",
                state: 4,
              });
            } else if (changed === "empty actions") {
              vi.mocked(probe.probeScheduledTaskState).mockReturnValue({
                ...task(wrapperPath),
                actions: [],
              });
            } else {
              files.set(changed === "script" ? scriptPath : wrapperPath, Buffer.from("changed"));
            }
          }
        },
      }),
    ).rejects.toBeInstanceOf(probe.WindowsServiceObservationChangedError);
  });

  it.each(["script", "wrapper"] as const)(
    "keeps an unavailable %s re-read separate from observed content changes",
    async (unavailable) => {
      files.set(wrapperPath, Buffer.from(buildHiddenLauncherScript({ scriptPath })));
      vi.mocked(probe.probeScheduledTaskState).mockReturnValue(task(wrapperPath));
      const failure = Object.assign(new Error("Synthetic access failure"), { code: "EACCES" });
      const reading = readRegisteredScheduledTaskCommand(env, {
        onLauncherContent(content) {
          if (content.includes("Install B")) {
            readFailures.set(unavailable === "script" ? scriptPath : wrapperPath, failure);
          }
        },
      });
      await expect(reading).rejects.toThrow("could not be inspected");
      await expect(reading).rejects.toHaveProperty("cause", failure);
      await expect(reading).rejects.not.toBeInstanceOf(probe.WindowsServiceObservationChangedError);
    },
  );

  it.each(["unknown", "timeout", "missing actions", "missing task path"] as const)(
    "does not interpret a %s re-probe as a changed registration",
    async (unavailable) => {
      const incomplete =
        unavailable === "missing actions"
          ? { status: "found" as const, taskPath: env.OPENCLAW_WINDOWS_TASK_NAME, state: 4 }
          : unavailable === "missing task path"
            ? { status: "found" as const, actions: task().actions, state: 4 }
            : {
                status: "unknown" as const,
                detail: "Synthetic native inspection unavailable",
                ...(unavailable === "timeout" ? { timeoutMs: 1500 } : {}),
              };
      vi.mocked(probe.probeScheduledTaskState)
        .mockReturnValueOnce(task())
        .mockReturnValue(incomplete);
      const reading = readRegisteredScheduledTaskCommand(env);
      await expect(reading).rejects.toThrow("could not be inspected");
      await expect(reading).rejects.not.toBeInstanceOf(probe.WindowsServiceObservationChangedError);
      if (unavailable === "unknown" || unavailable === "timeout") {
        await expect(reading).rejects.toBeInstanceOf(probe.ScheduledTaskInspectionError);
      }
      if (unavailable === "timeout") {
        await expect(reading).rejects.toHaveProperty("timeoutMs", 1500);
      }
    },
  );

  it("reads an exact Startup target independently of the same-label registered Task", async () => {
    files.set(wrapperPath, Buffer.from(buildHiddenLauncherScript({ scriptPath })));
    expect(await readStartupEntryCommand(wrapperPath)).toMatchObject({
      sourcePath: scriptPath,
      definitionPaths: [wrapperPath, scriptPath],
      programArguments: installed,
    });
    expect(probe.probeScheduledTaskState).not.toHaveBeenCalled();
  });

  it.each(["gateway --port 19789 && echo extra", "gateway --port 19789\r\necho extra"])(
    "does not infer an effective command from compound input: %s",
    async (command) => {
      files.set(
        scriptPath,
        Buffer.from(`@echo off\r\n"C:\\Install B\\openclaw.exe" ${command}\r\n`),
      );
      await expect(readRegisteredScheduledTaskCommand(env)).rejects.toThrow(
        "could not be inspected",
      );
    },
  );
});
