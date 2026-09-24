import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isValidProfileName, normalizeProfileName } from "../cli/profile-utils.js";
import { hasErrnoCode } from "../infra/errno.js";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import {
  decodeWindowsLauncherScript,
  encodeWindowsLauncherScript,
} from "../infra/windows-launcher-encoding.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import {
  isWindowsBatchScriptPath,
  parseCmdScriptCommandLine,
  quoteCmdScriptArg,
  stripTrailingCmdRedirections,
} from "./cmd-argv.js";
import { assertNoCmdLineBreak, parseCmdSetAssignment, renderCmdSetAssignment } from "./cmd-set.js";
import { normalizeWindowsTaskIdentity, resolveGatewayWindowsTaskName } from "./constants.js";
import { resolveGatewayTaskScriptPath as resolveTaskScriptPath } from "./paths.js";
import {
  probeScheduledTaskExists,
  probeScheduledTaskState,
  ScheduledTaskInspectionError,
  WindowsServiceObservationChangedError,
} from "./schtasks-state-probe.js";
import { publishServiceFile } from "./service-stage.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceReadOptions,
  GatewayServiceRenderArgs,
} from "./service-types.js";
import {
  WINDOWS_TASK_LAUNCHER_ACTIVE,
  WINDOWS_TASK_LAUNCHER_ENV,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "./windows-task-supervisor-contract.js";

export function resolveTaskName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

// Keeps the service gateway's stdin off the (possibly hidden) console so TTY
// heuristics fail closed for permission prompts (#112173).
const STDIN_NUL_REDIRECT = "< NUL";

export function shouldFallbackToStartupEntry(params: { code: number; detail: string }): boolean {
  // Permission failures and hung schtasks calls can use the per-user Startup fallback.
  return (
    params.code === 1 ||
    /(?:access is denied|acceso denegado)/i.test(params.detail) ||
    params.code === 124 ||
    /schtasks timed out/i.test(params.detail) ||
    /schtasks produced no output/i.test(params.detail)
  );
}

function resolveWindowsStartupDir(env: GatewayServiceEnv): string {
  const appData = env.APPDATA?.trim();
  if (appData) {
    return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  }
  const home = env.USERPROFILE?.trim() || env.HOME?.trim();
  if (!home) {
    throw new Error("Windows startup folder unavailable: APPDATA/USERPROFILE not set");
  }
  return path.join(
    home,
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
}

function sanitizeWindowsFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, "_").replace(/\p{Cc}/gu, "_");
}

export function resolveStartupEntryPath(env: GatewayServiceEnv, extension?: "cmd" | "vbs"): string {
  const taskName = resolveTaskName(env);
  const entryExtension = extension ?? (shouldUseHiddenWindowsTaskLauncher(env) ? "vbs" : "cmd");
  return path.join(
    resolveWindowsStartupDir(env),
    `${sanitizeWindowsFilename(taskName)}.${entryExtension}`,
  );
}

export function resolveStartupEntryPaths(env: GatewayServiceEnv): string[] {
  const primaryPath = resolveStartupEntryPath(env);
  const legacyCmdPath = resolveStartupEntryPath(env, "cmd");
  const hiddenLauncherPath = resolveStartupEntryPath(env, "vbs");
  // Lifecycle operations must find both launcher variants even without the persisted marker.
  return uniqueStrings([primaryPath, legacyCmdPath, hiddenLauncherPath]);
}

// schtasks `/TR` and cmd.exe parse different surfaces, so keep their quoting separate.
export function quoteSchtasksArg(value: string): string {
  if (!/[ \t"]/g.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

// Escape XML structure; launcher inputs already reject CR/LF in `assertNoCmdLineBreak`.
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// XML is required to disable both battery-stop defaults (#59299); the remaining
// fields mirror the former ONLOGON, least-privilege, single-instance CLI task.
export function buildScheduledTaskXml(params: {
  taskDescription: string;
  taskUser: string | null;
  launchPath: string;
}): string {
  const description = escapeXmlText(params.taskDescription);
  const command = escapeXmlText(params.launchPath);
  const principalLogon = params.taskUser
    ? `\n      <UserId>${escapeXmlText(params.taskUser)}</UserId>\n      <LogonType>InteractiveToken</LogonType>`
    : "\n      <GroupId>S-1-5-32-545</GroupId>";
  const triggerUser = params.taskUser
    ? `\n      <UserId>${escapeXmlText(params.taskUser)}</UserId>`
    : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${description}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${triggerUser}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${principalLogon}
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
    </Exec>
  </Actions>
</Task>`;
}

export async function writeTaskXmlTempFile(xml: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-task-xml-"));
  const xmlPath = path.join(tmpDir, "task.xml");
  // Task Scheduler `/XML` expects UTF-16 LE with a BOM on every locale.
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(xml, "utf16le");
  await publishServiceFile({
    filePath: xmlPath,
    contents: Buffer.concat([bom, body]),
    mode: 0o600,
  });
  return xmlPath;
}

export function resolveTaskUser(env: GatewayServiceEnv): string | null {
  const username = env.USERNAME || env.USER || env.LOGNAME;
  if (!username) {
    return null;
  }
  if (username.includes("\\")) {
    return username;
  }
  const domain = env.USERDOMAIN;
  if (normalizeLowercaseStringOrEmpty(domain) === "workgroup") {
    return username;
  }
  if (domain) {
    return `${domain}\\${username}`;
  }
  return username;
}

export function shouldUseHiddenWindowsTaskLauncher(env: GatewayServiceEnv): boolean {
  const value = normalizeLowercaseStringOrEmpty(env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER);
  return value === "1" || value === "true" || value === "yes";
}

export function resolveTaskLauncherScriptPath(env: GatewayServiceEnv, scriptPath: string): string {
  if (!shouldUseHiddenWindowsTaskLauncher(env)) {
    return scriptPath;
  }
  const parsed = path.parse(scriptPath);
  return path.join(parsed.dir, `${parsed.name}.vbs`);
}

function assertStaticTaskPath(value: string): void {
  if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(value) || /[%\r\n"]/.test(value)) {
    throw new Error("Scheduled Task launcher path is not absolute and literal");
  }
}

async function readTaskLauncher(
  launcherPath: string,
  onLauncherContent?: (content: string) => void,
  startup = false,
): Promise<{ scriptPath: string; content?: string }> {
  assertStaticTaskPath(launcherPath);
  const cmd = isWindowsBatchScriptPath(launcherPath);
  if (cmd && !startup) {
    return { scriptPath: launcherPath };
  }
  if (!cmd && !/\.vbs$/i.test(launcherPath)) {
    throw new Error("Unsupported Scheduled Task action");
  }
  const content = decodeWindowsLauncherScript({ buffer: await fs.readFile(launcherPath) });
  onLauncherContent?.(content);
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !(cmd ? /^rem /i.test(line) : line.startsWith("'")));
  if (cmd && lines[0]?.toLowerCase() === "@echo off") {
    lines.shift();
  }
  const body = lines.join("\n");
  if (cmd) {
    const args = parseCmdScriptCommandLine(/^start "" \/min (.+)$/i.exec(body)?.[1] ?? "");
    const scriptPath = args[3];
    if (
      args.length !== 4 ||
      ![getWindowsCmdExePath().toLowerCase(), "cmd.exe"].includes(args[0]?.toLowerCase() ?? "") ||
      args[1]?.toLowerCase() !== "/d" ||
      args[2]?.toLowerCase() !== "/c" ||
      !scriptPath ||
      !isWindowsBatchScriptPath(scriptPath) ||
      stripTrailingCmdRedirections(body) !== body
    ) {
      throw new Error("Unrecognized Startup launcher");
    }
    assertStaticTaskPath(scriptPath);
    return { scriptPath, content };
  }
  const current =
    /^Set shell = CreateObject\("WScript\.Shell"\)\n(?:shell\.Environment\("Process"\)\("OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER"\) = "wscript"\n)?WScript\.Quit shell\.Run\("((?:""|[^"])*)", 0, True\)$/i.exec(
      body,
    );
  // v2026.9.2 and v2026.9.3 generated a direct synchronous wrapper.
  const synchronous =
    /^WScript\.Quit CreateObject\("WScript\.Shell"\)\.Run\("((?:""|[^"])*)", 0, True\)$/i.exec(
      body,
    );
  const legacy = /^CreateObject\("WScript\.Shell"\)\.Run "((?:""|[^"])*)", 0, False$/i.exec(body);
  const quotedPath = (current ?? synchronous ?? legacy)?.[1]?.replaceAll('""', '"');
  const scriptPath = /^"([^"]+)"$/.exec(quotedPath ?? "")?.[1];
  if (!scriptPath || !isWindowsBatchScriptPath(scriptPath)) {
    throw new Error("Unrecognized Scheduled Task launcher");
  }
  assertStaticTaskPath(scriptPath);
  return { scriptPath, content };
}

// A literal script reference supplies diagnostic evidence, never command authority.
export function resolveTaskLauncherPathHint(action: {
  path: string;
  arguments: string;
}): string | undefined {
  if (isWindowsBatchScriptPath(action.path) || /\.vbs$/i.test(action.path)) {
    return action.path;
  }
  const host = path.win32
    .basename(action.path)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (host !== "cmd" && host !== "wscript" && host !== "cscript") {
    return undefined;
  }
  const args = splitArgsPreservingQuotes(action.arguments, { escapeMode: "backslash-quote-only" });
  if (host === "cmd") {
    const commandIndex = args.findIndex((arg) => arg.toLowerCase() === "/c");
    const script = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
    return script && isWindowsBatchScriptPath(script) ? script : undefined;
  }
  const script = args.find((arg) => !arg.startsWith("/"));
  return script && /\.vbs$/i.test(script) ? script : undefined;
}

/** The selected lifecycle retains its canonical script selector. */
export async function readScheduledTaskCommand(
  env: GatewayServiceEnv,
  options?: GatewayServiceReadOptions,
): Promise<GatewayServiceCommandConfig | null> {
  const scriptPath = resolveTaskScriptPath(env);
  try {
    const content = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
    return parseTaskScript(content, { scriptPath, requireEffective: options?.requireEffective });
  } catch (error) {
    if (!options?.requireEffective) {
      return null;
    }
    if (
      hasErrnoCode(error, "ENOENT") &&
      (await isScheduledTaskDefinitionAbsent(env, options.timeoutMs).catch(() => false))
    ) {
      return null;
    }
  }
  throw new Error("Effective Scheduled Task service command could not be inspected.");
}

/** Returns the registered action and its native state after the final binding check. */
export async function readRegisteredScheduledTaskCommand(
  env: GatewayServiceEnv,
  options?: { timeoutMs?: number; onLauncherContent?: (content: string) => void },
): Promise<{ command: GatewayServiceCommandConfig; state: number | null } | null> {
  return readNativeWindowsCommand({ kind: "task", env }, options);
}

export async function readStartupEntryCommand(
  startupEntryPath: string,
  options?: { timeoutMs?: number; onLauncherContent?: (content: string) => void },
): Promise<GatewayServiceCommandConfig> {
  const observed = await readNativeWindowsCommand(
    { kind: "startup", path: startupEntryPath },
    options,
  );
  if (!observed) {
    throw new Error("Startup service command could not be inspected.");
  }
  return observed.command;
}

async function readNativeWindowsCommand(
  target: { kind: "task"; env: GatewayServiceEnv } | { kind: "startup"; path: string },
  options?: { timeoutMs?: number; onLauncherContent?: (content: string) => void },
): Promise<{ command: GatewayServiceCommandConfig; state: number | null } | null> {
  const taskName = target.kind === "task" ? resolveTaskName(target.env) : undefined;
  const deadline =
    options?.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs;
  const remaining = () => {
    const timeoutMs = deadline === undefined ? undefined : deadline - performance.now();
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      throw new Error("Windows service command inspection timed out.");
    }
    return timeoutMs;
  };
  try {
    const registered =
      taskName === undefined ? undefined : probeScheduledTaskState(taskName, remaining());
    if (registered?.status === "unknown") {
      throw new ScheduledTaskInspectionError(registered);
    }
    if (registered?.status === "missing") {
      return null;
    }
    if (
      registered?.status === "found" &&
      registered.taskPath &&
      normalizeWindowsTaskIdentity(registered.taskPath) !==
        normalizeWindowsTaskIdentity(taskName ?? "")
    ) {
      throw new WindowsServiceObservationChangedError(
        "Scheduled Task identity does not match the requested service; retry.",
      );
    }
    const action = registered?.status === "found" ? registered.actions?.[0] : undefined;
    const nativeExecutable =
      action &&
      /\.exe$/i.test(action.path) &&
      !["cmd.exe", "wscript.exe", "cscript.exe", "powershell.exe", "pwsh.exe"].includes(
        path.win32.basename(action.path).toLowerCase(),
      );
    const actionPath = action?.arguments.trim()
      ? resolveTaskLauncherPathHint(action)
      : action?.path;
    if (
      registered?.status === "found" &&
      (!registered.taskPath ||
        registered.actions?.length !== 1 ||
        action?.type !== 0 ||
        (!nativeExecutable &&
          action.arguments.trim() &&
          (!options?.onLauncherContent || !actionPath)))
    ) {
      throw new Error("Scheduled Task action cannot be inspected");
    }
    if (action?.workingDirectory) {
      assertStaticTaskPath(action.workingDirectory);
    }
    let command: GatewayServiceCommandConfig;
    if (nativeExecutable) {
      assertStaticTaskPath(action.path);
      command = {
        programArguments: [
          action.path,
          ...splitArgsPreservingQuotes(action.arguments, { escapeMode: "backslash-quote-only" }),
        ],
        ...(action.workingDirectory ? { workingDirectory: action.workingDirectory } : {}),
      };
    } else {
      const launcherPath = target.kind === "startup" ? target.path : actionPath;
      if (!launcherPath) {
        throw new Error("Scheduled Task launcher is unavailable");
      }
      remaining();
      const launcher = await readTaskLauncher(
        launcherPath,
        options?.onLauncherContent,
        target.kind === "startup",
      );
      const content = decodeWindowsLauncherScript({
        buffer: await fs.readFile(launcher.scriptPath),
      });
      options?.onLauncherContent?.(content);
      if (action?.arguments.trim()) {
        throw new Error("Scheduled Task action cannot be inspected");
      }
      command = {
        ...parseTaskScript(content, {
          scriptPath: launcher.scriptPath,
          workingDirectory: action?.workingDirectory,
          requireEffective: true,
          native: true,
        }),
        definitionPaths:
          launcherPath === launcher.scriptPath
            ? [launcherPath]
            : [launcherPath, launcher.scriptPath],
      };
      const environment = command.environment;
      if (
        (taskName &&
          environment?.OPENCLAW_WINDOWS_TASK_NAME &&
          normalizeWindowsTaskIdentity(environment.OPENCLAW_WINDOWS_TASK_NAME) !==
            normalizeWindowsTaskIdentity(taskName)) ||
        (environment?.OPENCLAW_PROFILE && !isValidProfileName(environment.OPENCLAW_PROFILE)) ||
        (target.kind === "task" &&
          target.env.OPENCLAW_PROFILE &&
          (normalizeProfileName(environment?.OPENCLAW_PROFILE) ?? "default") !==
            (normalizeProfileName(target.env.OPENCLAW_PROFILE) ?? "default")) ||
        (environment?.OPENCLAW_TASK_SCRIPT &&
          path.win32.normalize(environment.OPENCLAW_TASK_SCRIPT).toLowerCase() !==
            path.win32.normalize(launcher.scriptPath).toLowerCase())
      ) {
        throw new Error("Scheduled Task selector does not match its registration");
      }
      remaining();
      if (
        (launcher.content !== undefined &&
          decodeWindowsLauncherScript({ buffer: await fs.readFile(launcherPath) }) !==
            launcher.content) ||
        decodeWindowsLauncherScript({ buffer: await fs.readFile(launcher.scriptPath) }) !== content
      ) {
        throw new WindowsServiceObservationChangedError(
          "Windows service launcher changed during inspection; retry.",
        );
      }
    }
    remaining();
    let state: number | null = null;
    if (taskName !== undefined && registered?.status === "found") {
      const current = probeScheduledTaskState(taskName, remaining());
      if (current.status === "unknown") {
        throw new ScheduledTaskInspectionError(current);
      }
      if (
        current.status === "missing" ||
        (current.taskPath &&
          normalizeWindowsTaskIdentity(current.taskPath) !==
            normalizeWindowsTaskIdentity(registered.taskPath ?? "")) ||
        (current.actions !== undefined && !isDeepStrictEqual(current.actions, registered.actions))
      ) {
        throw new WindowsServiceObservationChangedError(
          "Scheduled Task registration changed during inspection; retry.",
        );
      }
      if (!current.taskPath || current.actions === undefined) {
        throw new Error("Scheduled Task registration could not be inspected.");
      }
      state = current.state;
    }
    return { command, state };
  } catch (error) {
    if (
      error instanceof ScheduledTaskInspectionError ||
      error instanceof WindowsServiceObservationChangedError
    ) {
      throw error;
    }
    throw new Error(
      target.kind === "startup"
        ? "Startup service command could not be inspected."
        : "Effective Scheduled Task service command could not be inspected.",
      { cause: error },
    );
  }
}

function parseTaskScript(
  content: string,
  options: {
    scriptPath: string;
    workingDirectory?: string;
    requireEffective?: boolean;
    native?: boolean;
  },
): GatewayServiceCommandConfig {
  let workingDirectory = options.workingDirectory ?? "";
  let commandLine = "";
  const environment: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const lower = normalizeLowercaseStringOrEmpty(line);
    if (
      (options.native ? lower === "@echo off" : line.startsWith("@echo")) ||
      lower.startsWith("rem ")
    ) {
      continue;
    }
    if (commandLine) {
      throw new Error("Multiple Scheduled Task launcher commands");
    }
    if (lower.startsWith("set ")) {
      const assignment = parseCmdSetAssignment(
        rawLine.trimStart().slice(4),
        options.requireEffective,
      );
      if (!assignment && options.requireEffective) {
        throw new Error("Invalid Scheduled Task environment assignment");
      }
      if (assignment) {
        environment[assignment.key] = assignment.value;
      }
      continue;
    }
    if (lower.startsWith("cd /d ")) {
      if (options.native) {
        const args = parseCmdScriptCommandLine(line);
        if (stripTrailingCmdRedirections(line) !== line || args.length !== 3) {
          throw new Error("Ambiguous Scheduled Task working directory");
        }
        workingDirectory = args[2] ?? "";
      } else {
        workingDirectory = line.slice("cd /d ".length).trim().replace(/^"|"$/g, "");
      }
      continue;
    }
    const parsedCommand = stripTrailingCmdRedirections(line);
    if (parsedCommand === null && options.native) {
      throw new Error("Ambiguous Scheduled Task launcher command");
    }
    commandLine = parsedCommand ?? line;
    if (!options.native) {
      break;
    }
  }
  if (!commandLine) {
    throw new Error("Missing Scheduled Task command");
  }
  const programArguments = parseCmdScriptCommandLine(commandLine).filter(
    (argument) => argument !== WINDOWS_TASK_SUPERVISOR_FLAG,
  );
  if (options.requireEffective && programArguments.length === 0) {
    throw new Error("Missing Scheduled Task command");
  }
  return {
    programArguments,
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(Object.keys(environment).length > 0
      ? {
          environment,
          environmentValueSources: Object.fromEntries(
            Object.keys(environment).map((key) => [key, "inline"]),
          ),
        }
      : {}),
    sourcePath: options.scriptPath,
  };
}

async function isScheduledTaskDefinitionAbsent(
  env: GatewayServiceEnv,
  timeoutMs?: number,
): Promise<boolean> {
  // A missing script can still belong to a registered task or Startup login item.
  if (probeScheduledTaskExists(resolveTaskName(env), timeoutMs) !== false) {
    return false;
  }
  for (const pathname of [resolveTaskScriptPath(env), ...resolveStartupEntryPaths(env)]) {
    try {
      await fs.lstat(pathname);
      return false;
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        return false;
      }
    }
  }
  return true;
}

export function buildTaskScript({
  description,
  programArguments,
  workingDirectory,
  environment,
}: GatewayServiceRenderArgs): string {
  const lines: string[] = ["@echo off"];
  const trimmedDescription = description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, "Task description");
    lines.push(`rem ${trimmedDescription}`);
  }
  if (workingDirectory) {
    lines.push(`cd /d ${quoteCmdScriptArg(workingDirectory)}`);
  }
  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      // `set "NODE_OPTIONS="` clears inherited flags before the Node command runs.
      if (
        value === undefined ||
        (!value && key.toUpperCase() !== "NODE_OPTIONS") ||
        key.toUpperCase() === "PATH" ||
        // This preference chooses the launcher at install time. Persisting it
        // would overwrite the live WScript marker inherited by the supervisor.
        key.toUpperCase() === WINDOWS_TASK_LAUNCHER_ENV
      ) {
        continue;
      }
      lines.push(renderCmdSetAssignment(key, value));
    }
  }
  // Redirect stdin from NUL: a Scheduled Task console (even hidden via the
  // VBS launcher) still hands the gateway real console handles, so
  // `process.stdin.isTTY` reports true and interactive permission prompts
  // block forever on a console no one can see (#112173). With stdin at NUL
  // the gateway and its workers correctly take non-interactive paths.
  const commandArguments =
    environment?.OPENCLAW_SERVICE_KIND === "gateway"
      ? [...programArguments, WINDOWS_TASK_SUPERVISOR_FLAG]
      : programArguments;
  lines.push(
    `${commandArguments.map((argument) => quoteCmdScriptArg(argument)).join(" ")} ${STDIN_NUL_REDIRECT}`,
  );
  return `${lines.join("\r\n")}\r\n`;
}

function renderStartupLaunchCommand(scriptPath: string): string {
  const cmdExePath = quoteCmdScriptArg(getWindowsCmdExePath());
  return `start "" /min ${cmdExePath} /d /c ${quoteCmdScriptArg(scriptPath)}`;
}

export function buildStartupLauncherScript(params: {
  description?: string;
  scriptPath: string;
}): string {
  const lines = ["@echo off"];
  const trimmedDescription = params.description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, "Startup launcher description");
    lines.push(`rem ${trimmedDescription}`);
  }
  lines.push(renderStartupLaunchCommand(params.scriptPath));
  return `${lines.join("\r\n")}\r\n`;
}

function quoteVbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildHiddenLauncherScript(params: {
  description?: string;
  scriptPath: string;
  taskSupervisor?: boolean;
}): string {
  const lines = [];
  const trimmedDescription = params.description?.trim();
  if (trimmedDescription) {
    assertNoCmdLineBreak(trimmedDescription, "Hidden launcher description");
    lines.push(`' ${trimmedDescription}`);
  }
  lines.push('Set shell = CreateObject("WScript.Shell")');
  if (params.taskSupervisor) {
    lines.push(
      `shell.Environment("Process")("${WINDOWS_TASK_LAUNCHER_ENV}") = "${WINDOWS_TASK_LAUNCHER_ACTIVE}"`,
    );
  }
  lines.push(`WScript.Quit shell.Run(${quoteVbsString(`"${params.scriptPath}"`)}, 0, True)`);
  return `${lines.join("\r\n")}\r\n`;
}

export { encodeWindowsLauncherScript, resolveTaskScriptPath };
