import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { runExec } from "../process/exec.js";
import { findExtraGatewayServices, findGatewayServices } from "./inspect.js";
import { execLaunchctl, type LaunchctlResult } from "./launchd-exec.js";
import { decodeLaunchdPlistMetadata } from "./launchd-plist.js";
import { resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";
import { GatewayServiceAuthorityError } from "./service-update-authority.js";

vi.mock("./launchd-exec.js", async (original) => ({
  ...(await original<typeof import("./launchd-exec.js")>()),
  execLaunchctl: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const readdir = async (directory: Parameters<typeof actual.readdir>[0]) =>
    ["/Library/LaunchAgents", "/Library/LaunchDaemons"].includes(String(directory))
      ? []
      : actual.readdir(directory);
  return { ...actual, readdir, default: { ...actual, readdir } };
});
vi.mock("../process/exec.js", async (original) => {
  const actual = await original<typeof import("../process/exec.js")>();
  const { decodeLaunchAgentPlistFixture } = await import("./launchd-plist.test-support.js");
  return {
    ...actual,
    runExec: vi.fn(async (...args: Parameters<typeof actual.runExec>) => {
      const options = args[2];
      const input = typeof options === "object" ? options.input : undefined;
      if (input === undefined) {
        throw new Error("Expected captured synthetic plist bytes");
      }
      return decodeLaunchAgentPlistFixture(input, args[1][1]);
    }),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const exec = vi.mocked(execLaunchctl);
const ok = (stdout: string) => ({ code: 0, termination: "exit" as const, stdout, stderr: "" });
const custom = "org.synthetic.shared-consumer";
let home: string;
let gui: string;
let domains: Map<string, string[]>;
let jobs: Map<string, LaunchctlResult>;
// Kept as an object variable so the same entry-point regression compiles on the pre-option source.
const loadedOptions = { includeNode: true, includeLoaded: true };

function metadata(
  domain: string,
  label: string,
  kind: "gateway" | "node" | "wrapper" | "unmarked",
) {
  const args =
    kind === "wrapper"
      ? `\targuments = {\n\t\t/synthetic/service-env/${label}-env-wrapper.sh\n\t}\n`
      : "";
  const environment =
    kind === "gateway" || kind === "node"
      ? `\tenvironment = {\n\t\tOPENCLAW_SERVICE_MARKER => openclaw\n\t\tOPENCLAW_SERVICE_KIND => ${kind}\n\t}\n`
      : "";
  return `${domain}/${label} = {\n\tstate = running\n${args}${environment}}\n`;
}
function add(domain: string, label: string, kind: Parameters<typeof metadata>[2]) {
  domains.set(domain, [...(domains.get(domain) ?? []), label]);
  jobs.set(`${domain}/${label}`, ok(metadata(domain, label, kind)));
}
async function writeDefinition(label: string) {
  const sourcePath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(
    sourcePath,
    `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/openclaw</string><string>gateway</string></array></dict></plist>`,
  );
  return sourcePath;
}

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  home = tempDirs.make("openclaw-loaded-inventory-");
  gui = resolveLaunchAgentGuiDomain();
  domains = new Map([
    [gui, []],
    ["system", []],
  ]);
  jobs = new Map();
  exec.mockReset().mockImplementation(async (args) => {
    if (args[0] !== "print" || !args[1]) {
      throw new Error("Discovery must only print native metadata");
    }
    const labels = domains.get(args[1]);
    return labels
      ? ok(
          `${args[1]} = {\n\tservices = {\n${labels.map((label) => `\t\t4242 M ${label}\n`).join("")}\t}\n}\n`,
        )
      : (jobs.get(args[1]) ?? ok(""));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("opt-in loaded launchd discovery", () => {
  it.each([200, undefined])(
    "uses only the caller's remaining plist budget: %s",
    async (timeoutMs) => {
      for (const suffix of ["a", "b", "c"]) {
        await writeDefinition(`${custom}-${suffix}`);
      }
      let time = 0;
      vi.spyOn(performance, "now").mockImplementation(() => time);
      const decode = vi.mocked(runExec).getMockImplementation()!;
      const budgets: number[] = [];
      vi.mocked(runExec).mockImplementation(async (...args) => {
        const options = args[2];
        const granted = typeof options === "object" ? options.timeoutMs : undefined;
        if (granted === undefined) {
          throw new Error("Expected a bounded native decoder");
        }
        budgets.push(granted);
        const duration = timeoutMs === undefined ? 2000 : 60;
        time += Math.min(granted, duration);
        if (granted < duration) {
          throw new Error("Synthetic decoder timeout");
        }
        return decode(...args);
      });
      try {
        const result = await findGatewayServices({ HOME: home }, { timeoutMs });
        if (timeoutMs === undefined) {
          expect(result.services).toHaveLength(3);
          expect(result.errors).toEqual([]);
          expect(budgets).toEqual([5000, 3000, 5000, 3000, 5000, 3000]);
        } else {
          expect(budgets).toEqual([200, 140, 80, 20]);
          expect(result.errors.length).toBeGreaterThan(0);
        }
        expect(exec).not.toHaveBeenCalled();
      } finally {
        vi.mocked(runExec).mockImplementation(decode);
      }
    },
  );

  it("does not launch the second plist command after its deadline expires", async () => {
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    const command = vi.mocked(runExec);
    command.mockClear();
    command.mockImplementationOnce(async () => {
      time = 50;
      return { stdout: "<plist><dict/></plist>", stderr: "" };
    });
    await expect(decodeLaunchdPlistMetadata(Buffer.from("fixture"), 50)).rejects.toThrow(
      "timed out",
    );
    expect(command).toHaveBeenCalledOnce();
  });

  it.each(["cleanup", "authority"])(
    "preserves decoder %s failures through discovery",
    async (kind) => {
      await writeDefinition(custom);
      const failure =
        kind === "cleanup"
          ? new CommandProcessCleanupError()
          : new GatewayServiceAuthorityError(new Error("native owner retired"));
      vi.mocked(runExec).mockRejectedValueOnce(failure);
      await expect(findGatewayServices({ HOME: home }, loadedOptions)).rejects.toBe(failure);
    },
  );

  it("retains a known custom loaded consumer after its definition is removed", async () => {
    const definition = await writeDefinition(custom);
    add(gui, custom, "unmarked");
    await fs.unlink(definition);
    const inventory = await findGatewayServices(
      { HOME: home, OPENCLAW_LAUNCHD_LABEL: custom },
      loadedOptions,
    );
    expect(inventory).toEqual({
      services: [
        expect.objectContaining({ platform: "darwin", label: custom, launchdDomain: gui }),
      ],
      errors: [],
    });
  });

  it.each(["gateway", "node", "wrapper"] as const)(
    "discovers an arbitrary custom label from managed %s evidence",
    async (kind) => {
      add(gui, custom, kind);
      const inventory = await findGatewayServices({ HOME: home }, loadedOptions);
      expect(inventory.services).toEqual([
        expect.objectContaining({ label: custom, launchdDomain: gui }),
      ]);
      expect(inventory.services[0]?.sourcePath).toBeUndefined();
      expect(inventory.errors).toEqual([]);
    },
  );

  it("keeps default inventory and Doctor diagnostics free of native enumeration", async () => {
    add(gui, custom, "gateway");
    expect(await findGatewayServices({ HOME: home })).toEqual({ services: [], errors: [] });
    expect(await findExtraGatewayServices({ HOME: home }, { deep: true })).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps Node opt-in when native enumeration is requested", async () => {
    add(gui, custom, "node");
    expect(await findGatewayServices({ HOME: home }, { includeLoaded: true })).toEqual({
      services: [],
      errors: [],
    });
  });

  it("does not claim arbitrary unmarked jobs are supported managed consumers", async () => {
    add(gui, custom, "unmarked");
    expect(await findGatewayServices({ HOME: home }, loadedOptions)).toEqual({
      services: [],
      errors: [],
    });
  });

  it("does not let a GUI definition hide a same-label system consumer", async () => {
    const sourcePath = await writeDefinition(custom);
    add(gui, custom, "gateway");
    add("system", custom, "gateway");
    const inventory = await findGatewayServices({ HOME: home }, { ...loadedOptions, deep: true });
    expect(inventory.services).toEqual([
      expect.objectContaining({ label: custom, sourcePath, scope: "user" }),
      expect.objectContaining({ label: custom, launchdDomain: "system", scope: "system" }),
    ]);
    expect(inventory.errors).toEqual([]);
  });

  it.each(["unavailable", "missing table", "malformed row", "truncated"])(
    "reports %s domain enumeration as unknown",
    async (fault) => {
      exec.mockImplementationOnce(async () =>
        fault === "unavailable"
          ? { ...ok(""), code: 125, stderr: "Could not find domain" }
          : ok(
              fault === "missing table"
                ? `${gui} = {\n}\n`
                : fault === "truncated"
                  ? `${gui} = {\n\tservices = {\n`
                  : `${gui} = {\n\tservices = {\n\t\tmalformed row\n\t}\n}\n`,
            ),
      );
      const inventory = await findGatewayServices({ HOME: home }, loadedOptions);
      expect(inventory.services).toEqual([]);
      expect(inventory.errors).toEqual([{ source: gui, message: expect.stringContaining(gui) }]);
    },
  );

  it.each(["opaque", "configured", "authored"] as const)(
    "skips a native absent receipt for a listed %s job",
    async (association) => {
      const sourcePath = association === "authored" ? await writeDefinition(custom) : undefined;
      add(gui, custom, "unmarked");
      jobs.set(`${gui}/${custom}`, {
        ...ok(""),
        code: 113,
        stderr: "Could not find service",
      });
      const inventory = await findGatewayServices(
        {
          HOME: home,
          ...(association === "configured" ? { OPENCLAW_LAUNCHD_LABEL: custom } : {}),
        },
        loadedOptions,
      );
      expect(inventory).toEqual({
        services: sourcePath ? [expect.objectContaining({ label: custom, sourcePath })] : [],
        errors: [],
      });
    },
  );

  it("does not treat successful job text as a native absent receipt", async () => {
    add(gui, custom, "gateway");
    jobs.set(
      `${gui}/${custom}`,
      ok(
        metadata(gui, custom, "gateway").replace(
          "\tstate",
          "\tprogram = /synthetic/not found\n\tstate",
        ),
      ),
    );
    const inventory = await findGatewayServices({ HOME: home }, loadedOptions);
    expect(inventory.services).toEqual([
      expect.objectContaining({ label: custom, launchdDomain: gui, platform: "darwin" }),
    ]);
    expect(inventory.services[0]?.sourcePath).toBeUndefined();
    expect(inventory.errors).toEqual([]);
  });

  it.each(
    [false, true].flatMap((known) =>
      ["denied", "timeout", "blank", "partial environment", "missing state"].map((fault) => ({
        known,
        fault,
      })),
    ),
  )(
    "keeps $fault inspection failures only for associated jobs (known=$known)",
    async ({ known, fault }) => {
      const target = `${gui}/${custom}`;
      add(gui, custom, "unmarked");
      jobs.set(
        target,
        fault === "denied"
          ? { ...ok(""), code: 1, stderr: "Operation not permitted" }
          : fault === "timeout"
            ? { ...ok(""), code: 1, termination: "timeout" }
            : ok(
                fault === "blank"
                  ? ""
                  : fault === "partial environment"
                    ? `${target} = {\n\tstate = running\n\tenvironment = {\n}\n`
                    : `${target} = {\n}\n`,
              ),
      );
      const inventory = await findGatewayServices(
        { HOME: home, ...(known ? { OPENCLAW_LAUNCHD_LABEL: custom } : {}) },
        loadedOptions,
      );
      expect(inventory).toEqual({
        services: [],
        errors: known ? [{ source: gui, message: expect.stringContaining(target) }] : [],
      });
    },
  );

  it.each(["gateway", "node", "wrapper"] as const)(
    "keeps exact %s association when the remaining native metadata is truncated",
    async (kind) => {
      add(gui, custom, kind);
      jobs.set(`${gui}/${custom}`, ok(metadata(gui, custom, kind).slice(0, -2)));
      const inventory = await findGatewayServices({ HOME: home }, loadedOptions);
      expect(inventory).toEqual({
        services: [],
        errors: [{ source: gui, message: expect.stringContaining(`${gui}/${custom}`) }],
      });
    },
  );
});
