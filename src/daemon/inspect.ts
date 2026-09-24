/** Discovers installed service candidates; native owners verify lifecycle authority. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  NODE_SERVICE_KIND,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveNodeLaunchAgentLabel,
} from "./constants.js";
import {
  EXTRA_MARKERS,
  detectCommandExecutionMarker,
  detectMarkerLineWithService,
  hasServiceMarker,
  hasSystemdServiceMarker,
} from "./inspect-markers.js";
import { scanWindowsGatewayServices } from "./inspect-windows.js";
import { findLoadedManagedLaunchdJobs } from "./launchd-foreign-jobs.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { decodeLaunchdPlistMetadata } from "./launchd-plist.js";
import { resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";
import { resolveDaemonHomeDir } from "./paths.js";
import {
  findServiceOwnershipRefusal,
  isServiceInspectionControlFailure,
} from "./service-inspection-error.js";
import { listLoadedSystemdServices } from "./systemd-peer.js";
import { isSystemdManagerAbsent } from "./systemd-scope.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

export type ExtraGatewayService = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  detail: string;
  sourcePath?: string;
  /** Native domain remains usable when the registered job's plist has disappeared. */
  launchdDomain?: string;
  scope: "user" | "system";
  marker?: "openclaw" | "clawdbot";
  legacy?: boolean;
  /** Exact Startup definition; a task label cannot identify this native owner. */
  windowsStartupEntry?: string;
};

export type FindExtraGatewayServicesOptions = {
  deep?: boolean;
};

export type GatewayServiceInventory = {
  services: ExtraGatewayService[];
  errors: Array<{ source: string; message: string }>;
};

function rethrowInspectionAuthorityFailure(error: unknown): void {
  if (isServiceInspectionControlFailure(error)) {
    throw findServiceOwnershipRefusal(error) ?? error;
  }
}

function remainingInventoryBudget(deadline: number | undefined): number | undefined {
  if (deadline === undefined) {
    return undefined;
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    throw new Error("Service inventory inspection timed out.");
  }
  return remaining;
}

export function renderGatewayServiceCleanupHints(
  services: readonly ExtraGatewayService[] = [],
): string[] {
  const hints: string[] = [];

  for (const service of services) {
    switch (service.platform) {
      case "darwin": {
        const plistPath = service.sourcePath;
        // Global LaunchAgents still run in a GUI domain; only LaunchDaemons
        // belong to the system domain regardless of their shared file scope.
        const domain =
          service.scope === "system" && plistPath?.startsWith("/Library/LaunchDaemons/")
            ? "system"
            : "gui/$UID";
        const launchctlCommand = domain === "system" ? "sudo launchctl" : "launchctl";
        hints.push(`${launchctlCommand} bootout ${domain}/${quoteCliArg(service.label)}`);
        if (plistPath) {
          const removeCommand = service.scope === "system" ? "sudo rm" : "rm";
          hints.push(`${removeCommand} ${quoteCliArg(plistPath)}`);
        }
        break;
      }
      case "linux": {
        const systemctlCommand = `systemctl --${service.scope}`;
        const unit = quoteCliArg(service.label);
        // A discovered unit may be the only running Gateway; inspect before removal.
        hints.push(`${systemctlCommand} status -- ${unit}`, `${systemctlCommand} cat -- ${unit}`);
        break;
      }
      case "win32":
        if (service.windowsStartupEntry) {
          hints.push(
            `Get-Item -LiteralPath '${service.windowsStartupEntry.replaceAll("'", "''")}'`,
          );
          break;
        }
        // The hint can be pasted into cmd.exe or PowerShell, so exclude names
        // that either shell can expand rather than guessing a common escape.
        if (/^[A-Za-z0-9_. ()\\/-]+$/.test(service.label)) {
          hints.push(`schtasks /Delete /TN "${service.label}" /F`);
        }
        break;
    }
  }

  return hints;
}

function isLegacyLabel(label: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(label);
  return lower.includes("clawdbot");
}

function isPotentialGatewayServiceName(
  name: string,
  platform: "darwin" | "linux",
  selected?: string,
  includeNode = false,
): boolean {
  if (
    includeNode &&
    (platform === "darwin"
      ? name === resolveNodeLaunchAgentLabel()
      : /^(?:openclaw|clawdbot)-node(?:$|[-.@])/.test(name))
  ) {
    return true;
  }
  return (
    name === selected ||
    (platform === "darwin"
      ? (name.startsWith("ai.openclaw.") && name !== resolveNodeLaunchAgentLabel()) ||
        /clawdbot.*gateway/.test(name)
      : /^(?:openclaw|clawdbot)(?:$|@|-gateway(?:$|[-.@]))/.test(name))
  );
}

type ServiceFileEntry = {
  entry: string;
  name: string;
  fullPath: string;
  contents: Buffer;
};

async function collectServiceFiles(params: {
  dir: string;
  extension: string;
  ignoredName?: string;
  isPotentialName: (name: string) => boolean;
  errors?: GatewayServiceInventory["errors"];
  deadline?: number;
}): Promise<ServiceFileEntry[]> {
  const out: ServiceFileEntry[] = [];
  let entries: string[];
  remainingInventoryBudget(params.deadline);
  try {
    entries = await fs.readdir(params.dir);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      params.errors?.push({ source: params.dir, message: "Service path could not be inspected." });
    }
    return out;
  }
  for (const entry of entries.toSorted()) {
    remainingInventoryBudget(params.deadline);
    if (!entry.endsWith(params.extension)) {
      continue;
    }
    const name = entry.slice(0, -params.extension.length);
    if (name === params.ignoredName) {
      continue;
    }
    const fullPath = path.join(params.dir, entry);
    let contents: Buffer;
    try {
      contents = await fs.readFile(fullPath);
    } catch {
      if (params.isPotentialName(name)) {
        params.errors?.push({ source: fullPath, message: "Service path could not be inspected." });
      }
      continue;
    }
    out.push({ entry, name, fullPath, contents });
  }
  return out;
}

async function scanLaunchdDir(params: {
  dir: string;
  scope: "user" | "system";
  includeManagedOpenClaw?: boolean;
  includeNode?: boolean;
  managedLabel?: string;
  selectedName?: string;
  errors?: GatewayServiceInventory["errors"];
  deadline?: number;
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const isPotentialName = (name: string) =>
    isPotentialGatewayServiceName(name, "darwin", params.selectedName, params.includeNode);
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".plist",
    ignoredName: params.includeManagedOpenClaw ? undefined : resolveGatewayLaunchAgentLabel(),
    isPotentialName,
    errors: params.errors,
    deadline: params.deadline,
  });

  for (const { name: labelFromName, fullPath, contents } of candidates) {
    const plist = await decodeLaunchdPlistMetadata(
      contents,
      remainingInventoryBudget(params.deadline),
    ).catch((error: unknown) => {
      rethrowInspectionAuthorityFailure(error);
      const contentHint = normalizeLowercaseStringOrEmpty(
        contents.toString("utf8").replaceAll("\0", ""),
      );
      if (
        isPotentialName(labelFromName) ||
        EXTRA_MARKERS.some((marker) => contentHint.includes(marker))
      ) {
        params.errors?.push({ source: fullPath, message: "Service plist could not be inspected." });
      }
      return undefined;
    });
    if (!plist) {
      continue;
    }
    const label = typeof plist.Label === "string" && plist.Label ? plist.Label : labelFromName;
    const executionMarker = detectCommandExecutionMarker(
      Array.isArray(plist.ProgramArguments)
        ? plist.ProgramArguments.filter((arg): arg is string => typeof arg === "string")
        : [],
      typeof plist.Program === "string" ? plist.Program : undefined,
      params.includeNode,
    );
    const serviceMarker = hasServiceMarker(plist.EnvironmentVariables, params.includeNode);
    const legacyLabel = isLegacyLabel(labelFromName) || isLegacyLabel(label);
    const marker =
      label === params.managedLabel || serviceMarker
        ? "openclaw"
        : (executionMarker ?? (legacyLabel ? "clawdbot" : null));
    if (!marker) {
      continue;
    }
    // Managed current services are expected; this scan reports extra jobs that
    // can compete for ports or survive old installs.
    if (
      !params.includeManagedOpenClaw &&
      (label === resolveGatewayLaunchAgentLabel() ||
        (marker === "openclaw" &&
          (serviceMarker || (executionMarker === "openclaw" && label.startsWith("ai.openclaw.")))))
    ) {
      continue;
    }
    results.push({
      platform: "darwin",
      label,
      detail: `plist: ${fullPath}`,
      sourcePath: fullPath,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw" || isLegacyLabel(label),
    });
  }

  return results;
}

async function scanSystemdDir(params: {
  dir: string;
  scope: "user" | "system";
  includeManagedOpenClaw?: boolean;
  includeNode?: boolean;
  selectedName?: string;
  errors?: GatewayServiceInventory["errors"];
  deadline?: number;
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".service",
    ignoredName: params.includeManagedOpenClaw ? undefined : resolveGatewaySystemdServiceName(),
    isPotentialName: (name) =>
      isPotentialGatewayServiceName(name, "linux", params.selectedName, params.includeNode),
    errors: params.errors,
    deadline: params.deadline,
  });

  for (const { entry, name, fullPath, contents: bytes } of candidates) {
    remainingInventoryBudget(params.deadline);
    const contents = bytes.toString("utf8");
    const serviceMarker = hasSystemdServiceMarker(contents, params.includeNode);
    const marker = serviceMarker
      ? "openclaw"
      : detectMarkerLineWithService(contents, params.includeNode);
    if (!marker) {
      continue;
    }
    if (
      !params.includeManagedOpenClaw &&
      marker === "openclaw" &&
      (serviceMarker ||
        (name.startsWith("openclaw-gateway") &&
          normalizeLowercaseStringOrEmpty(contents).includes("gateway")))
    ) {
      continue;
    }
    results.push({
      platform: "linux",
      label: entry,
      detail: `unit: ${fullPath}`,
      sourcePath: fullPath,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw",
    });
  }

  return results;
}

async function scanLoadedSystemdServices(
  env: Record<string, string | undefined>,
  scope: "user" | "system",
  includeNode: boolean,
  inventory: GatewayServiceInventory,
  deadline: number,
): Promise<void> {
  try {
    const loadedInventory = await listLoadedSystemdServices(env, scope, deadline);
    for (const label of loadedInventory.unavailableUnits) {
      inventory.errors.push({
        source: `systemd:${scope}/${label}`,
        message: "Loaded service metadata could not be inspected.",
      });
    }
    for (const loaded of loadedInventory.services) {
      const commandMarker = loaded.commands
        .map((argv) => detectCommandExecutionMarker(argv, undefined, includeNode))
        .find((marker) => marker !== null);
      const serviceMarker =
        loaded.environment.includes(`OPENCLAW_SERVICE_MARKER=${GATEWAY_SERVICE_MARKER}`) &&
        (loaded.environment.includes(`OPENCLAW_SERVICE_KIND=${GATEWAY_SERVICE_KIND}`) ||
          (includeNode &&
            loaded.environment.includes(`OPENCLAW_SERVICE_KIND=${NODE_SERVICE_KIND}`)));
      const marker = serviceMarker ? "openclaw" : commandMarker;
      if (!marker) {
        continue;
      }
      // A deleted fragment still names the manager's loaded command; no disk read proves exit.
      const sourcePath = loaded.fragmentPath || undefined;
      if (!sourcePath) {
        inventory.errors.push({
          source: `systemd:${scope}/${loaded.label}`,
          message: "Loaded service definition is missing or could not be inspected.",
        });
      }
      if (
        !inventory.services.some(
          (service) =>
            service.platform === "linux" &&
            service.scope === scope &&
            service.label === loaded.label &&
            service.sourcePath === sourcePath,
        )
      ) {
        inventory.services.push({
          platform: "linux",
          label: loaded.label,
          scope,
          marker,
          detail: `loaded unit: ${loaded.label}`,
          ...(sourcePath ? { sourcePath } : {}),
          legacy: marker !== "openclaw",
        });
      }
    }
  } catch (error) {
    rethrowInspectionAuthorityFailure(error);
    inventory.errors.push({
      source: `systemd:${scope}`,
      message: "Loaded services could not be inspected.",
    });
  }
}

export async function findSystemGatewayServices(): Promise<ExtraGatewayService[]> {
  if (process.platform !== "linux") {
    return [];
  }

  const results: ExtraGatewayService[] = [];
  try {
    for (const dir of ["/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"]) {
      results.push(
        ...(await scanSystemdDir({
          dir,
          scope: "system",
          includeManagedOpenClaw: true,
        })),
      );
    }
  } catch {
    return [];
  }

  return results;
}

async function scanGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions & {
    includeManagedOpenClaw?: boolean;
    includeNode?: boolean;
    includeLoaded?: boolean;
    timeoutMs?: number;
  },
): Promise<GatewayServiceInventory> {
  const inventory: GatewayServiceInventory = { services: [], errors: [] };
  const deadline = opts.timeoutMs === undefined ? undefined : performance.now() + opts.timeoutMs;
  const { services, errors } = inventory;
  const seen = new Set<string>();
  const push = (svc: ExtraGatewayService) => {
    const key = `${svc.platform}:${svc.label}:${svc.detail}:${svc.scope}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    services.push(svc);
  };

  if (process.platform === "darwin") {
    try {
      const userDir = path.join(resolveDaemonHomeDir(env), "Library", "LaunchAgents");
      for (const svc of await scanLaunchdDir({
        dir: userDir,
        scope: "user",
        includeManagedOpenClaw: opts.includeManagedOpenClaw,
        includeNode: opts.includeNode,
        selectedName: resolveLaunchAgentLabel(env),
        errors,
        deadline,
      })) {
        push(svc);
      }
      if (opts.deep) {
        for (const directory of ["LaunchAgents", "LaunchDaemons"]) {
          const systemDaemon = directory === "LaunchDaemons";
          for (const svc of await scanLaunchdDir({
            dir: path.join(path.sep, "Library", directory),
            scope: "system",
            includeManagedOpenClaw: systemDaemon || opts.includeManagedOpenClaw,
            includeNode: opts.includeNode,
            managedLabel: systemDaemon ? resolveLaunchAgentLabel(env) : undefined,
            selectedName: resolveLaunchAgentLabel(env),
            errors,
            deadline,
          })) {
            push(svc);
          }
        }
      }
    } catch (error) {
      rethrowInspectionAuthorityFailure(error);
      errors.push({ source: "launchd", message: "Gateway service discovery could not finish." });
    }
    if (opts.includeLoaded) {
      const guiDomain = resolveLaunchAgentGuiDomain();
      const knownLabels = [
        resolveLaunchAgentLabel(env),
        ...(opts.includeNode ? [resolveNodeLaunchAgentLabel()] : []),
      ];
      for (const domain of [guiDomain, ...(opts.deep ? ["system"] : [])]) {
        const definitions = services.filter(
          (service) =>
            service.platform === "darwin" &&
            (domain === "system") ===
              (service.scope === "system" &&
                service.sourcePath?.startsWith("/Library/LaunchDaemons/") === true),
        );
        try {
          const loaded = await findLoadedManagedLaunchdJobs({
            domain,
            knownLabels: [...knownLabels, ...definitions.map((service) => service.label)],
            includeNode: opts.includeNode,
            deadline: deadline ?? performance.now() + 5_000,
          });
          for (const label of loaded) {
            if (!definitions.some((service) => service.label === label)) {
              push({
                platform: "darwin",
                scope: domain === "system" ? "system" : "user",
                launchdDomain: domain,
                label,
                detail: `loaded job: ${domain}/${label}`,
              });
            }
          }
        } catch (error) {
          rethrowInspectionAuthorityFailure(error);
          errors.push({
            source: domain,
            message:
              error instanceof Error
                ? error.message
                : "Loaded launchd scope could not be inspected.",
          });
        }
      }
    }
    return inventory;
  }

  if (process.platform === "linux") {
    try {
      const home = resolveDaemonHomeDir(env);
      const userDir = path.join(home, ".config", "systemd", "user");
      const userServices = await scanSystemdDir({
        dir: userDir,
        scope: "user",
        includeManagedOpenClaw: opts.includeManagedOpenClaw,
        includeNode: opts.includeNode,
        selectedName: resolveSystemdServiceName(env),
        errors,
        deadline,
      });
      for (const svc of userServices) {
        push(svc);
      }
      for (const name of opts.includeManagedOpenClaw ? [] : LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
        const label = `${name}.service`;
        // The unit and its managed backup are one cleanup target. Report the
        // backup separately only when it is the remaining orphaned artifact.
        if (userServices.some((service) => service.label === label)) {
          continue;
        }
        const backupPath = path.join(userDir, `${name}.service.bak`);
        if (
          await fs.readFile(backupPath, "utf8").then(
            () => true,
            () => false,
          )
        ) {
          push({
            platform: "linux",
            label,
            detail: `unit backup: ${backupPath}`,
            sourcePath: backupPath,
            scope: "user",
            marker: "clawdbot",
            legacy: true,
          });
        }
      }
      if (opts.deep) {
        for (const dir of [
          "/etc/systemd/system",
          "/usr/lib/systemd/system",
          "/lib/systemd/system",
        ]) {
          for (const svc of await scanSystemdDir({
            dir,
            scope: "system",
            includeManagedOpenClaw: opts.includeManagedOpenClaw,
            includeNode: opts.includeNode,
            selectedName: resolveSystemdServiceName(env),
            errors,
            deadline,
          })) {
            push(svc);
          }
        }
      }
    } catch (error) {
      rethrowInspectionAuthorityFailure(error);
      errors.push({ source: "systemd", message: "Gateway service discovery could not finish." });
    }
    if (opts.includeLoaded) {
      for (const scope of opts.deep ? (["user", "system"] as const) : (["user"] as const)) {
        if (!(await isSystemdManagerAbsent({ ...process.env, ...env }, scope))) {
          await scanLoadedSystemdServices(
            env,
            scope,
            opts.includeNode === true,
            inventory,
            deadline ?? performance.now() + 5_000,
          );
        }
      }
    }
    return inventory;
  }

  if (process.platform === "win32") {
    await scanWindowsGatewayServices(env, opts, errors, push);
  }

  return inventory;
}

export async function findGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions & {
    /** Shared-installation inventory only; Doctor retains its existing diagnostic scope. */
    includeNode?: boolean;
    includeLoaded?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<GatewayServiceInventory> {
  return await scanGatewayServices(env, { ...opts, includeManagedOpenClaw: true });
}

export async function findExtraGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions = {},
): Promise<ExtraGatewayService[]> {
  return (await scanGatewayServices(env, { ...opts, includeNode: false, includeLoaded: false }))
    .services;
}
