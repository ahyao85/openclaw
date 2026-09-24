import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWindowsServiceProcessObservation } from "./schtasks-process-inspection.js";
import { WindowsServiceObservationChangedError } from "./schtasks-state-probe.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
  execFileSync: vi.fn(() => ""),
}));

const originalPlatform = process.platform;
const gatewayCommand =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\OpenClaw %% ^! A\\openclaw.mjs" gateway --port 18789';
const gatewayArguments = [
  "C:\\Program Files\\nodejs\\node.exe",
  "C:\\OpenClaw %% ^! A\\openclaw.mjs",
  "gateway",
  "--port",
  "18789",
];
const supervisorCommand = `${gatewayCommand} --task-supervisor`;
const childCommand = `${gatewayCommand} --task-supervisor-child=305419896`;

function processRow(
  pid: number,
  commandLine: string | null,
  startedAt: string | null = "638940000000000021",
  parentPid = 800,
) {
  return {
    ProcessId: pid,
    ParentProcessId: parentPid,
    CreationDate: startedAt,
    Name: "node.exe",
    CommandLine: commandLine,
  };
}

function snapshot(rows: ReturnType<typeof processRow>[]) {
  const stdout = JSON.stringify(rows);
  vi.mocked(spawnSync).mockReturnValue({
    pid: 9999,
    output: [null, stdout, ""],
    status: 0,
    stdout,
    stderr: "",
    signal: null,
  });
}

function observe() {
  const observation = readWindowsServiceProcessObservation({ SystemRoot: "C:\\Windows" });
  if (!observation) {
    throw new Error("Expected a readable CIM process snapshot");
  }
  return observation;
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  vi.mocked(spawnSync).mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
});

describe("Windows service process observation", () => {
  it("normalizes a fractional caller timeout before the native process query", () => {
    snapshot([processRow(4300, gatewayCommand)]);

    expect(
      readWindowsServiceProcessObservation({ SystemRoot: "C:\\Windows" }, 250.75),
    ).not.toBeNull();
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.timeout).toBe(250);
  });

  it("keeps native reinspection within the original caller budget", () => {
    snapshot([processRow(4300, gatewayCommand)]);
    let time = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
    try {
      const observation = readWindowsServiceProcessObservation({ SystemRoot: "C:\\Windows" }, 1000);
      expect(observation).not.toBeNull();
      time = 400;
      observation!.verify();
      expect(vi.mocked(spawnSync).mock.calls.map((call) => call[2]?.timeout)).toEqual([1000, 700]);
      time = 1100;
      expect(() => observation!.verify()).toThrow("timed out");
      expect(spawnSync).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    {
      name: "provisional supervisor before its Gateway starts",
      rows: [processRow(4100, supervisorCommand)],
      pids: [4100],
    },
    {
      name: "legacy direct Gateway",
      rows: [processRow(4200, gatewayCommand)],
      pids: [4200],
    },
    {
      name: "supervised child ahead of a supervisor and direct Gateway",
      rows: [
        processRow(4100, supervisorCommand),
        processRow(4200, gatewayCommand),
        processRow(4300, childCommand, "638940000000000022", 4100),
      ],
      pids: [4300, 4100],
    },
  ])("finds the $name", ({ rows, pids }) => {
    snapshot(rows);
    expect(
      observe()
        .findInstalled(18789, gatewayArguments)
        .map(({ pid }) => pid),
    ).toEqual(pids);
  });

  it.each([
    { arrival: "matching duplicate", matching: true },
    { arrival: "opaque unrelated process", matching: false },
  ])("includes every custom installed consumer before a new $arrival", ({ matching }) => {
    const command = '"C:\\Services\\custom-engine.exe" gateway --port 18789';
    const installedArguments = ["C:\\Services\\custom-engine.exe", "gateway", "--port", "18789"];
    const rows = [
      processRow(4300, command),
      processRow(4310, command),
      processRow(4100, `${command} --task-supervisor`),
      processRow(4200, `${command} --task-supervisor-child=305419896`, "638940000000000022", 4100),
      processRow(4400, command.replace("18789", "18800")),
      processRow(4500, `${command} --debug`),
      processRow(4600, null, null),
    ];
    snapshot(rows);
    const observation = observe();
    expect(observation.readConsumers().processes).toEqual([]);
    expect(observation.findInstalled(18789, installedArguments).map(({ pid }) => pid)).toEqual([
      4200, 4100,
    ]);

    observation.includeInstalled(installedArguments);
    installedArguments[0] = "C:\\Unrelated\\changed.exe";
    expect(observation.readConsumers().processes.map(({ pid }) => pid)).toEqual([
      4100, 4200, 4300, 4310,
    ]);

    snapshot([
      ...rows,
      processRow(4800, matching ? command : null, matching ? "638940000000000023" : null),
    ]);
    if (matching) {
      expect(() => observation.verify()).toThrow(/changed during inspection/);
    } else {
      expect(() => observation.verify()).not.toThrow();
    }
  });

  it("follows real ancestry instead of another supervisor with identical argv", () => {
    snapshot([
      processRow(4400, supervisorCommand),
      processRow(4300, childCommand, "638940000000000023", 4250),
      processRow(
        4250,
        '"C:\\Windows\\System32\\cmd.exe" /c gateway.cmd',
        "638940000000000022",
        4100,
      ),
      processRow(4100, supervisorCommand),
    ]);

    expect(
      observe()
        .family(4300)
        .map(({ pid }) => pid),
    ).toEqual([4300, 4100]);
  });

  it("does not attach a reused parent PID born after the child", () => {
    snapshot([
      processRow(4100, supervisorCommand, "638940000000000022"),
      processRow(4300, childCommand, "638940000000000021", 4100),
    ]);

    expect(
      observe()
        .family(4300)
        .map(({ pid }) => pid),
    ).toEqual([4300]);
  });

  it.each([
    {
      change: "birth tick below millisecond precision",
      replacements: [processRow(4300, gatewayCommand, "638940000000000022")],
    },
    {
      change: "current command at the same PID and birth",
      replacements: [processRow(4300, gatewayCommand.replace("OpenClaw %% ^! A", "OpenClaw B"))],
    },
    {
      change: "snapshot with duplicate rows for the captured PID",
      replacements: [processRow(4300, gatewayCommand), processRow(4300, gatewayCommand)],
    },
  ])("rejects a changed $change without refreshing the captured identity", ({ replacements }) => {
    snapshot([processRow(4300, gatewayCommand)]);
    const observation = observe();
    const captured = observation.family(4300);
    const expected = [
      {
        pid: 4300,
        parentPid: 800,
        startedAt: "638940000000000021",
        programArguments: gatewayArguments,
      },
    ];
    expect(captured).toEqual(expected);

    snapshot(replacements);
    expect(() => observation.verify(4300)).toThrow(WindowsServiceObservationChangedError);
    expect(() => observation.verify()).toThrow(/changed during inspection/);
    expect(captured).toEqual(expected);
    expect(observation.family(4300)).toEqual(expected);
  });

  it("accepts reordered snapshots while retaining each consumer's current command", () => {
    const rows = [
      processRow(4300, gatewayCommand),
      processRow(4400, gatewayCommand.replace("OpenClaw %% ^! A", "OpenClaw B")),
      processRow(4500, '"C:\\Tools\\worker.exe" --port 18789'),
      processRow(4600, gatewayCommand.replace(" gateway ", " node run ")),
    ];
    snapshot(rows);
    const observation = observe();
    expect(
      observation
        .readConsumers()
        .processes.map(({ pid, programArguments }) => ({ pid, programArguments })),
    ).toEqual([
      { pid: 4300, programArguments: gatewayArguments },
      {
        pid: 4400,
        programArguments: [
          gatewayArguments[0],
          "C:\\OpenClaw B\\openclaw.mjs",
          ...gatewayArguments.slice(2),
        ],
      },
      {
        pid: 4600,
        programArguments: [...gatewayArguments.slice(0, 2), "node", "run", "--port", "18789"],
      },
    ]);

    snapshot(rows.toReversed());
    expect(() => observation.verify()).not.toThrow();
  });

  it("ignores opaque unassociated runtimes and readable unrelated processes", () => {
    snapshot([
      processRow(4100, null, null),
      { ...processRow(4200, null, null), Name: "bun.exe" },
      { ...processRow(4300, null, null), Name: "openclaw.exe" },
      processRow(
        4400,
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Tools\\worker.js" --port 18789',
        null,
      ),
      processRow(
        4500,
        gatewayCommand.replace(" gateway --port 18789", " --profile gateway status"),
      ),
      processRow(4600, gatewayCommand.replace(" gateway --port 18789", " --profile node run")),
      { ...processRow(9999, "powershell.exe -NoProfile", null), Name: "powershell.exe" },
    ]);

    expect(observe().readConsumers().processes).toEqual([]);
  });

  it("retains readable command evidence without granting an unverified birth identity", () => {
    snapshot([processRow(4300, gatewayCommand, null)]);

    expect(observe().readConsumers()).toEqual({
      processes: [],
      unavailable: [
        {
          pid: 4300,
          programArguments: gatewayArguments,
          detail: expect.stringContaining("birth identity"),
        },
      ],
    });
  });

  it.each(["birth", "duplicate PID", "invalid PID"] as const)(
    "does not let a candidate with %s hide a separate verified consumer",
    (invalid) => {
      const candidate = processRow(
        invalid === "invalid PID" ? 0 : 4200,
        gatewayCommand,
        invalid === "birth" ? null : "638940000000000021",
      );
      snapshot([
        candidate,
        ...(invalid === "duplicate PID" ? [candidate] : []),
        processRow(4300, gatewayCommand),
      ]);
      const observation = observe();
      const read = observation.readConsumers();
      expect(read.processes.map(({ pid }) => pid)).toEqual([4300]);
      expect(read.unavailable).toHaveLength(invalid === "duplicate PID" ? 2 : 1);
      for (const unavailable of read.unavailable) {
        expect(unavailable.programArguments).toEqual(gatewayArguments);
      }
      expect(() => observation.verify()).not.toThrow();
      snapshot([processRow(4300, gatewayCommand)]);
      expect(() => observation.verify()).toThrow(WindowsServiceObservationChangedError);
    },
  );

  it("distinguishes an unavailable re-read from positive process changes", () => {
    snapshot([processRow(4300, gatewayCommand)]);
    const observation = observe();
    observation.readConsumers();
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [null, "", ""],
      status: 1,
      stdout: "",
      stderr: "",
      signal: null,
    });
    let failure: unknown;
    try {
      observation.verify();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(WindowsServiceObservationChangedError);
    expect(failure).toHaveProperty("message", "Windows service process inspection is unavailable.");
  });

  it.each([
    { state: "absent", rows: [], error: undefined },
    {
      state: "reused with a valid different birth and unreadable argv",
      rows: [processRow(4300, null, "638940000000000022")],
      error: undefined,
    },
    {
      state: "present with an unknown birth",
      rows: [processRow(4300, null, null)],
      error: /birth identity/,
    },
    {
      state: "present with the same birth and unreadable argv",
      rows: [processRow(4300, null)],
      error: /readable current command/,
    },
  ])("distinguishes a known identity that is $state", ({ rows, error }) => {
    snapshot([processRow(9999, "powershell.exe"), ...rows]);
    const observation = observe();
    const readKnown = () => observation.readKnown({ pid: 4300, startedAt: "638940000000000021" });

    expect(observation.readConsumers().processes).toEqual([]);
    if (error) {
      expect(readKnown).toThrow(error);
    } else {
      expect(readKnown()).toBeUndefined();
      snapshot([processRow(9999, "powershell.exe")]);
      expect(() => observation.verify()).not.toThrow();
    }
  });

  it("revalidates a known process even when its argv does not identify an OpenClaw consumer", () => {
    const command = '"C:\\Tools\\worker.exe" --job rebuild';
    snapshot([processRow(4300, command)]);
    const observation = observe();

    expect(observation.readConsumers().processes).toEqual([]);
    expect(observation.readKnown({ pid: 4300, startedAt: "638940000000000021" })).toMatchObject({
      pid: 4300,
      startedAt: "638940000000000021",
      programArguments: ["C:\\Tools\\worker.exe", "--job", "rebuild"],
    });

    snapshot([processRow(4300, command, "638940000000000022")]);
    expect(() => observation.verify()).toThrow(/changed during inspection/);
  });
});
