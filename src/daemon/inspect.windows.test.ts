import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findExtraGatewayServices, findGatewayServices } from "./inspect.js";
import * as taskLayout from "./schtasks-layout.js";
import * as taskProbe from "./schtasks-state-probe.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;
  let nativeEnv: { APPDATA: string };
  const task = (taskPath: string, actionPath: string, args = "") => ({
    taskPath,
    state: 3,
    actions: [{ type: 0, path: actionPath, arguments: args, workingDirectory: "" }],
  });

  beforeEach(() => {
    nativeEnv = { APPDATA: tempDirs.make("openclaw-windows-inventory-") };
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.spyOn(taskProbe, "listScheduledTasks").mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("skips native queries unless deep mode is enabled", async () => {
    expect(await findExtraGatewayServices({})).toEqual([]);
    expect(taskProbe.listScheduledTasks).not.toHaveBeenCalled();
  });

  it.each(["query denied", "missing executable"])(
    "exposes inventory query failure: %s",
    async (failure) => {
      vi.mocked(taskProbe.listScheduledTasks).mockImplementation(() => {
        throw new Error(failure);
      });
      expect(await findExtraGatewayServices(nativeEnv, { deep: true })).toEqual([]);
      expect(await findGatewayServices(nativeEnv)).toEqual({
        services: [],
        errors: [{ source: "schtasks", message: expect.any(String) }],
      });
    },
  );

  it("collects only non-managed marker tasks from native metadata", async () => {
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
      task("\\OpenClaw Gateway", "C:\\Program Files\\OpenClaw\\openclaw.exe", "gateway run"),
      task("Clawdbot Legacy", "C:\\clawdbot\\clawdbot.exe", "run"),
      task("Other Task", "C:\\tools\\helper.exe"),
    ]);
    expect(await findExtraGatewayServices(nativeEnv, { deep: true })).toEqual([
      {
        platform: "win32",
        label: "Clawdbot Legacy",
        detail: "task: Clawdbot Legacy, run: C:\\clawdbot\\clawdbot.exe run",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it("keeps Node helpers in diagnostics while inventorying only Gateway candidates", async () => {
    const gatewayPath = "C:\\Program Files\\OpenClaw\\openclaw.exe";
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
      task("\\OpenClaw Gateway", gatewayPath, "gateway run"),
      task("\\OpenClaw Gateway (dev)", gatewayPath, "gateway run --profile dev"),
      task("\\OpenClaw Gateway Backup", gatewayPath, "gateway run"),
      task("\\OpenClaw Node", "C:\\Users\\test\\.openclaw\\node.vbs"),
    ]);
    vi.spyOn(taskLayout, "readRegisteredScheduledTaskCommand").mockResolvedValue({
      command: {
        programArguments: ["node", "openclaw.mjs", "node", "run"],
        environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "node" },
      },
      state: 3,
    });
    const extras = await findExtraGatewayServices(nativeEnv, { deep: true });
    expect(extras).toEqual([
      {
        platform: "win32",
        label: "\\OpenClaw Gateway Backup",
        detail: `task: \\OpenClaw Gateway Backup, run: ${gatewayPath} gateway run`,
        scope: "system",
        marker: "openclaw",
        legacy: false,
      },
      {
        platform: "win32",
        label: "\\OpenClaw Node",
        detail: "task: \\OpenClaw Node, run: C:\\Users\\test\\.openclaw\\node.vbs",
        scope: "system",
        marker: "openclaw",
        legacy: false,
      },
    ]);
    const inventory = await findGatewayServices(nativeEnv);
    expect(inventory.errors).toEqual([]);
    expect(inventory.services.map((service) => service.label)).toEqual([
      "\\OpenClaw Gateway",
      "\\OpenClaw Gateway (dev)",
      "\\OpenClaw Gateway Backup",
    ]);
    const withNodes = await findGatewayServices(nativeEnv, { includeNode: true });
    expect(withNodes.errors).toEqual([]);
    expect(withNodes.services.map((service) => service.label)).toEqual([
      ...inventory.services.map((service) => service.label),
      "\\OpenClaw Node",
    ]);
  });

  it.each([
    {
      name: "registered Node command",
      executable: "C:\\Apps\\openclaw.exe",
      args: "node run --host=example.invalid",
      expected: true,
    },
    {
      name: "Node status",
      executable: "C:\\Apps\\openclaw.exe",
      args: "node status",
      expected: false,
    },
    {
      name: "runtime executable only",
      executable: "C:\\Node\\node.exe",
      args: "C:\\Other\\worker.js",
      expected: false,
    },
  ])(
    "includes $name only by command evidence and opt-in",
    async ({ executable, args, expected }) => {
      const name = "\\OpenClaw Node";
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([task(name, executable, args)]);
      expect(await findGatewayServices(nativeEnv)).toEqual({ services: [], errors: [] });
      expect(await findGatewayServices(nativeEnv, { includeNode: true })).toEqual({
        services: expected
          ? [expect.objectContaining({ label: name, scope: "system", marker: "openclaw" })]
          : [],
        errors: [],
      });
    },
  );

  it.each(["missing action", "unreadable launcher"])(
    "retains Node %s as an error only when opted in",
    async (fault) => {
      const name = "\\OpenClaw Node";
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
        fault === "missing action"
          ? { taskPath: name, state: 3 }
          : task(name, "C:\\Services\\private\\worker.cmd"),
      ]);
      vi.spyOn(taskLayout, "readRegisteredScheduledTaskCommand").mockRejectedValue(
        new Error("unreadable"),
      );
      expect(await findGatewayServices(nativeEnv)).toEqual({ services: [], errors: [] });
      expect(await findGatewayServices(nativeEnv, { includeNode: true })).toEqual({
        services: [],
        errors: [{ source: name, message: expect.any(String) }],
      });
    },
  );

  it.each(["cmd", "BaT", "vbs"])(
    "recognizes an unreadable custom Task from its Node %s reference",
    async (extension) => {
      const name = "\\Ops\\Node Consumer";
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
        task(name, `C:\\Services\\openclaw\\node.${extension}`),
      ]);
      vi.spyOn(taskLayout, "readRegisteredScheduledTaskCommand").mockRejectedValue(
        new Error("unreadable"),
      );
      expect(await findGatewayServices(nativeEnv)).toEqual({ services: [], errors: [] });
      expect(await findGatewayServices(nativeEnv, { includeNode: true })).toEqual({
        services: [],
        errors: [{ source: name, message: "Scheduled Task launcher could not be inspected." }],
      });
    },
  );

  it.each(["unrelated executable", "unreadable launcher"])(
    "does not infer service ownership from a monitor label after a real Gateway: %s",
    async (kind) => {
      const gateway = task("\\OpenClaw Gateway", "C:\\Apps\\openclaw.exe", "gateway --port=19789");
      const monitor = task(
        "\\OpenClaw gateway status monitor",
        kind === "unrelated executable" ? "C:\\Tools\\monitor.exe" : "C:\\Tools\\monitor.cmd",
        "",
      );
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([gateway, monitor]);
      vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
        status: "found",
        ...monitor,
      });
      vi.spyOn(fs, "readFile").mockRejectedValue(
        Object.assign(new Error("access denied"), { code: "EACCES" }),
      );
      expect(await findGatewayServices(nativeEnv)).toEqual({
        services: [expect.objectContaining({ label: gateway.taskPath, marker: "openclaw" })],
        errors: [],
      });
    },
  );

  it.each([
    { name: "\\OpenClaw Gateway", command: "gateway", expected: true },
    { name: "\\OpenClaw Gateway (ops)", command: "gateway", expected: true },
    { name: "\\OpenClaw Gateway", command: "--mode sync", expected: true },
    { name: "\\Ops\\Runtime", command: "gateway", expected: false },
    { name: "\\Ops\\Runtime", command: "--mode sync", expected: false },
  ])(
    "retains canonical Task identity after reading an unbranded command: $name/$command",
    async ({ name, command, expected }) => {
      const launcher = "C:\\Services\\gateway.cmd";
      const snapshot = task(name, launcher);
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([snapshot]);
      vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
        status: "found",
        ...snapshot,
      });
      vi.spyOn(fs, "readFile").mockResolvedValue(
        Buffer.from(`@echo off\r\n"C:\\Apps\\service.exe" ${command}\r\n`),
      );
      expect(await findGatewayServices(nativeEnv)).toEqual({
        services: expected ? [expect.objectContaining({ label: name, marker: "openclaw" })] : [],
        errors: [],
      });
    },
  );

  it.each([
    { host: "wscript.exe", args: '"C:\\Services\\Backup\\launch.vbs"', gateway: true },
    { host: "cscript.exe", args: '"C:\\Services\\Backup\\launch.vbs"', gateway: true },
    { host: "cmd.exe", args: '/c "C:\\Services\\Backup\\worker.cmd"', gateway: true },
    { host: "cmd.exe", args: '/d /c "C:\\Services\\Backup\\worker.cmd"', gateway: true },
    { host: "cmd.exe", args: '/d /c "C:\\Services\\Backup\\worker.BaT"', gateway: true },
    { host: "wscript", args: '"C:\\Services\\Backup\\launch.vbs"', gateway: true },
    { host: "cscript", args: '"C:\\Services\\Backup\\launch.vbs"', gateway: true },
    { host: "cmd", args: '/c "C:\\Services\\Backup\\worker.cmd"', gateway: true },
    { host: "wscript.exe", args: '"C:\\Services\\Backup\\launch.vbs"', gateway: false },
    { host: "cmd.exe", args: '/c "C:\\Services\\Backup\\worker.cmd"', gateway: false },
    { host: "cmd.exe", args: '/c "C:\\Services\\Backup\\worker.BaT"', gateway: false },
  ])(
    "retains an uninspectable Gateway behind a generic $host script reference (gateway=$gateway)",
    async ({ host, args, gateway }) => {
      const name = "\\Ops\\Runtime";
      const snapshot = task(
        name,
        host.endsWith(".exe") ? `C:\\Windows\\System32\\${host}` : host,
        args,
      );
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([snapshot]);
      vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
        status: "found",
        ...snapshot,
      });
      vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
        if (pathname === "C:\\Services\\Backup\\launch.vbs") {
          return Buffer.from(
            'WScript.Quit CreateObject("WScript.Shell").Run("""C:\\Services\\Backup\\worker.cmd""", 0, True)\r\n',
          );
        }
        if (
          pathname === "C:\\Services\\Backup\\worker.cmd" ||
          pathname === "C:\\Services\\Backup\\worker.BaT"
        ) {
          return Buffer.from(
            gateway
              ? '@echo off\r\n"C:\\Apps\\openclaw.exe" gateway --port=19789\r\n'
              : '@echo off\r\n"C:\\Tools\\monitor.exe" status\r\n',
          );
        }
        throw new Error("Unexpected fixture path");
      });
      expect(await findGatewayServices(nativeEnv)).toEqual({
        services: [],
        errors: gateway
          ? [{ source: name, message: "Scheduled Task launcher could not be inspected." }]
          : [],
      });
    },
  );

  it.each([
    { form: "CMD", executable: "C:\\Services\\openclaw\\gateway.cmd", args: "" },
    { form: "BAT", executable: "C:\\Services\\openclaw\\gateway.BaT", args: "" },
    { form: "VBS", executable: "C:\\Services\\openclaw\\gateway.vbs", args: "" },
    {
      form: "WScript",
      executable: "C:\\Windows\\System32\\wscript.exe",
      args: '"C:\\Services\\openclaw\\gateway.vbs"',
    },
    {
      form: "cmd wrapper",
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: '/c "C:\\Services\\openclaw\\gateway.cmd"',
    },
  ])(
    "reports an uninspectable custom Task from its $form launcher reference",
    async ({ executable, args }) => {
      const name = "\\Ops\\Runtime";
      const snapshot = task(name, executable, args);
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([snapshot]);
      vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
        status: "found",
        ...snapshot,
      });
      vi.spyOn(fs, "readFile").mockRejectedValue(
        Object.assign(new Error("access denied"), { code: "EACCES" }),
      );
      expect(await findGatewayServices(nativeEnv)).toEqual({
        services: [],
        errors: [{ source: name, message: "Scheduled Task launcher could not be inspected." }],
      });
    },
  );

  it("excludes a recognizable launcher filename after parsing a non-Gateway command", async () => {
    const name = "\\Ops\\Runtime";
    const launcher = "C:\\Services\\openclaw\\gateway.cmd";
    const snapshot = task(name, launcher);
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([snapshot]);
    vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
      status: "found",
      ...snapshot,
    });
    const readFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation((...args) =>
      args[0] === launcher
        ? Promise.resolve(Buffer.from('@echo off\r\n"C:\\Tools\\worker.exe" --mode sync\r\n'))
        : readFile(...args),
    );
    expect(await findGatewayServices(nativeEnv)).toEqual({ services: [], errors: [] });
  });

  it.each(["cmd", "BaT"])(
    "discovers a nested custom task from its .%s launcher contents",
    async (extension) => {
      const launcher = `C:\\Services\\Backup\\gateway.${extension}`;
      const snapshot = task("\\Ops\\Backup", launcher);
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
        snapshot,
        task("\\Unrelated", "C:\\Tools\\helper.exe"),
      ]);
      vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
        status: "found",
        ...snapshot,
      });
      const generated = taskLayout.buildTaskScript({
        programArguments: ["node", "C:\\Applications\\openclaw\\openclaw.mjs", "gateway"],
        environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      });
      const readFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation((...args) =>
        args[0] === launcher ? Promise.resolve(Buffer.from(generated)) : readFile(...args),
      );
      expect(await findGatewayServices(nativeEnv)).toEqual({
        services: [
          {
            platform: "win32",
            label: "\\Ops\\Backup",
            detail: `task: \\Ops\\Backup, run: ${launcher}`,
            scope: "system",
            marker: "openclaw",
            legacy: false,
          },
        ],
        errors: [],
      });
    },
  );

  it.each([
    { executable: "C:\\Apps\\openclaw.exe", args: "gateway --port=19789", expected: true },
    { executable: "C:\\Apps\\openclaw.exe", args: '"gateway" --port=19789', expected: true },
    { executable: "C:\\Apps=stable\\openclaw.exe", args: "gateway --port 19789", expected: true },
    {
      executable: "C:\\Apps\\openclaw-helper.exe",
      args: "sync --gateway-url=https://example.invalid",
      expected: false,
    },
  ])(
    "inspects custom executable Task equals arguments: $executable $args",
    async ({ executable, args, expected }) => {
      const name = "\\Ops\\Runtime";
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([task(name, executable, args)]);
      expect(await findGatewayServices(nativeEnv)).toEqual({
        services: expected
          ? [expect.objectContaining({ label: name, marker: "openclaw", scope: "system" })]
          : [],
        errors: [],
      });
    },
  );

  it("discovers an unmarked custom Task through its actual launcher with equals arguments", async () => {
    const name = "\\Ops\\Runtime";
    const launcher = "C:\\Services\\worker.cmd";
    const snapshot = task(name, launcher);
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([snapshot]);
    vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
      status: "found",
      ...snapshot,
    });
    const readFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation((...args) =>
      args[0] === launcher
        ? Promise.resolve(
            Buffer.from('@echo off\r\n"C:\\Apps\\openclaw.exe" gateway --port=19789\r\n'),
          )
        : readFile(...args),
    );
    expect(await findGatewayServices(nativeEnv)).toEqual({
      services: [expect.objectContaining({ label: name, marker: "openclaw", scope: "system" })],
      errors: [],
    });
  });

  it.each(
    ["canonical", "profile", "legacy", "selected", "unrelated"].flatMap((kind) =>
      ["missing action", "unreadable launcher"].map((fault) => ({ kind, fault })),
    ),
  )(
    "keeps $kind $fault handling scoped while preserving diagnostic metadata",
    async ({ kind, fault }) => {
      const name =
        kind === "canonical"
          ? "\\OpenClaw Gateway"
          : kind === "profile"
            ? "\\OpenClaw Gateway (ops)"
            : kind === "legacy"
              ? "\\Clawdbot Gateway Legacy"
              : "\\Ops\\Backup";
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
        fault === "missing action"
          ? { taskPath: name, state: 3 }
          : task(name, "C:\\Services\\Backup\\gateway.cmd"),
      ]);
      vi.spyOn(taskLayout, "readRegisteredScheduledTaskCommand").mockRejectedValue(
        new Error("unreadable"),
      );
      const env =
        kind === "selected" ? { ...nativeEnv, OPENCLAW_WINDOWS_TASK_NAME: name } : nativeEnv;
      const inventory = await findGatewayServices(env);
      expect(inventory.services).toEqual([]);
      expect(inventory.errors).toEqual(
        kind === "unrelated" || kind === "legacy"
          ? []
          : [{ source: name, message: expect.any(String) }],
      );
      const extras = await findExtraGatewayServices(env, { deep: true });
      expect(extras.map(({ label }) => label)).toEqual(kind === "legacy" ? [name] : []);
    },
  );

  it.each(
    [
      { marker: "other", kind: "helper", expected: false },
      { marker: "other", kind: "node", expected: false },
      { marker: "openclaw", kind: "node", expected: true },
    ].flatMap(({ marker, kind, expected }) =>
      ["set ", "@set ", "@ set\t"].map((command) => ({ marker, kind, expected, command })),
    ),
  )(
    "associates marker values in an opaque Node launcher: $marker/$kind ($command)",
    async ({ marker, kind, expected, command }) => {
      const name = "\\Ops\\Runtime";
      const launcher = "C:\\Services\\worker.cmd";
      const snapshot = task(name, launcher);
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([snapshot]);
      vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
        status: "found",
        ...snapshot,
      });
      const readFile = fs.readFile;
      vi.spyOn(fs, "readFile").mockImplementation((...args) =>
        args[0] === launcher
          ? Promise.resolve(
              Buffer.from(
                [
                  "@echo off",
                  `${command}"OPENCLAW_SERVICE_MARKER=${marker}"`,
                  `${command}"OPENCLAW_SERVICE_KIND=${kind}"`,
                  'set "NODE_OPTIONS="',
                  '"C:\\Node\\node.exe" "C:\\Other\\worker.js" && echo ambiguous',
                ].join("\r\n"),
              ),
            )
          : readFile(...args),
      );
      expect(await findGatewayServices(nativeEnv)).toEqual({ services: [], errors: [] });
      expect(await findGatewayServices(nativeEnv, { includeNode: true })).toEqual({
        services: [],
        errors: expected
          ? [{ source: name, message: "Scheduled Task launcher could not be inspected." }]
          : [],
      });
    },
  );

  it("keeps a custom Gateway identifiable when its native wrapper is ambiguous", async () => {
    const name = "\\Ops\\Backup";
    const launcher = "C:\\Services\\Backup\\launch.vbs";
    const snapshot = task(name, launcher);
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([snapshot]);
    vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
      status: "found",
      ...snapshot,
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      if (pathname !== launcher) {
        throw new Error("Unexpected fixture path");
      }
      return Buffer.from(
        'CreateObject("WScript.Shell").Run "node C:\\Applications\\openclaw\\openclaw.mjs gateway --port=19789", 0, False',
      );
    });
    expect(await findGatewayServices(nativeEnv)).toEqual({
      services: [],
      errors: [{ source: name, message: expect.any(String) }],
    });
  });
});
