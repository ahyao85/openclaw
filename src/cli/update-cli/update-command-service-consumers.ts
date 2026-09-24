import path from "node:path";
import { findGatewayServices, type ExtraGatewayService } from "../../daemon/inspect.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveLaunchAgentGuiDomain } from "../../daemon/launchd-runtime.js";
import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import {
  findServiceOwnershipRefusal,
  isServiceInspectionControlFailure,
} from "../../daemon/service-inspection-error.js";
import {
  inspectServicePublicationConsumers,
  inspectServiceConsumerFootprint,
  serviceConsumerInventoryKey,
} from "../../daemon/service-publication-consumers.js";
import {
  inspectServicePublicationFootprint,
  servicePublicationFootprintsOverlap,
} from "../../daemon/service-publication-footprint.js";
import type { GatewayServiceEnv, GatewayServiceState } from "../../daemon/service-types.js";
import { parkForegroundUpdateHandoff } from "../../infra/update-managed-service-handoff.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";

type SelectedConsumer = Parameters<typeof inspectServicePublicationConsumers>[0]["selected"];

function selectedConsumer(state?: GatewayServiceState): SelectedConsumer {
  const command = state?.command;
  const sourcePath = command?.sourcePath;
  if (!state || !command || !sourcePath) {
    return undefined;
  }
  const service = { sourcePath, detail: "selected service" };
  if (process.platform === "linux") {
    const installation = state.systemdInstallation;
    const target =
      installation?.kind === "user"
        ? installation.user
        : installation?.kind === "system"
          ? installation.system
          : undefined;
    const scope = target?.scope ?? state.runtime?.systemd?.scope;
    const label = target?.unitName ?? state.runtime?.systemd?.unit;
    if (!scope || !label || (target && target.unitPath !== sourcePath)) {
      return undefined;
    }
    return {
      service: { ...service, platform: "linux", scope, label },
      command,
    };
  }
  if (process.platform === "darwin") {
    return {
      service: {
        ...service,
        platform: "darwin",
        scope: sourcePath.startsWith("/Library/LaunchDaemons/") ? "system" : "user",
        launchdDomain: sourcePath.startsWith("/Library/LaunchDaemons/")
          ? "system"
          : resolveLaunchAgentGuiDomain(),
        label: resolveLaunchAgentLabel(state.env),
      },
      command,
    };
  }
  if (process.platform === "win32") {
    return {
      service: {
        ...service,
        platform: "win32",
        scope: "system",
        label: resolveTaskName(state.env),
      },
      command,
      ...(state.runtime?.status === "running"
        ? { windowsProcesses: state.runtime.windowsProcesses }
        : {}),
    };
  }
  return undefined;
}

/** Observations enforce stop-first; operators keep sibling services stopped until completion. */
export async function prepareUpdateServiceConsumers(params: {
  roots: readonly string[];
  mode: "whole-package" | "runtime-artifacts";
  outputPaths?: readonly string[];
  env: GatewayServiceEnv;
  selectedState?: GatewayServiceState;
  assertCurrent: () => void;
  timeoutMs: number;
  warn: (message: string) => void;
  readParkedForegroundPid?: () => Promise<number>;
}) {
  const { assertCurrent, mode, timeoutMs } = params;
  const env = { ...params.env };
  const outputPaths = params.outputPaths && [...params.outputPaths];
  const roots = [...new Set(params.roots.map((root) => path.resolve(root)))];
  const initialSelected = structuredClone(selectedConsumer(params.selectedState));
  let knownWindowsProcesses = initialSelected?.windowsProcesses;
  let knownOverlappingConsumers = new Set<string>();
  const knownServices = new Map<string, ExtraGatewayService>();
  const readTargets = () =>
    Promise.all(
      roots.map((root) =>
        inspectServicePublicationFootprint(root, assertCurrent, true, outputPaths),
      ),
    );
  assertCurrent();
  const initialTargets = await readTargets();
  assertCurrent();
  if (initialSelected && initialSelected.service.platform !== "win32") {
    const { service, command } = initialSelected;
    const key = serviceConsumerInventoryKey(service);
    knownServices.set(key, service);
    try {
      const serving = await inspectServiceConsumerFootprint(command, assertCurrent, outputPaths);
      assertCurrent();
      if (
        initialTargets.some((target) =>
          servicePublicationFootprintsOverlap(target, serving.footprint, {
            mode,
            entrypoint: serving.entrypoint,
          }),
        )
      ) {
        knownOverlappingConsumers.add(key);
      }
    } catch (error) {
      assertCurrent();
      if (isServiceInspectionControlFailure(error)) {
        throw findServiceOwnershipRefusal(error) ?? error;
      }
      params.warn(
        "Selected service installation overlap could not be inspected; its verified service owner still controls shutdown and restart.",
      );
    }
  }
  const inspect = async (
    targets: typeof initialTargets,
    selected: SelectedConsumer,
    warn: (message: string) => void,
  ) => {
    const deadline = performance.now() + timeoutMs;
    const inventory = await findGatewayServices(env, {
      deep: true,
      includeNode: true,
      includeLoaded: true,
      timeoutMs: Math.max(0, deadline - performance.now()),
    });
    assertCurrent();
    const currentServices = new Map<string, ExtraGatewayService>();
    for (const service of inventory.services) {
      if (
        service.platform === "win32" ||
        (service.sourcePath && path.isAbsolute(service.sourcePath)) ||
        service.launchdDomain
      ) {
        currentServices.set(serviceConsumerInventoryKey(service), service);
      }
    }
    // Earlier associations require fresh native inspection even if discovery loses their metadata.
    const retained = [...knownServices].filter(([key]) => !currentServices.has(key));
    const delegated =
      selected &&
      selected.service.platform !== "win32" &&
      !currentServices.has(serviceConsumerInventoryKey(selected.service))
        ? undefined
        : selected;
    const result = await inspectServicePublicationConsumers({
      inventory: {
        ...inventory,
        services: [...inventory.services, ...retained.map(([, service]) => service)],
      },
      targets,
      mode,
      outputPaths,
      env,
      selected: delegated,
      knownWindowsProcesses,
      knownOverlappingConsumers,
      readParkedForegroundPid: params.readParkedForegroundPid,
      assertCurrent,
      timeoutMs: Math.max(0, deadline - performance.now()),
    });
    assertCurrent();
    for (const warning of result.warnings) {
      warn(`${warning.source}: ${warning.message}`);
    }
    if (result.blockers.length) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        result.blockers.map((blocker) => `${blocker.source}: ${blocker.message}`).join("\n"),
      );
    }
    knownWindowsProcesses = result.windowsProcesses ?? knownWindowsProcesses;
    knownOverlappingConsumers = result.overlappingConsumers;
    for (const [key, service] of currentServices) {
      knownServices.set(key, structuredClone(service));
    }
  };
  await inspect(initialTargets, initialSelected, params.warn);
  return {
    // Delegation lasts for this check only; its caller must inspect the selected owner.
    async revalidate(options: {
      selectedState?: GatewayServiceState;
      warn: (message: string) => void;
    }) {
      const selected = structuredClone(selectedConsumer(options.selectedState));
      assertCurrent();
      // Publication can replace a root inode; retain its initial overlap while checking current facts.
      const targets = await readTargets();
      assertCurrent();
      await inspect([...initialTargets, ...targets], selected, options.warn);
    },
  };
}

export function createUpdateServiceConsumerChecks(
  params: {
    root: string;
    mutationRoots: readonly string[];
    opts: Pick<UpdateCommandOptions, "run">;
    updateStepTimeoutMs: number;
  },
  assertCurrent: () => void,
) {
  const roots = [
    ...new Set([...params.mutationRoots, params.root].map((root) => path.resolve(root))),
  ].toSorted();
  let prepared: Awaited<ReturnType<typeof prepareUpdateServiceConsumers>> | undefined;
  return {
    async prepare(
      phase: "inspect" | "prepare",
      selectedState: GatewayServiceState | undefined,
      warn: (message: string) => void,
    ) {
      assertCurrent();
      const run = params.opts.run;
      // Keep read-only observations across handoff; every use checks the caller's current authority.
      if (!prepared) {
        const observed = await prepareUpdateServiceConsumers({
          roots,
          mode: "whole-package",
          env: run?.env ?? process.env,
          selectedState,
          assertCurrent,
          timeoutMs: params.updateStepTimeoutMs,
          warn,
          readParkedForegroundPid:
            run?.completionOwner === "gateway-restart"
              ? () => parkForegroundUpdateHandoff({ root: params.root, run })
              : undefined,
        });
        assertCurrent();
        prepared = observed;
      } else if (phase === "inspect") {
        await prepared.revalidate({
          selectedState,
          warn,
        });
      }
      assertCurrent();
      if (phase !== "inspect") {
        if (!params.opts.run?.executorFence) {
          throw new UpdatePreMutationError(
            "managed-service-preflight",
            "Mutable update preparation requires its current admitted executor.",
          );
        }
        await prepared.revalidate({
          selectedState,
          warn,
        });
        assertCurrent();
      }
    },
  };
}
