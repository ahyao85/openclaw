import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "../infra/windows-powershell-spawn.js";
import { findGatewayServices } from "./inspect.js";
import {
  buildHiddenLauncherScript,
  buildTaskScript,
  encodeWindowsLauncherScript,
  readRegisteredScheduledTaskCommand,
} from "./schtasks-layout.js";
import { listScheduledTasks, probeScheduledTaskState } from "./schtasks-state-probe.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const SCHTASKS_COMMAND_TIMEOUT_MS = 5_000;

it.skipIf(process.platform !== "win32")(
  "reads real Windows PowerShell task presence without an unknown result",
  () => {
    const taskName = `OpenClaw probe test ${randomUUID()}`;
    // Prove native task-state semantics; the unit matrix covers the production 5s budget.
    const missing = probeScheduledTaskState(taskName, WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS);
    console.log("Unregistered task probe:", missing);
    expect(missing).toEqual({ status: "missing" });

    const created = spawnSync(
      "schtasks.exe",
      ["/Create", "/TN", taskName, "/SC", "ONSTART", "/TR", "cmd.exe /c exit 0"],
      { encoding: "utf8", windowsHide: true, timeout: SCHTASKS_COMMAND_TIMEOUT_MS },
    );
    expect(created.error).toBeUndefined();
    if (created.status !== 0) {
      console.log("Task registration unavailable; verified the missing-task contract.");
      return;
    }
    try {
      const found = probeScheduledTaskState(taskName, WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS);
      console.log("Registered task probe:", found);
      expect(found).toMatchObject({ status: "found", state: 3, enabled: true });
    } finally {
      const removed = spawnSync("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: SCHTASKS_COMMAND_TIMEOUT_MS,
      });
      expect(removed.error).toBeUndefined();
      expect(removed.status, removed.stderr || removed.stdout).toBe(0);
    }
  },
  2 * WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS + 2 * SCHTASKS_COMMAND_TIMEOUT_MS + 10_000,
);

it
  .skipIf(process.platform !== "win32")
  .each([
    ...["cmd", "BaT"].flatMap((extension) =>
      ["direct", "current", "published"].map((launcherKind) => ({ extension, launcherKind })),
    ),
    { extension: "exe", launcherKind: "native" },
  ])(
  "reads the $launcherKind .$extension disabled nested task action without changing native policy",
  async ({ extension, launcherKind }) => {
    const nativeExecutable = launcherKind === "native";
    const directory = tempDirs.make("openclaw-task-action-");
    const folderName = `OpenClaw inspection ${randomUUID()}`;
    const taskName = `\\${folderName}\\Backup`;
    const scriptPath = path.join(directory, `gateway.${extension}`);
    const launcherPath = nativeExecutable
      ? process.execPath
      : launcherKind === "direct"
        ? scriptPath
        : path.join(directory, "gateway.vbs");
    const programArguments = [
      process.execPath,
      nativeExecutable ? "dist/index.js" : path.join(directory, "openclaw.mjs"),
      "gateway",
    ];
    const actionArguments = nativeExecutable ? "dist/index.js gateway" : "inspection-argument";
    const environment = {
      OPENCLAW_PROFILE: "default",
      OPENCLAW_WINDOWS_TASK_NAME: taskName,
      OPENCLAW_STATE_DIR: directory,
      OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
    };
    if (!nativeExecutable) {
      await fs.writeFile(
        scriptPath,
        encodeWindowsLauncherScript({
          format: "cmd",
          content: buildTaskScript({ programArguments, environment }),
        }),
      );
    }
    if (!nativeExecutable && launcherKind !== "direct") {
      await fs.writeFile(
        launcherPath,
        encodeWindowsLauncherScript({
          format: "vbs",
          content:
            launcherKind === "current"
              ? buildHiddenLauncherScript({ scriptPath })
              : `WScript.Quit CreateObject("WScript.Shell").Run("""${scriptPath}""", 0, True)\r\n`,
        }),
      );
    }
    const encoded = Buffer.from(
      JSON.stringify({ folderName, launcherPath, directory, actionArguments }),
      "utf8",
    ).toString("base64");
    const run = (operation: string) => {
      const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; $service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); ${operation}`;
      const result = spawnSync(
        getWindowsPowerShellExePath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { encoding: "utf8", windowsHide: false, timeout: 15_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      return result.stdout;
    };
    const readNativePolicy = () =>
      JSON.parse(
        run(
          "$task=$service.GetFolder($p.folderName).GetTask('Backup'); $definition=$task.Definition; @{xml=[string]$definition.XmlText;userId=[string]$definition.Principal.UserId;groupId=[string]$definition.Principal.GroupId;logonType=[int]$definition.Principal.LogonType;runLevel=[int]$definition.Principal.RunLevel;enabled=[bool]$task.Enabled;triggers=@(foreach($trigger in $definition.Triggers){@{type=[int]$trigger.Type;startBoundary=[string]$trigger.StartBoundary;enabled=[bool]$trigger.Enabled}});securityDescriptor=$task.GetSecurityDescriptor(7)} | ConvertTo-Json -Depth 4 -Compress",
        ),
      );
    try {
      run(
        "$folder=$service.GetFolder('\\').CreateFolder($p.folderName); $definition=$service.NewTask(0); $definition.RegistrationInfo.Description='Gateway 任务'; $definition.Settings.Enabled=$false; $definition.Settings.DisallowStartIfOnBatteries=$true; $definition.Settings.StopIfGoingOnBatteries=$true; $trigger=$definition.Triggers.Create(1); $trigger.StartBoundary='2099-09-15T10:00:00'; $action=$definition.Actions.Create(0); $action.Path=$p.launcherPath; $action.Arguments=$p.actionArguments; $action.WorkingDirectory=$p.directory; $null=$folder.RegisterTaskDefinition('Backup',$definition,6,$null,$null,3)",
      );
      const action = {
        type: 0,
        path: launcherPath,
        arguments: actionArguments,
        workingDirectory: directory,
      };
      expect(probeScheduledTaskState(taskName)).toMatchObject({
        status: "found",
        taskPath: taskName,
        state: 1,
        enabled: false,
        actions: [action],
      });
      expect(listScheduledTasks().find((task) => task.taskPath === taskName)).toMatchObject({
        actions: [action],
      });
      if (!nativeExecutable) {
        await expect(
          readRegisteredScheduledTaskCommand({ ...process.env, ...environment }),
        ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
        run(
          "$folder=$service.GetFolder($p.folderName); $definition=$folder.GetTask('Backup').Definition; $definition.Actions.Item(1).Arguments=''; $null=$folder.RegisterTaskDefinition('Backup',$definition,6,$null,$null,3)",
        );
        action.arguments = "";
      }
      const nativeBefore = readNativePolicy();
      expect(probeScheduledTaskState(taskName)).toMatchObject({
        state: 1,
        enabled: false,
        actions: [action],
      });
      const observed = await readRegisteredScheduledTaskCommand({ ...process.env, ...environment });
      expect(observed).toMatchObject({
        command: {
          programArguments,
          workingDirectory: directory,
        },
        state: 1,
      });
      if (nativeExecutable) {
        expect(observed?.command).toEqual({ programArguments, workingDirectory: directory });
      } else {
        expect(observed?.command).toMatchObject({ sourcePath: scriptPath, environment });
        const inventory = await findGatewayServices({ ...process.env, ...environment });
        expect(inventory.errors).toEqual([]);
        expect(inventory.services).toContainEqual(
          expect.objectContaining({ label: taskName, marker: "openclaw" }),
        );
      }
      expect(readNativePolicy()).toEqual(nativeBefore);
    } finally {
      run(
        "$folder=$service.GetFolder($p.folderName); if($folder.GetTasks(1).Count -gt 0){$folder.DeleteTask('Backup',0)}; $service.GetFolder('\\').DeleteFolder($p.folderName,0)",
      );
    }
    expect(probeScheduledTaskState(taskName)).toEqual({ status: "missing" });
  },
  60_000,
);
