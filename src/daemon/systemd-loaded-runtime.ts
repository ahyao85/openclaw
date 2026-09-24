// Admission reads already-loaded state. Recovery may load a bound definition
// under live custody; neither mode starts a unit or a bus service.
import { isDeepStrictEqual } from "node:util";
import {
  createServiceRuntimeInspectionFailure,
  type GatewayServiceRuntime,
} from "./service-runtime.js";
import type {
  GatewayServiceEnv,
  GatewayServiceUnitInspection,
  SystemdServiceReadBinding,
  SystemdServiceReadTarget,
} from "./service-types.js";
import { createSystemdCommandQuery } from "./systemd-command-query.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";
import { readSystemdUserTransport } from "./systemd-user-transport.js";

const MANAGER = "org.freedesktop.systemd1";
const isUint32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const isInt32 = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= -0x80000000 &&
  value <= 0x7fffffff;
const optionalCounter = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** The selected manager must retain the same loaded unit throughout inspection. */
export async function readLoadedSystemdServiceRuntime(
  env: GatewayServiceEnv,
  timeoutMs?: number,
  inspection?: GatewayServiceUnitInspection,
  binding?: SystemdServiceReadBinding,
  target?: SystemdServiceReadTarget,
): Promise<GatewayServiceRuntime> {
  const unitName = target?.unitName ?? `${resolveSystemdServiceName(env)}.service`;
  const scope = target?.scope ?? "user";
  const budget =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  const unavailable = () =>
    new Error("Loaded systemd runtime could not be inspected without activation.");
  try {
    const context = await createSystemdCommandQuery(
      env,
      unitName,
      {
        timeoutMs: budget,
        requireLoaded: true,
        loadForInspection: inspection,
        systemdReadBinding: binding,
        systemdReadTarget: target,
      },
      unavailable,
      "loaded-runtime",
    );
    try {
      const { query, binding: manager } = context;
      if (!manager || !isUint32(manager.managerUid) || manager.managerUid === 0xffffffff) {
        throw unavailable();
      }
      const { destination: owner, managerUid } = manager;
      const [unit] =
        (await query(
          [
            "call",
            owner,
            "/org/freedesktop/systemd1",
            `${MANAGER}.Manager`,
            inspection ? "LoadUnit" : "GetUnit",
            "s",
            unitName,
          ],
          ["o"],
        )) ?? [];
      if (
        !Array.isArray(unit) ||
        unit.length !== 1 ||
        typeof unit[0] !== "string" ||
        !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(unit[0])
      ) {
        throw unavailable();
      }
      const unitPath = unit[0];
      const readUnit = () =>
        query(
          [
            "get-property",
            owner,
            unitPath,
            `${MANAGER}.Unit`,
            "Id",
            "LoadState",
            "ActiveState",
            "SubState",
            "StartLimitBurst",
            "ActiveEnterTimestampMonotonic",
            "InactiveEnterTimestampMonotonic",
          ],
          ["s", "s", "s", "s", "u", "t", "t"],
        );
      const before = (await readUnit()) ?? [];
      const [id, load, active, sub, burst, entered, left] = before;
      const [result, restarts, pid, exitStatus, exitCode, killMode, tasks, memory] =
        (await query(
          [
            "get-property",
            owner,
            unitPath,
            `${MANAGER}.Service`,
            "Result",
            "NRestarts",
            "MainPID",
            "ExecMainStatus",
            "ExecMainCode",
            "KillMode",
            "TasksCurrent",
            "MemoryCurrent",
          ],
          ["s", "u", "u", "i", "i", "s", "t", "t"],
        )) ?? [];
      let drained = optionalCounter(tasks) === 0;
      if (
        (active === "inactive" || active === "failed") &&
        pid === 0 &&
        optionalCounter(tasks) === undefined
      ) {
        // TasksCurrent is UINT64_MAX when accounting is unavailable, not zero.
        // Ask the pinned manager for descendants and main/control PIDs instead.
        // Admission never loads. Owned inspection uses the unit-object method so
        // collection between queries can reload a definition, never start a process.
        // GetProcesses belongs to the Service cgroup interface, not Unit.
        // Any failed or nonempty enumeration remains unknown.
        const [processes] =
          (await query(
            inspection
              ? ["call", owner, unitPath, `${MANAGER}.Service`, "GetProcesses"]
              : [
                  "call",
                  owner,
                  "/org/freedesktop/systemd1",
                  `${MANAGER}.Manager`,
                  "GetUnitProcesses",
                  "s",
                  unitName,
                ],
            ["a(sus)"],
          )) ?? [];
        drained =
          Array.isArray(processes) &&
          processes.length === 1 &&
          Array.isArray(processes[0]) &&
          processes[0].length === 0;
      }
      // Same manager identity alone does not exclude unit restart/state changes.
      // Compare native transition generations as well as state to reject ABA observations.
      const after = await readUnit();
      await manager.verify();
      if (
        !isDeepStrictEqual(before, after) ||
        optionalCounter(entered) === undefined ||
        optionalCounter(left) === undefined ||
        id !== unitName ||
        load !== "loaded" ||
        typeof active !== "string" ||
        typeof sub !== "string" ||
        !isUint32(burst) ||
        typeof result !== "string" ||
        !isUint32(restarts) ||
        !isUint32(pid) ||
        !isInt32(exitStatus) ||
        !isInt32(exitCode) ||
        typeof killMode !== "string"
      ) {
        throw unavailable();
      }
      return {
        status:
          active === "active"
            ? "running"
            : (active === "inactive" || active === "failed") && pid === 0 && drained
              ? "stopped"
              : "unknown",
        state: active,
        subState: sub,
        pid: pid > 0 ? pid : undefined,
        lastExitStatus: exitStatus,
        lastExitReason: [
          undefined,
          "exited",
          "killed",
          "dumped",
          "trapped",
          "stopped",
          "continued",
        ][exitCode],
        systemd: {
          scope,
          ...(scope === "user" ? { transport: await readSystemdUserTransport(env) } : {}),
          unit: id,
          managerUid,
          result,
          nRestarts: restarts,
          startLimitBurst: burst,
          killMode,
          tasksCurrent: optionalCounter(tasks),
          memoryCurrent: optionalCounter(memory),
        },
      };
    } finally {
      await context.close();
    }
  } catch (error) {
    return createServiceRuntimeInspectionFailure(error);
  }
}
