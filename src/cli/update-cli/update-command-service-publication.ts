// Physical runtime publication remains part of the managed-service maintenance boundary.
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { resolveGatewayProfileSuffix } from "../../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import {
  isScheduledTaskDefinitelyNotRunning,
  readWindowsStartupFallbackRuntimeForUpdate,
} from "../../daemon/schtasks-runtime.js";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import {
  DEFAULT_SERVICE_PUBLICATION_OUTPUT_PATHS,
  inspectServicePublicationFootprint,
  inspectServicePublicationPath,
  servicePublicationFootprintsOverlap,
  servicePublicationPathChanged,
  type ServicePublicationPath,
} from "../../daemon/service-publication-footprint.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { isPathInside } from "../../infra/path-guards.js";
import { probePortUsage } from "../../infra/ports-probe.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { formatCliCommand } from "../command-format.js";
import { UpdatePreMutationError } from "./shared.js";
import { createGatewayMaintenanceWarningReporter } from "./update-command-result.js";
import { prepareUpdateServiceConsumers } from "./update-command-service-consumers.js";
import {
  observedSystemdManagerUid,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";

export async function isManagedGatewayServiceOffline(state: GatewayServiceState): Promise<boolean> {
  // Loaded LaunchAgents can respawn even while disabled. Windows needs the live
  // numeric task state; enabled systemd units may be manually stopped.
  return (
    state.runtime?.status === "stopped" &&
    (process.platform === "darwin"
      ? state.loadState.status === "not-loaded"
      : process.platform === "win32"
        ? isScheduledTaskDefinitelyNotRunning(resolveTaskName(state.env)) ||
          (await readWindowsStartupFallbackRuntimeForUpdate(state.env).catch(() => null))
            ?.status === "stopped"
        : process.platform === "linux")
  );
}

/** Changed runtime artifacts require an offline physical target, not logical
 * ownership of a deployment's current/releases namespace. No service is stopped here. */
export async function withGatewayRuntimeArtifactPublication<T>(
  params: {
    root: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    assertCurrent: () => void;
    outputPaths?: readonly string[];
  },
  publish: (assertPublicationCurrent: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const assertCaller = params.assertCurrent;
  assertCaller();
  return await withGatewayServiceOperationLock(params.env, async (assertNative) => {
    const assertCurrent = () => {
      assertCaller();
      assertNative();
    };
    const warn = createGatewayMaintenanceWarningReporter({ assertCurrent });
    const refuse = (cause?: unknown): never => {
      throw new UpdatePreMutationError(
        "runtime-artifact-publication",
        `Runtime artifacts changed, but the affected Gateway is running or its offline state could not be verified. Run \`${formatCliCommand("openclaw gateway status --deep", params.env)}\`, stop the affected Gateway with \`${formatCliCommand("openclaw gateway stop", params.env)}\`, and retry the update.`,
        { cause },
      );
    };
    const service = resolveGatewayService();
    const outputPaths = [...(params.outputPaths ?? DEFAULT_SERVICE_PUBLICATION_OUTPUT_PATHS)];
    const parentPaths = new Set([""]);
    for (const output of outputPaths) {
      for (let parent = path.dirname(output); parent !== "."; parent = path.dirname(parent)) {
        if (!outputPaths.some((replaced) => isPathInside(replaced, parent))) {
          parentPaths.add(parent);
        }
      }
    }
    const readInspection = async () => {
      assertCurrent();
      const target = await inspectServicePublicationFootprint(
        params.root,
        assertCurrent,
        false,
        outputPaths,
      );
      // Parents are stable across publication; output roots themselves are renamed.
      // Record missing descendants too, so creating them cannot redirect a later effect.
      const parents = await Promise.all(
        [...parentPaths].map(async (relative) =>
          relative
            ? inspectServicePublicationPath(path.join(params.root, relative), assertCurrent, true)
            : target.root,
        ),
      );
      assertCurrent();
      if (parents.some((parent) => parent.stat && !parent.stat.isDirectory())) {
        refuse();
      }
      const destinations = target.outputs;
      const state = await readGatewayServiceState(service, {
        env: params.env,
        requireEffective: true,
        requireLoadedCommand: true,
        timeoutMs: params.timeoutMs,
      });
      assertCurrent();
      const layout = await summarizeGatewayServiceLayout(state.command);
      assertCurrent();
      const database = await inspectServicePublicationPath(
        resolveOpenClawStateSqlitePath(state.env),
        assertCurrent,
        true,
      );
      assertCurrent();
      const serviceName =
        process.platform === "darwin"
          ? resolveLaunchAgentLabel(state.env)
          : process.platform === "win32"
            ? resolveTaskName(state.env)
            : resolveSystemdServiceName(state.env);
      const nativeIdentity = stableStringify({
        command: state.command,
        serviceName,
        profile: resolveGatewayProfileSuffix(state.env.OPENCLAW_PROFILE),
        managerUid: observedSystemdManagerUid(state),
      });
      let serving: { root: ServicePublicationPath; entrypoint: ServicePublicationPath } | undefined;
      let disjoint = false;
      if (layout?.packageRootReal && layout.entrypointReal) {
        const [installed, entrypoint] = await Promise.all([
          inspectServicePublicationFootprint(
            layout.packageRootReal,
            assertCurrent,
            false,
            outputPaths,
          ),
          inspectServicePublicationPath(layout.entrypointReal, assertCurrent, true),
        ]);
        assertCurrent();
        serving = { root: installed.root, entrypoint };
        disjoint = !servicePublicationFootprintsOverlap(target, installed, {
          mode: "runtime-artifacts",
          entrypoint,
        });
      } else if (
        state.command ||
        state.installed ||
        state.loadState.status !== "not-loaded" ||
        !state.runtime?.missingUnit
      ) {
        refuse();
      }
      const absent =
        !state.command &&
        !state.installed &&
        state.loadState.status === "not-loaded" &&
        state.runtime?.missingUnit === true;
      if (
        !disjoint &&
        (state.running ||
          (!absent &&
            (state.loadState.status === "unknown" ||
              (process.platform === "linux" && observedSystemdManagerUid(state) === undefined) ||
              !(await isManagedGatewayServiceOffline(state)))))
      ) {
        refuse();
      }
      assertCurrent();
      if (!disjoint) {
        const activeLock = await readActiveGatewayLockIdentity({
          env: state.env,
          requireInspection: true,
        });
        assertCurrent();
        if (activeLock) {
          refuse();
        }
        const port = await resolveUpdatedGatewayRestartPort({
          serviceEnv: state.env,
          serviceCommand: state.command,
        });
        assertCurrent();
        const usage = await probePortUsage(port);
        assertCurrent();
        if (usage !== "free") {
          refuse();
        }
      }
      return { state, disjoint, parents, destinations, database, nativeIdentity, serving };
    };
    const inspect = async () => {
      try {
        return await readInspection();
      } catch (error) {
        assertCurrent();
        if (error instanceof UpdatePreMutationError) {
          throw error;
        }
        return refuse(error);
      }
    };
    const before = await inspect();
    assertCurrent();
    if (before.serving && !before.serving.entrypoint.stat) {
      refuse();
    }
    const consumers = await prepareUpdateServiceConsumers({
      roots: [params.root],
      mode: "runtime-artifacts",
      outputPaths,
      env: params.env,
      selectedState: before.disjoint ? undefined : before.state,
      assertCurrent,
      timeoutMs: params.timeoutMs,
      warn,
    });
    assertCurrent();
    const assertPublicationCurrent = async () => {
      await consumers.revalidate({
        selectedState: before.disjoint ? undefined : before.state,
        warn,
      });
      assertCurrent();
      const current = await inspect();
      assertCurrent();
      if (
        before.disjoint !== current.disjoint ||
        before.database.real !== current.database.real ||
        before.nativeIdentity !== current.nativeIdentity ||
        before.parents.some((parent, index) =>
          servicePublicationPathChanged(parent, current.parents[index]!),
        ) ||
        before.destinations.some(
          (destination, index) => destination.real !== current.destinations[index]!.real,
        ) ||
        (before.serving &&
          (!current.serving ||
            servicePublicationPathChanged(before.serving.root, current.serving.root) ||
            before.serving.entrypoint.real !== current.serving.entrypoint.real ||
            (!before.destinations.some((destination) =>
              isPathInside(destination.real, current.serving!.entrypoint.real),
            ) &&
              servicePublicationPathChanged(
                before.serving.entrypoint,
                current.serving.entrypoint,
              ))))
      ) {
        refuse();
      }
      assertCurrent();
    };
    let coordinator: ReturnType<typeof acquireGatewayLifecycleCoordinator> | undefined;
    try {
      try {
        assertCurrent();
        if (!before.disjoint) {
          coordinator = acquireGatewayLifecycleCoordinator({
            databasePath: before.database.real,
            busyTimeoutMs: 0,
          });
        }
        await assertPublicationCurrent();
        assertCurrent();
      } catch (error) {
        assertCurrent();
        if (error instanceof UpdatePreMutationError) {
          throw error;
        }
        refuse(error);
      }
      assertCurrent();
      // The publisher joins its rollback before settling, keeping both exclusions held.
      const result = await publish(assertPublicationCurrent);
      assertCurrent();
      return result;
    } finally {
      coordinator?.release();
    }
  });
}
