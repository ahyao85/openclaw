/** Read-only consumer facts; the operator keeps stopped siblings stopped during publication. */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { normalizeWindowsTaskIdentity } from "./constants.js";
import type { ExtraGatewayService, GatewayServiceInventory } from "./inspect.js";
import {
  probeLaunchAgentState,
  readLoadedLaunchdProgramArguments,
  resolveLaunchAgentGuiDomain,
} from "./launchd-runtime.js";
import { readRegisteredScheduledTaskCommand, readStartupEntryCommand } from "./schtasks-layout.js";
import {
  matchesWindowsServiceProcess,
  readWindowsServiceProcessObservation,
  type WindowsServiceProcess,
  type WindowsServiceProcessObservation,
} from "./schtasks-process-inspection.js";
import { WindowsServiceObservationChangedError } from "./schtasks-state-probe.js";
import {
  findServiceOwnershipRefusal,
  isServiceInspectionControlFailure,
} from "./service-inspection-error.js";
import { resolveServiceEntrypoint, summarizeGatewayServiceLayout } from "./service-layout.js";
import {
  inspectServicePublicationFootprint,
  inspectServicePublicationPath,
  servicePublicationFootprintsOverlap,
  type ServicePublicationFootprint,
} from "./service-publication-footprint.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceCommandInspection,
  GatewayServiceEnv,
} from "./service-types.js";
import { admitSystemdServiceReadBinding } from "./systemd-peer.js";
import { readSystemdServiceRuntime } from "./systemd-runtime.js";
import { readSystemdServiceExecStart } from "./systemd-service-files.js";

type ServiceConsumerDiagnostic = {
  source: string;
  message: string;
};

class ConsumerInspectionError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "changed" = "unavailable",
  ) {
    super(message);
  }
}

const sameWindowsPath = (left: string, right: string) =>
  path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();

function resolveConsumerLaunchdDomain(service: ExtraGatewayService): string {
  return (
    service.launchdDomain ??
    (service.scope === "system" && service.sourcePath?.startsWith("/Library/LaunchDaemons/")
      ? "system"
      : resolveLaunchAgentGuiDomain())
  );
}

function resolveUnixConsumerTarget(service: ExtraGatewayService) {
  if (
    service.platform === "win32" ||
    (service.sourcePath && !path.isAbsolute(service.sourcePath))
  ) {
    throw new ConsumerInspectionError("Service definition identity is unavailable.");
  }
  if (service.platform === "linux") {
    if (!service.sourcePath) {
      throw new ConsumerInspectionError("Service definition identity is unavailable.");
    }
    return {
      platform: "linux" as const,
      scope: service.scope,
      label: service.label,
      sourcePath: service.sourcePath,
    };
  }
  return {
    platform: "darwin" as const,
    domain: resolveConsumerLaunchdDomain(service),
    label: service.label,
    sourcePath: service.sourcePath,
  };
}

export function serviceConsumerInventoryKey(service: ExtraGatewayService): string {
  return JSON.stringify([
    service.platform,
    service.platform === "darwin"
      ? resolveConsumerLaunchdDomain(service)
      : service.platform === "linux"
        ? service.scope
        : service.windowsStartupEntry
          ? "startup"
          : "task",
    service.platform === "win32" ? normalizeWindowsTaskIdentity(service.label) : service.label,
    ...(service.platform === "win32" && service.windowsStartupEntry
      ? [service.windowsStartupEntry.toLowerCase()]
      : []),
  ]);
}

/** The selected snapshot is already inspected by its caller; this is delegation, never runtime proof. */
function isSelectedConsumer(
  service: ExtraGatewayService,
  selected: { service: ExtraGatewayService; command: GatewayServiceCommandConfig } | undefined,
): boolean {
  if (!selected || selected.service.platform !== service.platform || service.platform === "win32") {
    return false;
  }
  const { sourcePath } = selected.service;
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    return false;
  }
  return (
    sourcePath === service.sourcePath &&
    [selected.command.sourcePath, ...(selected.command.definitionPaths ?? [])].includes(
      sourcePath,
    ) &&
    serviceConsumerInventoryKey(selected.service) === serviceConsumerInventoryKey(service)
  );
}

type ConsumerObservation = {
  command: GatewayServiceCommandConfig | null;
  registeredCommand?: GatewayServiceCommandConfig;
  runtime: GatewayServiceRuntime;
  loadedLaunchd?: boolean;
};

function runtimeIdentity(runtime: GatewayServiceRuntime) {
  return {
    status: runtime.status,
    pid: runtime.pid,
    windowsProcesses: runtime.windowsProcesses,
    state: runtime.state,
    subState: runtime.subState,
    unit: runtime.systemd?.unit,
    scope: runtime.systemd?.scope,
    managerUid: runtime.systemd?.managerUid,
  };
}

async function observeConsumer(
  service: ExtraGatewayService,
  env: GatewayServiceEnv,
  timeoutMs: number,
  assertCurrent: () => void,
  consume: (observed: ConsumerObservation, verify: () => Promise<void>) => Promise<void>,
  windowsProcesses?: WindowsServiceProcessObservation,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    assertCurrent();
    const time = deadline - performance.now();
    if (time <= 0) {
      throw new ConsumerInspectionError("Native consumer inspection timed out; retry.");
    }
    return time;
  };
  const inspect = async (read: (recheck: boolean) => Promise<ConsumerObservation>) => {
    const observed = await read(false);
    assertCurrent();
    await consume(observed, async () => {
      const after = await read(true);
      assertCurrent();
      if (after.runtime.status === "unknown" && !after.command) {
        throw new ConsumerInspectionError("Native consumer reinspection is unavailable.");
      }
      if (
        !isDeepStrictEqual(observed.command, after.command) ||
        !isDeepStrictEqual(observed.registeredCommand, after.registeredCommand) ||
        observed.loadedLaunchd !== after.loadedLaunchd ||
        !isDeepStrictEqual(runtimeIdentity(observed.runtime), runtimeIdentity(after.runtime))
      ) {
        throw new ConsumerInspectionError(
          "Service changed during consumer inspection; retry.",
          "changed",
        );
      }
    });
  };
  if (service.platform === "win32") {
    const startup = service.windowsStartupEntry;
    if (startup && !path.win32.isAbsolute(startup)) {
      throw new ConsumerInspectionError("Startup definition identity is unavailable.");
    }
    const scopedEnv = { ...env, OPENCLAW_WINDOWS_TASK_NAME: service.label };
    await inspect(async (recheck) => {
      const task = startup
        ? undefined
        : await readRegisteredScheduledTaskCommand(scopedEnv, {
            timeoutMs: remaining(),
          });
      if (task && ![1, 3, 4].includes(task.state ?? 0)) {
        throw new ConsumerInspectionError(
          "This Scheduled Task's native state is unknown; restore inspection before retrying.",
        );
      }
      const command = startup
        ? await readStartupEntryCommand(startup, { timeoutMs: remaining() })
        : task?.command;
      assertCurrent();
      if (recheck && !command) {
        throw new WindowsServiceObservationChangedError(
          "The observed Scheduled Task disappeared during inspection.",
        );
      }
      if (
        !command ||
        (command.sourcePath
          ? !path.win32.isAbsolute(command.sourcePath)
          : !task || startup || service.sourcePath || command.definitionPaths?.length) ||
        (service.sourcePath &&
          (!command.sourcePath || !sameWindowsPath(service.sourcePath, command.sourcePath))) ||
        (startup &&
          ![command.sourcePath, ...(command.definitionPaths ?? [])].some(
            (file) => file !== undefined && sameWindowsPath(file, startup),
          ))
      ) {
        throw new ConsumerInspectionError("Windows definition binding is unavailable.");
      }
      if (!windowsProcesses) {
        throw new ConsumerInspectionError("Windows process consumers could not be inspected.");
      }
      windowsProcesses.includeInstalled(command.programArguments);
      const processes = windowsProcesses.findInstalled(null, command.programArguments);
      const runtime: GatewayServiceRuntime = {
        status: processes.length ? "running" : task?.state === 4 ? "unknown" : "stopped",
        ...(processes[0]
          ? {
              pid: processes[0].pid,
              windowsProcesses: windowsProcesses
                .readConsumers()
                .processes.filter((process) =>
                  matchesWindowsServiceProcess(process.programArguments, command.programArguments),
                ),
            }
          : {}),
      };
      remaining();
      // Scheduler activity without a matching process does not identify the currently used install.
      // Disk/native registration does not identify a running process's current argv.
      const currentCommand = processes[0]
        ? { programArguments: processes[0].programArguments }
        : command;
      return {
        command: currentCommand,
        ...(processes[0] && !resolveServiceEntrypoint(currentCommand)
          ? { registeredCommand: command }
          : {}),
        runtime,
      };
    });
    return;
  }
  const identity = resolveUnixConsumerTarget(service);
  if (identity.platform === "darwin") {
    await inspect(async () => {
      const native = await probeLaunchAgentState(
        `${identity.domain}/${identity.label}`,
        remaining(),
      );
      assertCurrent();
      const loadedLaunchd = native.state === "running" || native.state === "stopped";
      const command = loadedLaunchd
        ? await readLoadedLaunchdProgramArguments(
            `${identity.domain}/${identity.label}`,
            remaining(),
          )
        : null;
      assertCurrent();
      return {
        command,
        loadedLaunchd,
        runtime: {
          status: native.state === "not-loaded" ? "stopped" : native.state,
          ...(native.state === "running" || native.state === "stopped"
            ? { pid: native.runtime.pid, state: native.runtime.state }
            : {}),
        },
      };
    });
    return;
  }
  const target = { scope: identity.scope, unitName: identity.label, unitPath: identity.sourcePath };
  const binding =
    identity.scope === "user" ? await admitSystemdServiceReadBinding(env, deadline) : undefined;
  try {
    await inspect(async () => {
      binding?.verify();
      const options = () => ({
        requireLoaded: true,
        systemdReadTarget: target,
        systemdReadBinding: binding,
        timeoutMs: remaining(),
      });
      const runtime = await readSystemdServiceRuntime(env, options());
      assertCurrent();
      if (
        runtime.systemd?.unit !== identity.label ||
        runtime.systemd.scope !== identity.scope ||
        runtime.systemd.managerUid === undefined ||
        (binding && runtime.systemd.managerUid !== binding.managerUid)
      ) {
        throw new ConsumerInspectionError("This exact systemd runtime could not be inspected.");
      }
      if (runtime.status !== "stopped" && (!runtime.pid || runtime.pid <= 0)) {
        throw new ConsumerInspectionError(
          "Current systemd process identity could not be verified.",
        );
      }
      const inspection: { value?: GatewayServiceCommandInspection } = {};
      const command = await readSystemdServiceExecStart(env, {
        ...options(),
        ...(runtime.status !== "stopped" ? { expectedRunningPid: runtime.pid ?? 0 } : {}),
        onCommandInspection: (fact) => {
          inspection.value = fact;
        },
      });
      assertCurrent();
      if (inspection.value?.kind === "unavailable") {
        throw inspection.value.error;
      }
      if (command && inspection.value?.kind !== "present") {
        throw new ConsumerInspectionError("Current systemd command could not be verified.");
      }
      if (command && command.sourcePath !== identity.sourcePath) {
        throw new ConsumerInspectionError("Systemd definition binding is unavailable.");
      }
      binding?.verify();
      return { command, runtime };
    });
  } finally {
    await binding?.close();
  }
}

export async function inspectServiceConsumerFootprint(
  command: GatewayServiceCommandConfig,
  assertCurrent: () => void,
  outputPaths?: readonly string[],
) {
  const layout = await summarizeGatewayServiceLayout(command);
  assertCurrent();
  if (!layout?.packageRootReal || !layout.entrypointReal) {
    throw new ConsumerInspectionError("Service installation binding is incomplete.");
  }
  const footprint = await inspectServicePublicationFootprint(
    layout.packageRootReal,
    assertCurrent,
    false,
    outputPaths,
  );
  const entrypoint = await inspectServicePublicationPath(layout.entrypointReal, assertCurrent);
  return {
    footprint,
    entrypoint,
    identity: [footprint.root, ...footprint.outputs, entrypoint].map(({ real, ancestors }) => ({
      real,
      ancestors,
    })),
  };
}

/** Inventory includes Node services. Observed stops grant no control over later external starts. */
export async function inspectServicePublicationConsumers(params: {
  inventory: GatewayServiceInventory;
  targets: readonly ServicePublicationFootprint[];
  mode: "whole-package" | "runtime-artifacts";
  outputPaths?: readonly string[];
  env: GatewayServiceEnv;
  knownWindowsProcesses?: WindowsServiceProcess[];
  knownOverlappingConsumers?: ReadonlySet<string>;
  readParkedForegroundPid?: () => Promise<number>;
  /** The selected owner still revalidates its own definition and native authority. */
  selected?: {
    service: ExtraGatewayService;
    command: GatewayServiceCommandConfig;
    windowsProcesses?: WindowsServiceProcess[];
  };
  assertCurrent: () => void;
  timeoutMs: number;
}) {
  const assertCurrent = params.assertCurrent;
  const deadline = performance.now() + params.timeoutMs;
  const remaining = () => {
    assertCurrent();
    const budget = deadline - performance.now();
    if (budget <= 0) {
      throw new ConsumerInspectionError("Service consumer inspection timed out.");
    }
    return budget;
  };
  const env = {
    ...params.env,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_STATE_DIR: undefined,
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_LAUNCHD_LABEL: undefined,
    OPENCLAW_SYSTEMD_UNIT: undefined,
    OPENCLAW_WINDOWS_TASK_NAME: undefined,
    OPENCLAW_TASK_SCRIPT: undefined,
    OPENCLAW_GATEWAY_PORT: undefined,
    OPENCLAW_SERVICE_KIND: undefined,
  };
  const services = structuredClone(params.inventory.services);
  const selected = params.selected && structuredClone(params.selected);
  const known = structuredClone(params.knownWindowsProcesses ?? []);
  const overlaps = new Set(params.knownOverlappingConsumers);
  const blockers: ServiceConsumerDiagnostic[] = [];
  const warnings: ServiceConsumerDiagnostic[] = [...params.inventory.errors];
  const rethrowCurrentnessFailure = (error: unknown) => {
    assertCurrent();
    if (
      isServiceInspectionControlFailure(error) ||
      (error instanceof ConsumerInspectionError && error.kind === "changed")
    ) {
      throw findServiceOwnershipRefusal(error) ?? error;
    }
  };
  const unavailable = (source: string, knownOverlap: boolean, error?: unknown) => {
    rethrowCurrentnessFailure(error);
    (knownOverlap ? blockers : warnings).push({
      source,
      message: knownOverlap
        ? "A previously verified shared-installation consumer could not be verified as stopped; restore native inspection or stop it before retrying."
        : "Service inspection is unavailable; the recorded service was left unchanged. Inspect it and restart its Gateway manually after the update.",
    });
  };
  const inspectFootprint = async (command: GatewayServiceCommandConfig) => {
    const before = await inspectServiceConsumerFootprint(
      command,
      assertCurrent,
      params.outputPaths,
    );
    const overlapping = params.targets.some((target) =>
      servicePublicationFootprintsOverlap(target, before.footprint, {
        mode: params.mode,
        entrypoint: before.entrypoint,
      }),
    );
    // Later inspection failure cannot erase observed overlap; only disjointness needs another read.
    if (overlapping) {
      return true;
    }
    const after = await inspectServiceConsumerFootprint(command, assertCurrent, params.outputPaths);
    if (!isDeepStrictEqual(before.identity, after.identity)) {
      throw new ConsumerInspectionError(
        "Service installation changed during consumer inspection; retry.",
        "changed",
      );
    }
    return false;
  };
  const stopFirst = (source: string, loadedPidless = false, systemUnit?: string) =>
    blockers.push({
      source,
      message: systemUnit
        ? `This system service consumes the installation being updated. Stop it before retrying: sudo systemctl stop ${quoteCliArg(systemUnit)}. Rerun the original update command with the same account, profile, and options, then restart it with: sudo systemctl restart ${quoteCliArg(systemUnit)}. Keep it stopped until the update completes.`
        : loadedPidless
          ? "Stop and unload this launchd service before retrying; it consumes the installation being updated and can restart without a PID. Keep it unloaded until the update completes."
          : "Stop this service before retrying; it consumes the installation being updated. Keep it stopped until the update completes.",
    });
  const processKey = (process: WindowsServiceProcess) =>
    JSON.stringify(["win32-process", process.pid, process.startedAt]);
  const windowsKeys = new Set([
    ...services.filter((service) => service.platform === "win32").map(serviceConsumerInventoryKey),
    ...known.map(processKey),
    ...(selected?.windowsProcesses ?? []).map(processKey),
  ]);
  let unverifiedWindowsOverlap = false;
  const hasWindowsOverlap = () =>
    unverifiedWindowsOverlap || [...windowsKeys].some((key) => overlaps.has(key));
  if (selected?.service.platform === "win32") {
    for (const process of selected.windowsProcesses ?? []) {
      const liveCommand = { programArguments: process.programArguments };
      if (
        matchesWindowsServiceProcess(process.programArguments, selected.command.programArguments) &&
        resolveServiceEntrypoint(liveCommand) &&
        (await inspectFootprint(liveCommand))
      ) {
        overlaps.add(processKey(process));
      }
    }
  }
  let windowsProcesses: WindowsServiceProcessObservation | undefined;
  if (process.platform === "win32") {
    try {
      windowsProcesses = readWindowsServiceProcessObservation(env, remaining()) ?? undefined;
      assertCurrent();
      if (!windowsProcesses) {
        unavailable("Windows processes", hasWindowsOverlap());
      } else if (selected?.service.platform === "win32") {
        windowsProcesses.includeInstalled(selected.command.programArguments);
      }
    } catch (error) {
      unavailable("Windows processes", hasWindowsOverlap(), error);
    }
  }
  for (const service of services) {
    const source = service.sourcePath ?? service.windowsStartupEntry ?? service.label;
    let key: string | undefined;
    try {
      if (service.platform !== "win32") {
        resolveUnixConsumerTarget(service);
      }
      key = serviceConsumerInventoryKey(service);
      const selectedMatch = isSelectedConsumer(service, selected);
      if (selectedMatch) {
        if (selected && (await inspectFootprint(selected.command))) {
          if (key) {
            overlaps.add(key);
          }
        }
        continue;
      }
      const scopedEnv =
        service.platform === "linux"
          ? { ...env, OPENCLAW_SYSTEMD_UNIT: service.label.replace(/\.service$/, "") }
          : env;
      await observeConsumer(
        service,
        scopedEnv,
        remaining(),
        assertCurrent,
        async ({ command, registeredCommand, runtime, loadedLaunchd }, verify) => {
          // An unknown native state cannot establish the running installation.
          const currentCommand =
            command && (service.platform !== "win32" || runtime.status !== "unknown");
          if (!currentCommand && runtime.status === "unknown") {
            unavailable(source, key !== undefined && overlaps.has(key));
            return;
          }
          const overlapping = currentCommand
            ? await inspectFootprint(registeredCommand ?? command)
            : undefined;
          // Retain positive association before reinspection can lose the observed processes.
          if (overlapping) {
            if (key) {
              overlaps.add(key);
            }
            for (const process of runtime.windowsProcesses ?? []) {
              overlaps.add(processKey(process));
            }
          }
          known.push(...(runtime.windowsProcesses ?? []));
          await verify();
          assertCurrent();
          if (service.platform === "win32") {
            // Registration can retain positive association, never prove a relative process's cwd.
            if (registeredCommand || runtime.status === "unknown") {
              unavailable(source, key !== undefined && overlaps.has(key));
            }
            return;
          }
          if (runtime.status === "stopped" && !loadedLaunchd) {
            return;
          }
          if (overlapping) {
            stopFirst(
              source,
              loadedLaunchd && runtime.status === "stopped",
              service.platform === "linux" && service.scope === "system"
                ? service.label
                : undefined,
            );
          } else if (overlapping !== false || (key !== undefined && overlaps.has(key))) {
            // A new realpath cannot retire code held by an already observed consumer.
            unavailable(source, key !== undefined && overlaps.has(key));
          }
        },
        windowsProcesses,
      );
    } catch (error) {
      unavailable(source, key !== undefined && overlaps.has(key), error);
    }
  }
  let observedWindowsProcesses: WindowsServiceProcess[] | undefined;
  if (windowsProcesses) {
    const undelegated: { observed: WindowsServiceProcess; unresolved: boolean }[] = [];
    const captured = selected?.service.platform === "win32" ? selected.windowsProcesses : undefined;
    try {
      const census = windowsProcesses.readConsumers();
      for (const candidate of census.unavailable) {
        const source = candidate.pid ? `Windows process ${candidate.pid}` : "Windows process";
        try {
          if (await inspectFootprint({ programArguments: candidate.programArguments })) {
            unverifiedWindowsOverlap = true;
            stopFirst(source);
          } else {
            unavailable(source, false);
          }
        } catch (error) {
          unavailable(source, false, error);
        }
      }
      const currentByPid = new Map(census.processes.map((process) => [process.pid, process]));
      for (const process of [...known, ...(captured ?? [])]) {
        try {
          const observed = windowsProcesses.readKnown(process);
          if (observed) {
            currentByPid.set(observed.pid, observed);
          }
        } catch (error) {
          unavailable(`Windows process ${process.pid}`, overlaps.has(processKey(process)), error);
        }
      }
      const current = [...currentByPid.values()];
      observedWindowsProcesses = current;
      const primary = captured?.[0];
      const delegatedFamily =
        captured &&
        primary &&
        current.some((observed) => isDeepStrictEqual(primary, observed)) &&
        isDeepStrictEqual(windowsProcesses.family(primary.pid), captured)
          ? captured
          : [];
      for (const observed of current) {
        const key = processKey(observed);
        windowsKeys.add(key);
        try {
          const command = { programArguments: observed.programArguments };
          if (!resolveServiceEntrypoint(command)) {
            undelegated.push({ observed, unresolved: true });
            continue;
          }
          const overlapping = overlaps.has(key) || (await inspectFootprint(command));
          if (overlapping) {
            overlaps.add(key);
          }
          assertCurrent();
          if (!overlapping) {
            continue;
          }
          const delegated =
            selected?.service.platform === "win32" &&
            delegatedFamily.some((member) => isDeepStrictEqual(member, observed)) &&
            matchesWindowsServiceProcess(
              observed.programArguments,
              selected.command.programArguments,
            );
          if (!delegated) {
            undelegated.push({ observed, unresolved: false });
          }
        } catch (error) {
          unavailable(`Windows process ${observed.pid}`, overlaps.has(key), error);
        }
      }
    } catch (error) {
      unavailable("Windows processes", hasWindowsOverlap(), error);
    }
    // Live foreground closure is authority; its failure cannot become an inspection warning.
    const parkedPid = undelegated.length ? await params.readParkedForegroundPid?.() : undefined;
    assertCurrent();
    for (const { observed, unresolved } of undelegated) {
      if (observed.pid !== parkedPid) {
        const source = `Windows process ${observed.pid}`;
        if (unresolved) {
          blockers.push({
            source,
            message:
              "This running Gateway's installation could not be verified. Stop it before retrying and keep it stopped until the update completes.",
          });
        } else {
          stopFirst(source);
        }
      }
    }
    try {
      windowsProcesses.verify();
    } catch (error) {
      unavailable("Windows processes", hasWindowsOverlap(), error);
    }
  }
  assertCurrent();
  return {
    blockers,
    warnings,
    overlappingConsumers: overlaps,
    ...(observedWindowsProcesses ? { windowsProcesses: observedWindowsProcesses } : {}),
  };
}
