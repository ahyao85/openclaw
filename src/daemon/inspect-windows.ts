/** Windows task and Startup discovery; the caller owns inventory ordering and deduplication. */
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { findExistingAncestor } from "../infra/fs-safe.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { isWindowsBatchScriptPath } from "./cmd-argv.js";
import {
  normalizeWindowsTaskIdentity,
  resolveGatewayWindowsTaskName,
  resolveNodeWindowsTaskName,
} from "./constants.js";
import {
  EXTRA_MARKERS,
  detectCommandExecutionMarker,
  detectLauncherServiceMarker,
  hasCmdServiceMarker,
  hasServiceMarker,
  type Marker,
} from "./inspect-markers.js";
import type { ExtraGatewayService, GatewayServiceInventory } from "./inspect.js";
import {
  readRegisteredScheduledTaskCommand,
  readStartupEntryCommand,
  resolveStartupEntryPath,
  resolveStartupEntryPaths,
  resolveTaskLauncherPathHint,
  resolveTaskName,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import {
  listScheduledTasks,
  probeScheduledTaskState,
  WindowsServiceObservationChangedError,
} from "./schtasks-state-probe.js";

function isOpenClawGatewayTaskName(name: string): boolean {
  const normalized = normalizeWindowsTaskIdentity(name.trim());
  const defaultName = normalizeWindowsTaskIdentity(resolveGatewayWindowsTaskName());
  return normalized === defaultName || /^openclaw gateway \(.+\)$/.test(normalized);
}

async function scanWindowsStartupEntries(
  env: Record<string, string | undefined>,
  includeManagedOpenClaw: boolean | undefined,
  errors: GatewayServiceInventory["errors"],
  includeNode = false,
  remaining: () => number | undefined = () => undefined,
): Promise<ExtraGatewayService[]> {
  let directory: string;
  let selected: Set<string>;
  try {
    directory = path.dirname(resolveStartupEntryPath(env));
    selected = new Set(
      resolveStartupEntryPaths(env).map((entry) => path.win32.normalize(entry).toLowerCase()),
    );
  } catch {
    errors.push({ source: "startup", message: "Windows Startup folder could not be located." });
    return [];
  }
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    try {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      // Windows also reports ENOENT when a path traverses a non-directory.
      const ancestor = await findExistingAncestor(directory);
      if (
        !ancestor ||
        ancestor === path.resolve(directory) ||
        !(await fs.stat(ancestor)).isDirectory()
      ) {
        throw error;
      }
    } catch {
      errors.push({ source: directory, message: "Windows Startup folder could not be inspected." });
    }
    return [];
  }
  let selectedStartupScript: string | undefined;
  if (
    !includeManagedOpenClaw &&
    entries.some((entry) =>
      selected.has(path.win32.normalize(path.join(directory, entry)).toLowerCase()),
    )
  ) {
    const task = probeScheduledTaskState(resolveTaskName(env), remaining());
    if (task.status === "missing") {
      selectedStartupScript = path.win32.normalize(resolveTaskScriptPath(env)).toLowerCase();
    } else if (task.status === "unknown") {
      errors.push({
        source: resolveTaskName(env),
        message: "Selected Gateway service could not be inspected.",
      });
    }
  }
  const services: ExtraGatewayService[] = [];
  for (const entry of entries.toSorted()) {
    if (!isWindowsBatchScriptPath(entry) && !/\.vbs$/i.test(entry)) {
      continue;
    }
    const name = entry.slice(0, -4);
    const pathname = path.join(directory, entry);
    const pathIdentity = path.win32.normalize(pathname).toLowerCase();
    let gateway =
      /(?:openclaw|clawdbot).*gateway/i.test(name) ||
      (includeNode && /(?:openclaw|clawdbot).*node(?:$|[ .(-])/i.test(name));
    let marker: Marker | undefined;
    try {
      const command = await readStartupEntryCommand(pathname, {
        timeoutMs: remaining(),
        onLauncherContent: (content) => {
          const hint =
            detectLauncherServiceMarker(content, includeNode) ||
            (hasCmdServiceMarker(content, includeNode) ? "openclaw" : undefined);
          gateway ||= Boolean(hint);
          marker = hint ?? marker;
        },
      });
      const commandMarker = detectCommandExecutionMarker(
        command.programArguments,
        undefined,
        includeNode,
      );
      const serviceMarker = command.environment?.OPENCLAW_SERVICE_MARKER;
      gateway = Boolean(commandMarker || hasServiceMarker(command.environment, includeNode));
      marker = commandMarker || (serviceMarker === "openclaw" ? "openclaw" : marker);
      const label = command.environment?.OPENCLAW_WINDOWS_TASK_NAME?.trim() || name;
      if (
        !marker ||
        !gateway ||
        (selected.has(pathIdentity) &&
          command.sourcePath &&
          path.win32.normalize(command.sourcePath).toLowerCase() === selectedStartupScript)
      ) {
        continue;
      }
      services.push({
        platform: "win32",
        label,
        detail: `startup: ${pathname}`,
        scope: "user",
        marker,
        legacy: marker !== "openclaw",
        windowsStartupEntry: pathname,
      });
    } catch (error) {
      if (error instanceof WindowsServiceObservationChangedError) {
        throw error;
      }
      if (gateway || selected.has(pathIdentity)) {
        errors.push({ source: pathname, message: "Startup launcher could not be inspected." });
      }
    }
  }
  return services;
}

export async function scanWindowsGatewayServices(
  env: Record<string, string | undefined>,
  opts: {
    deep?: boolean;
    includeManagedOpenClaw?: boolean;
    includeNode?: boolean;
    timeoutMs?: number;
  },
  errors: GatewayServiceInventory["errors"],
  push: (service: ExtraGatewayService) => void,
): Promise<void> {
  if (!opts.deep && !opts.includeManagedOpenClaw) {
    return;
  }
  const deadline = opts.timeoutMs === undefined ? undefined : performance.now() + opts.timeoutMs;
  const remaining = () => {
    if (deadline === undefined) {
      return undefined;
    }
    const timeoutMs = deadline - performance.now();
    if (timeoutMs <= 0) {
      throw new Error("Windows service inventory timed out.");
    }
    return timeoutMs;
  };
  let tasks: ReturnType<typeof listScheduledTasks>;
  try {
    tasks = listScheduledTasks(remaining());
  } catch (error) {
    if (error instanceof WindowsServiceObservationChangedError) {
      throw error;
    }
    errors.push({ source: "schtasks", message: "Scheduled tasks could not be queried." });
    tasks = [];
  }
  for (const task of tasks) {
    const name = task.taskPath?.trim();
    if (!name) {
      continue;
    }
    const gatewayName = isOpenClawGatewayTaskName(name);
    const nodeName =
      opts.includeNode === true &&
      normalizeWindowsTaskIdentity(name) ===
        normalizeWindowsTaskIdentity(resolveNodeWindowsTaskName());
    if (!opts.includeManagedOpenClaw && gatewayName) {
      continue;
    }
    const taskToRun =
      task.actions?.map((action) => `${action.path} ${action.arguments}`.trim()).join("; ") ?? "";
    const description = `${name}\n${taskToRun}`;
    const actionArgv =
      task.actions?.map((action) => [
        action.path,
        ...splitArgsPreservingQuotes(action.arguments, { escapeMode: "backslash-quote-only" }),
      ]) ?? [];
    const launcherReference = actionArgv.some((argv) =>
      argv.some(
        (argument) =>
          (isWindowsBatchScriptPath(argument) || /\.vbs$/i.test(argument)) &&
          detectLauncherServiceMarker(argument, opts.includeNode),
      ),
    );
    let gateway =
      gatewayName ||
      actionArgv.some((argv) => detectCommandExecutionMarker(argv, undefined, opts.includeNode));
    let marker: Marker | undefined = EXTRA_MARKERS.find((candidate) =>
      description.toLowerCase().includes(candidate),
    );
    const selected =
      normalizeWindowsTaskIdentity(name) === normalizeWindowsTaskIdentity(resolveTaskName(env));
    const inspectCommand = opts.includeManagedOpenClaw || !marker;
    if (inspectCommand && !task.actions) {
      if (gateway || nodeName || selected) {
        errors.push({ source: name, message: "Scheduled Task action could not be inspected." });
      }
      continue;
    }
    if (
      inspectCommand &&
      (launcherReference || task.actions?.some((action) => resolveTaskLauncherPathHint(action)))
    ) {
      try {
        const registered = await readRegisteredScheduledTaskCommand(
          { ...env, OPENCLAW_WINDOWS_TASK_NAME: name, OPENCLAW_PROFILE: undefined },
          {
            timeoutMs: remaining(),
            onLauncherContent: (content) => {
              const contentMarker =
                detectLauncherServiceMarker(content, opts.includeNode) ||
                (hasCmdServiceMarker(content, opts.includeNode) ? "openclaw" : undefined);
              gateway ||= Boolean(contentMarker);
              marker = contentMarker ?? marker;
            },
          },
        );
        if (!registered) {
          throw new WindowsServiceObservationChangedError(
            "Scheduled Task registration changed during inspection",
          );
        }
        const { command } = registered;
        const commandMarker = detectCommandExecutionMarker(
          command.programArguments,
          undefined,
          opts.includeNode,
        );
        const serviceMarker = command.environment?.OPENCLAW_SERVICE_MARKER;
        gateway =
          gatewayName ||
          Boolean(commandMarker || hasServiceMarker(command.environment, opts.includeNode));
        marker = commandMarker || (serviceMarker === "openclaw" ? "openclaw" : marker);
      } catch (error) {
        if (error instanceof WindowsServiceObservationChangedError) {
          throw error;
        }
        if (gateway || nodeName || selected || launcherReference) {
          errors.push({
            source: name,
            message: "Scheduled Task launcher could not be inspected.",
          });
        }
        continue;
      }
    }
    if (!marker || (opts.includeManagedOpenClaw && !gateway)) {
      continue;
    }
    push({
      platform: "win32",
      label: name,
      detail: taskToRun ? `task: ${name}, run: ${taskToRun}` : name,
      scope: "system",
      marker,
      legacy: marker !== "openclaw",
    });
  }
  for (const service of await scanWindowsStartupEntries(
    env,
    opts.includeManagedOpenClaw,
    errors,
    opts.includeNode,
    remaining,
  )) {
    push(service);
  }
}
