import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { resolvePositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { classifyOpenClawArgv } from "../infra/gateway-process-argv.js";
import { parseTcpPortFromArgs } from "../infra/tcp-port.js";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { WindowsServiceObservationChangedError } from "./schtasks-state-probe.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import type { GatewayServiceEnv } from "./service-types.js";
import {
  readWindowsTaskSupervisorRestartExitCode,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "./windows-task-supervisor-contract.js";

type WindowsProcessSnapshotEntry = {
  ProcessId?: number;
  ParentProcessId?: number;
  CreationDate?: string | null;
  Name?: string | null;
  CommandLine?: string | null;
};

export type WindowsServiceProcess = {
  pid: number;
  parentPid: number | undefined;
  /** Native .NET ticks retain creation identity below millisecond precision. */
  startedAt: string;
  programArguments: string[];
};

/** Readable argv can identify overlap without granting a process incarnation. */
type WindowsServiceProcessCandidate = {
  pid?: number;
  programArguments: string[];
  detail: string;
};

type WindowsServiceProcessConsumers = {
  processes: WindowsServiceProcess[];
  unavailable: WindowsServiceProcessCandidate[];
};

/** One native observation supplies current commands; disk launchers do not identify live consumers. */
export function readWindowsServiceProcessObservation(env: GatewayServiceEnv, timeoutMs = 5_000) {
  const budget = resolvePositiveTimerTimeoutMs(timeoutMs, 5_000);
  const deadline = performance.now() + budget;
  const snapshot = readWindowsProcessSnapshot(budget, env);
  if (!snapshot) {
    return null;
  }
  const rows = new Map(snapshot.map((entry) => [getSnapshotProcessId(entry), entry]));
  const retained = new Map<number, WindowsProcessSnapshotEntry>();
  const facts = new Map<number, WindowsServiceProcess>();
  const birth = (entry: WindowsProcessSnapshotEntry) => {
    const value = entry.CreationDate;
    if (typeof value !== "string" || !/^[1-9]\d{0,18}$/u.test(value)) {
      throw new Error("Identified Windows service process has no verifiable birth identity.");
    }
    return value;
  };
  const readEntry = (pid: number) => {
    const entry = rows.get(pid);
    if (!entry) {
      return undefined;
    }
    if (snapshot.filter((candidate) => candidate.ProcessId === pid).length !== 1) {
      throw new Error("Identified Windows service process is no longer observable.");
    }
    birth(entry);
    return entry;
  };
  const retain = (pid: number) => {
    const entry = readEntry(pid);
    if (!entry) {
      throw new Error("Identified Windows service process is no longer observable.");
    }
    retained.set(pid, entry);
    return entry;
  };
  const readProcess = (pid: number): WindowsServiceProcess => {
    const cached = facts.get(pid);
    if (cached) {
      return cached;
    }
    const entry = retain(pid);
    if (!entry.CommandLine) {
      throw new Error("Identified Windows service process has no readable current command.");
    }
    const value = {
      pid,
      parentPid: entry.ParentProcessId,
      startedAt: birth(entry),
      programArguments: splitArgsPreservingQuotes(entry.CommandLine, {
        escapeMode: "backslash-quote-only",
      }),
    };
    facts.set(pid, value);
    return value;
  };
  const family = (pid: number): WindowsServiceProcess[] => {
    const child = readProcess(pid);
    const result = [child];
    if (readWindowsTaskSupervisorRestartExitCode(child.programArguments) === undefined) {
      return result;
    }
    const supervisor = [...child.programArguments.slice(0, -1), WINDOWS_TASK_SUPERVISOR_FLAG];
    const seen = new Set([pid]);
    const ancestry: number[] = [];
    let current = retain(pid);
    for (let depth = 0; depth < 32; depth++) {
      const parentPid = current.ParentProcessId;
      if (!parentPid || seen.has(parentPid)) {
        break;
      }
      const parent = rows.get(parentPid);
      if (
        !parent ||
        typeof parent.CreationDate !== "string" ||
        !/^[1-9]\d{0,18}$/u.test(parent.CreationDate) ||
        BigInt(parent.CreationDate) > BigInt(birth(current))
      ) {
        break;
      }
      ancestry.push(parentPid);
      seen.add(parentPid);
      if (
        parent.CommandLine &&
        matchesInstalledProgramArguments(
          splitArgsPreservingQuotes(parent.CommandLine, { escapeMode: "backslash-quote-only" }),
          supervisor,
        )
      ) {
        for (const ancestorPid of ancestry) {
          retain(ancestorPid);
        }
        result.push(readProcess(parentPid));
        break;
      }
      current = parent;
    }
    return result;
  };
  const installedCommands: string[][] = [];
  const eligible = (entries: WindowsProcessSnapshotEntry[]) =>
    entries
      .filter((entry) => {
        // An opaque generic runtime is not positive OpenClaw association.
        if (!entry.CommandLine || entry.ProcessId === process.pid) {
          return false;
        }
        const argv = splitArgsPreservingQuotes(entry.CommandLine, {
          escapeMode: "backslash-quote-only",
        });
        return (
          classifyOpenClawArgv(argv, { command: "gateway" }).kind === "openclaw" ||
          (isNodeHostArgv(argv) &&
            classifyOpenClawArgv(argv, { command: "node" }).kind === "openclaw") ||
          installedCommands.some((installed) => matchesWindowsServiceProcess(argv, installed))
        );
      })
      .toSorted((left, right) => (left.ProcessId ?? 0) - (right.ProcessId ?? 0));
  let consumers: WindowsServiceProcessConsumers | undefined;
  return {
    includeInstalled(programArguments: string[]) {
      installedCommands.push([...programArguments]);
      consumers = undefined;
    },
    readKnown({ pid, startedAt }: Pick<WindowsServiceProcess, "pid" | "startedAt">) {
      const entry = readEntry(pid);
      return entry && entry.CreationDate === startedAt ? readProcess(pid) : undefined;
    },
    readConsumers(): WindowsServiceProcessConsumers {
      if (consumers) {
        return consumers;
      }
      const processes: WindowsServiceProcess[] = [];
      const unavailable: WindowsServiceProcessCandidate[] = [];
      for (const entry of eligible(snapshot)) {
        const pid = getSnapshotProcessId(entry);
        try {
          if (!pid || !Number.isSafeInteger(pid)) {
            throw new Error("Identified Windows service process has no valid PID.");
          }
          processes.push(readProcess(pid));
        } catch (error) {
          unavailable.push({
            ...(pid && Number.isSafeInteger(pid) ? { pid } : {}),
            programArguments: splitArgsPreservingQuotes(entry.CommandLine ?? "", {
              escapeMode: "backslash-quote-only",
            }),
            detail:
              error instanceof Error ? error.message : "Windows process identity is unavailable.",
          });
        }
      }
      consumers = { processes, unavailable };
      return consumers;
    },
    family,
    findInstalled(port: number | null, argv: string[], nodeHost = false, expectedPid?: number) {
      const entries =
        expectedPid === undefined
          ? snapshot
          : snapshot.filter((entry) => entry.ProcessId === expectedPid);
      const pid = nodeHost
        ? findInstalledProcessPid(entries, port, argv, isNodeHostArgv)
        : (findInstalledGatewayChildPid(entries, port, argv) ??
          findInstalledProcessPid(
            entries,
            port,
            [...argv, WINDOWS_TASK_SUPERVISOR_FLAG],
            () => true,
          ));
      return pid ? family(pid) : [];
    },
    verify(pid?: number) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error("Windows service process inspection timed out.");
      }
      const current = readWindowsProcessSnapshot(remaining, env);
      if (!current) {
        throw new Error("Windows service process inspection is unavailable.");
      }
      const expected = pid === undefined ? [...retained] : [[pid, retain(pid)] as const];
      if (
        (pid === undefined &&
          consumers &&
          !isDeepStrictEqual(eligible(snapshot), eligible(current))) ||
        expected.some(([expectedPid, entry]) => {
          const matches = current.filter((candidate) => candidate.ProcessId === expectedPid);
          return matches.length !== 1 || !isDeepStrictEqual(entry, matches[0]);
        })
      ) {
        throw new WindowsServiceObservationChangedError(
          "Windows service process changed during inspection.",
        );
      }
    },
  };
}

export type WindowsServiceProcessObservation = NonNullable<
  ReturnType<typeof readWindowsServiceProcessObservation>
>;

export function isNodeHostArgv(programArguments: string[]): boolean {
  const normalized = normalizeProgramArguments(programArguments);
  return normalized.some((arg, index) => arg === "node" && normalized[index + 1] === "run");
}

function normalizeProgramArguments(programArguments: string[]): string[] {
  return programArguments.map((arg) => normalizeLowercaseStringOrEmpty(arg.replaceAll("\\", "/")));
}

export function matchesInstalledProgramArguments(
  actualArguments: string[],
  installedArguments: string[],
): boolean {
  const actual = normalizeProgramArguments(actualArguments);
  const installed = normalizeProgramArguments(installedArguments);
  return (
    actual.length === installed.length && actual.every((arg, index) => arg === installed[index])
  );
}

export function getSnapshotProcessId(entry: WindowsProcessSnapshotEntry): number | null {
  const pid = entry.ProcessId;
  return typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function matchesWindowsServiceProcess(
  programArguments: string[],
  installedArguments: string[],
): boolean {
  return (
    matchesInstalledProgramArguments(programArguments, installedArguments) ||
    matchesInstalledGatewayChildArguments(programArguments, installedArguments) ||
    matchesInstalledProgramArguments(programArguments, [
      ...installedArguments,
      WINDOWS_TASK_SUPERVISOR_FLAG,
    ])
  );
}

export function findInstalledProcessPid(
  entries: WindowsProcessSnapshotEntry[],
  port: number | null,
  installedArguments: string[],
  matchesProcess: (argv: string[]) => boolean,
  comparableArguments: (argv: string[]) => string[] = (argv) => argv,
): number | null {
  for (const entry of entries) {
    const commandLine = normalizeLowercaseStringOrEmpty(entry.CommandLine ?? "");
    if (!commandLine) {
      continue;
    }
    const argv = splitArgsPreservingQuotes(entry.CommandLine ?? "", {
      escapeMode: "backslash-quote-only",
    });
    if (
      !matchesProcess(argv) ||
      (port !== null && parseTcpPortFromArgs(argv) !== port) ||
      !matchesInstalledProgramArguments(comparableArguments(argv), installedArguments)
    ) {
      continue;
    }
    const pid = getSnapshotProcessId(entry);
    if (pid) {
      return pid;
    }
  }
  return null;
}

function matchesInstalledGatewayChildArguments(
  actualArguments: string[],
  installedArguments: string[],
): boolean {
  return (
    readWindowsTaskSupervisorRestartExitCode(actualArguments) !== undefined &&
    matchesInstalledProgramArguments(actualArguments.slice(0, -1), installedArguments)
  );
}

/** Finds the current supervised child or a legacy directly launched Gateway. */
export function findInstalledGatewayChildPid(
  entries: WindowsProcessSnapshotEntry[],
  port: number | null,
  installedArguments: string[],
): number | null {
  return (
    findInstalledProcessPid(
      entries,
      port,
      installedArguments,
      (argv) => matchesInstalledGatewayChildArguments(argv, installedArguments),
      (argv) => argv.slice(0, -1),
    ) ?? findInstalledProcessPid(entries, port, installedArguments, () => true)
  );
}

export function readWindowsProcessSnapshot(
  timeoutMs = 5_000,
  env?: GatewayServiceEnv,
): WindowsProcessSnapshotEntry[] | null {
  if (process.platform !== "win32") {
    return null;
  }
  const processSnapshot = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-Command",
      [
        "$ErrorActionPreference='Stop'",
        "$json = Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,CommandLine,Name,@{Name='CreationDate';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().Ticks.ToString()}}} | ConvertTo-Json -Compress",
        "$bytes = [Text.Encoding]::UTF8.GetBytes($json)",
        // Write pipe bytes directly: OutputEncoding calls SetConsoleOutputCP without a console.
        "[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)",
      ].join("; "),
    ],
    {
      env: resolveServiceManagerEnv(env),
      encoding: "utf8",
      timeout: resolvePositiveTimerTimeoutMs(timeoutMs, 5_000),
      windowsHide: true,
    },
  );
  if (processSnapshot.error || processSnapshot.status !== 0) {
    return null;
  }
  let parsedSnapshot: unknown;
  try {
    parsedSnapshot = JSON.parse(processSnapshot.stdout.trim() || "[]");
  } catch {
    return null;
  }
  const entries = (Array.isArray(parsedSnapshot) ? parsedSnapshot : [parsedSnapshot]).filter(
    (entry): entry is WindowsProcessSnapshotEntry => typeof entry === "object" && entry !== null,
  );
  // Healthy CIM includes PowerShell itself; empty output cannot prove target exit.
  return entries.length > 0 ? entries : null;
}
