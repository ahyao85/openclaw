/** Recognizes service execution evidence without assigning lifecycle ownership. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { isWindowsBatchScriptPath } from "./cmd-argv.js";
import { parseCmdSetAssignment } from "./cmd-set.js";
import { GATEWAY_SERVICE_KIND, GATEWAY_SERVICE_MARKER, NODE_SERVICE_KIND } from "./constants.js";
import { isNodeHostArgv } from "./schtasks-process-inspection.js";
import {
  parseSystemdEnvAssignments,
  parseSystemdExecStart,
  splitSystemdLogicalLines,
} from "./systemd-unit.js";

export const EXTRA_MARKERS = ["openclaw", "clawdbot"] as const;

export type Marker = (typeof EXTRA_MARKERS)[number];

function hasGatewaySubcommandArg(args: string[]): boolean {
  return args.some((arg) => /(^|\s)gateway(\s|$)/.test(normalizeLowercaseStringOrEmpty(arg)));
}

export function detectMarkerLineWithService(contents: string, includeNode = false): Marker | null {
  // Use the same physical-comment rules as service rewrites; comments must not
  // hide a runnable extra service from diagnostics.
  for (const line of splitSystemdLogicalLines(contents)) {
    const trimmed = normalizeLowercaseStringOrEmpty(line);
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const assignment = trimmed.indexOf("=");
    const nodeCommand =
      includeNode &&
      isNodeHostArgv(
        assignment > 0
          ? parseSystemdExecStart(trimmed.slice(assignment + 1).trim())
          : splitArgsPreservingQuotes(trimmed),
      );
    if (assignment > 0) {
      const key = trimmed.slice(0, assignment).trim();
      if (
        key !== "execstart" ||
        (!hasGatewaySubcommandArg(parseSystemdExecStart(trimmed.slice(assignment + 1).trim())) &&
          !nodeCommand)
      ) {
        continue;
      }
    }
    if (!trimmed.includes("gateway") && !nodeCommand) {
      continue;
    }
    for (const marker of EXTRA_MARKERS) {
      if (trimmed.includes(marker)) {
        return marker;
      }
    }
  }
  return null;
}

export function hasServiceMarker(environment: unknown, includeNode = false): boolean {
  const values = asOptionalRecord(environment);
  return (
    values?.OPENCLAW_SERVICE_MARKER === GATEWAY_SERVICE_MARKER &&
    (values.OPENCLAW_SERVICE_KIND === GATEWAY_SERVICE_KIND ||
      (includeNode && values.OPENCLAW_SERVICE_KIND === NODE_SERVICE_KIND))
  );
}

export function hasSystemdServiceMarker(content: string, includeNode = false): boolean {
  let environment: Record<string, string> = {};
  let service = false;
  for (const rawLine of splitSystemdLogicalLines(content)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      service = line === "[Service]";
      continue;
    }
    const assignment = service && /^Environment\s*=(.*)$/.exec(line);
    if (!assignment) {
      continue;
    }
    const assignmentText = assignment[1]!.trim();
    if (!assignmentText) {
      environment = {};
    } else {
      for (const { key, value } of parseSystemdEnvAssignments(assignmentText)) {
        environment[key] = value;
      }
    }
  }
  return hasServiceMarker(environment, includeNode);
}

export function hasCmdServiceMarker(content: string, includeNode = false): boolean {
  const environment: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const command = /^@?[ \t]*set[ \t]+(.*)$/i.exec(rawLine.trimStart());
    if (!command) {
      continue;
    }
    const assignment = parseCmdSetAssignment(command[1]!, true);
    if (assignment) {
      environment[assignment.key] = assignment.value;
    }
  }
  return hasServiceMarker(environment, includeNode);
}

export function detectCommandExecutionMarker(
  programArguments: string[],
  program?: string,
  includeNode = false,
): Marker | null {
  if (
    !hasGatewaySubcommandArg(programArguments) &&
    !(includeNode && isNodeHostArgv(programArguments))
  ) {
    return null;
  }
  // Only execution command fields identify service jobs; labels alone catch too
  // many unrelated helper jobs.
  const launchCommand = normalizeLowercaseStringOrEmpty(
    [program ?? "", ...programArguments].join("\n"),
  );
  return EXTRA_MARKERS.find((marker) => launchCommand.includes(marker)) ?? null;
}

// Keep recognizable failed launchers in inventory errors without inferring a parsed command.
export function detectLauncherServiceMarker(contents: string, includeNode = false): Marker | null {
  for (const line of contents.split(/\r?\n/)) {
    const command = normalizeLowercaseStringOrEmpty(line);
    const nodeLauncher =
      includeNode &&
      (isNodeHostArgv(splitArgsPreservingQuotes(command)) ||
        /(?:^|\s)node\s+run(?:\s|["']|$)/.test(command) ||
        (command.match(/(?:^|[\\/])node(?:-host-launcher)?\.[a-z0-9]+(?=$|[\s"'])/g) ?? []).some(
          (reference) => isWindowsBatchScriptPath(reference) || /\.(?:vbs|mjs)$/.test(reference),
        ));
    if (
      command.startsWith("#") ||
      command.startsWith(";") ||
      (!command.includes("gateway") && !nodeLauncher)
    ) {
      continue;
    }
    const marker = EXTRA_MARKERS.find((candidate) => command.includes(candidate));
    if (marker) {
      return marker;
    }
  }
  return null;
}
