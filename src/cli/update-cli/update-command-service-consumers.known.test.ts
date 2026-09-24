import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import { findGatewayServices } from "../../daemon/inspect.js";
import { execLaunchctl } from "../../daemon/launchd-exec.js";
import { resolveLaunchAgentGuiDomain } from "../../daemon/launchd-runtime.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { prepareUpdateServiceConsumers } from "./update-command-service-consumers.js";

vi.mock("../../daemon/launchd-exec.js", async (original) => ({
  ...(await original<typeof import("../../daemon/launchd-exec.js")>()),
  execLaunchctl: vi.fn(),
}));
vi.mock("../../daemon/exec-file.js", async (original) => ({
  ...(await original<typeof import("../../daemon/exec-file.js")>()),
  execFileUtf8: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const readdir = async (directory: Parameters<typeof actual.readdir>[0]) =>
    ["/Library/LaunchAgents", "/Library/LaunchDaemons"].includes(String(directory))
      ? []
      : actual.readdir(directory);
  return { ...actual, readdir, default: { ...actual, readdir } };
});
vi.mock("../../process/exec.js", async (original) => {
  const actual = await original<typeof import("../../process/exec.js")>();
  const { decodeLaunchAgentPlistFixture } =
    await import("../../daemon/launchd-plist.test-support.js");
  return {
    ...actual,
    runExec: vi.fn(async (...args: Parameters<typeof actual.runExec>) => {
      const input = typeof args[2] === "object" ? args[2].input : undefined;
      if (input === undefined) {
        throw new Error("Expected captured fixture plist bytes");
      }
      return decodeLaunchAgentPlistFixture(input, args[1][1]);
    }),
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
const custom = "org.fixture.previously-identified";
const unrelated = "org.fixture.unrelated";
const ok = (stdout: string) => ({ code: 0, termination: "exit" as const, stdout, stderr: "" });
beforeEach(() => {
  vi.clearAllMocks();
  mockProcessPlatform("darwin");
});
afterEach(() => vi.restoreAllMocks());

it.each(["unknown", "stale selected", "running", "pidless", "absent", "disjoint"] as const)(
  "revalidates a known launchd consumer after its plist disappears: %s",
  async (change) => {
    const home = dirs.make("known-launchd-consumer-");
    const root = path.join(home, "target");
    const separate = path.join(home, "separate");
    for (const directory of [root, separate]) {
      await fs.mkdir(directory);
      await fs.writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({ name: "openclaw" }),
      );
      await fs.writeFile(path.join(directory, "openclaw.mjs"), "export {};\n");
    }
    const sourcePath = path.join(home, "Library/LaunchAgents", `${custom}.plist`);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const argv = [process.execPath, path.join(root, "openclaw.mjs"), "gateway"];
    await fs.writeFile(
      sourcePath,
      `<plist><dict><key>Label</key><string>${custom}</string><key>ProgramArguments</key><array>${argv.map((arg) => `<string>${arg}</string>`).join("")}</array></dict></plist>`,
    );
    const gui = resolveLaunchAgentGuiDomain();
    let state = "absent";
    vi.mocked(execLaunchctl).mockImplementation(async (args) => {
      if (args[0] !== "print") {
        throw new Error("Expected read-only native inspection");
      }
      if (args[1] === gui || args[1] === "system") {
        const rows = args[1] === gui ? [custom, unrelated] : [];
        return ok(
          `${args[1]} = {\n\tservices = {\n${rows.map((label) => `\t\t45001 M ${label}\n`).join("")}\t}\n}\n`,
        );
      }
      if (args[1] === `${gui}/${unrelated}` || state === "unknown") {
        return { ...ok(""), code: 1, stderr: "Operation not permitted" };
      }
      if (args[1] !== `${gui}/${custom}`) {
        throw new Error("Unexpected job target");
      }
      if (state === "absent") {
        return { ...ok(""), code: 113, stderr: "Could not find service" };
      }
      return ok(
        `${gui}/${custom} = {\n\tstate = ${state === "pidless" ? "waiting" : "running"}\n${state === "pidless" ? "" : "\tpid = 45001\n"}}\n`,
      );
    });
    vi.mocked(execFileUtf8).mockImplementation(async (file, args) => {
      if (file !== "/usr/bin/osascript" || !args.includes(custom)) {
        throw new Error("Unexpected native command reader");
      }
      const programArguments =
        state === "disjoint"
          ? [process.execPath, path.join(separate, "openclaw.mjs"), "gateway"]
          : argv;
      return ok(JSON.stringify({ program: process.execPath, programArguments }));
    });
    const env = { HOME: home };
    const prepared = await prepareUpdateServiceConsumers({
      roots: [root],
      mode: "whole-package",
      env,
      assertCurrent: () => {},
      timeoutMs: 5000,
      warn: vi.fn(),
      // The selected owner supplies verified overlap before its definition disappears.
      selectedState: {
        env: { ...env, OPENCLAW_LAUNCHD_LABEL: custom },
        installed: true,
        loadState: { status: "not-loaded" },
        running: false,
        command: { programArguments: argv, sourcePath },
        runtime: { status: "stopped" },
      },
    });
    await fs.unlink(sourcePath);
    state = change === "stale selected" ? "unknown" : change;
    // This fresh discovery intentionally lacks prior context and keeps unrelated unknown jobs out.
    expect(
      await findGatewayServices(env, { deep: true, includeNode: true, includeLoaded: true }),
    ).toEqual({ services: [], errors: [] });
    const publish = vi.fn();
    const mutation = async () => {
      await prepared.revalidate({
        warn: vi.fn(),
        selectedState:
          change === "stale selected"
            ? {
                env: { ...env, OPENCLAW_LAUNCHD_LABEL: custom },
                installed: true,
                loadState: { status: "loaded" },
                running: true,
                command: { programArguments: argv, sourcePath },
                runtime: { status: "running", pid: 45001 },
              }
            : undefined,
      });
      publish();
    };
    // The associated job must stay unloaded for this update, even if its command changes.
    if (change === "absent") {
      await expect(mutation()).resolves.toBeUndefined();
      expect(publish).toHaveBeenCalledOnce();
    } else {
      await expect(mutation()).rejects.toThrow(
        state === "unknown" || state === "disjoint"
          ? "previously verified"
          : "consumes the installation",
      );
      expect(publish).not.toHaveBeenCalled();
    }
  },
);
