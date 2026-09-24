import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareUpdateServiceConsumers } from "../cli/update-cli/update-command-service-consumers.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { findExtraGatewayServices, findGatewayServices } from "./inspect.js";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
} from "./service-inspection-error.js";
import { inspectServicePublicationConsumers } from "./service-publication-consumers.js";
import { inspectServicePublicationFootprint } from "./service-publication-footprint.js";
import { GatewayServiceAuthorityError } from "./service-update-authority.js";
import {
  openSystemdBroker,
  openSystemdMachineBroker,
  openSystemdSystemBroker,
  openSystemdUserManager,
} from "./systemd-peer-native.js";
import { listLoadedSystemdServices } from "./systemd-peer.js";
import { readSystemdServiceRuntime } from "./systemd-runtime.js";
import { readSystemdServiceExecStart } from "./systemd-service-files.js";
import { resolveSystemdUserTransport } from "./systemd-user-transport.js";

vi.mock("./systemd-peer-native.js", () => ({
  openSystemdBroker: vi.fn(),
  openSystemdMachineBroker: vi.fn(),
  openSystemdSystemBroker: vi.fn(),
  openSystemdUserManager: vi.fn(),
}));
vi.mock("./systemd-user-transport.js", async (original) => ({
  ...(await original<typeof import("./systemd-user-transport.js")>()),
  resolveSystemdUserTransport: vi.fn(),
}));
vi.mock("./systemd-runtime.js", () => ({ readSystemdServiceRuntime: vi.fn() }));
vi.mock("./systemd-service-files.js", async (original) => ({
  ...(await original<typeof import("./systemd-service-files.js")>()),
  readSystemdServiceExecStart: vi.fn(),
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
type Unit = {
  label: string;
  executable?: string;
  argv: string[];
  fragment: string;
  environment?: string[];
  propertyFailure?: Error;
};
let home: string;
let userUnits: Unit[];
let systemUnits: Unit[];
let ownerChanged: boolean;
let failProperties: boolean;
const closed = vi.fn();
const queryCalls: Array<{ scope: "user" | "system"; args: string[]; deadline: number }> = [];

function connection(scope: "user" | "system") {
  let ownerReads = 0;
  const units = scope === "user" ? userUnits : systemUnits;
  const objects = new Map(
    units.map((unit, index) => [`/org/freedesktop/systemd1/unit/unit${index}`, unit]),
  );
  return {
    close: async () => {
      closed(scope);
    },
    verify: () => {},
    query: async (args: string[], _signatures: string[], deadline: number) => {
      queryCalls.push({ scope, args, deadline });
      if (args[4] === "GetNameOwner") {
        return [[ownerChanged && ++ownerReads > 1 ? ":1.43" : ":1.42"]];
      }
      if (args[4] === "GetConnectionUnixUser") {
        return [[scope === "user" ? 1000 : 0]];
      }
      if (args[4] === "ListUnits") {
        return [
          [
            Array.from(objects, ([object, unit]) => [
              unit.label,
              "custom worker",
              "loaded",
              "active",
              "running",
              "",
              object,
              0,
              "",
              "/",
            ]),
          ],
        ];
      }
      if (args[0] === "get-property") {
        if (failProperties) {
          throw new Error("manager command unavailable");
        }
        const unit = args[2] === undefined ? undefined : objects.get(args[2]);
        if (!unit) {
          throw new Error("unexpected unit path");
        }
        if (unit.propertyFailure) {
          throw unit.propertyFailure;
        }
        return args.slice(4).map((property) => {
          if (property === "ExecStart") {
            return [[unit.executable ?? unit.argv[0], unit.argv, false, 0, 0, 0, 0, 0, 0, 0]];
          }
          if (property === "Environment") {
            return unit.environment ?? [];
          }
          if (property === "FragmentPath") {
            return unit.fragment;
          }
          throw new Error("unexpected manager property");
        });
      }
      throw new Error("unexpected manager method");
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockProcessPlatform("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(1000);
  home = dirs.make("openclaw-loaded-inventory-");
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (target, options) =>
    lstat(String(target).endsWith("/systemd") ? home : target, options),
  );
  const readdir = fs.readdir;
  vi.spyOn(fs, "readdir").mockImplementation(async (...args) =>
    typeof args[0] === "string" && !args[0].startsWith(`${home}${path.sep}`)
      ? []
      : await readdir(...args),
  );
  userUnits = [];
  systemUnits = [];
  ownerChanged = false;
  failProperties = false;
  queryCalls.length = 0;
  vi.mocked(resolveSystemdUserTransport).mockResolvedValue({
    kind: "session-bus",
    address: "unix:path=/fixture/bus",
    runtimeDir: "/fixture",
  });
  vi.mocked(openSystemdBroker).mockImplementation(async () => connection("user"));
  vi.mocked(openSystemdMachineBroker).mockImplementation(async () => connection("user"));
  vi.mocked(openSystemdUserManager).mockImplementation(async () => connection("user"));
  vi.mocked(openSystemdSystemBroker).mockImplementation(async () => connection("system"));
});
afterEach(() => vi.restoreAllMocks());

const inspect = () =>
  findGatewayServices(
    { HOME: home },
    {
      deep: true,
      includeNode: true,
      includeLoaded: true,
    },
  );

it("propagates manager authority loss instead of turning it into an inventory warning", async () => {
  const revoked = new ServiceOwnershipRefusalError("systemd-manager-changed");
  vi.mocked(resolveSystemdUserTransport).mockRejectedValue(revoked);
  await expect(inspect()).rejects.toBe(revoked);
});

it("uses the already-selected machine broker with the caller's absolute deadline", async () => {
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.mocked(resolveSystemdUserTransport).mockResolvedValue({ kind: "machine", user: "operator" });
  userUnits.push({
    label: "custom-runtime.service",
    argv: ["/usr/bin/openclaw", "gateway"],
    fragment: "/fixture/custom.service",
  });
  const deadline = performance.now() + 30_000;
  const inventory = await listLoadedSystemdServices({ HOME: home }, "user", deadline);
  expect(inventory.services.map((service) => service.label)).toEqual(["custom-runtime.service"]);
  expect(openSystemdMachineBroker).toHaveBeenCalledExactlyOnceWith("operator@", deadline);
  expect(openSystemdBroker).not.toHaveBeenCalled();
  expect(queryCalls.length).toBeGreaterThan(3);
  expect(new Set(queryCalls.map((call) => call.deadline))).toEqual(new Set([deadline]));
});

it("does not open a manager after the inventory budget is exhausted", async () => {
  vi.spyOn(performance, "now").mockReturnValue(100);
  await expect(listLoadedSystemdServices({ HOME: home }, "user", 100)).rejects.toMatchObject({
    reason: "systemd-inspection-deadline-exceeded",
  });
  expect(resolveSystemdUserTransport).not.toHaveBeenCalled();
  expect(openSystemdBroker).not.toHaveBeenCalled();
});

it("rejects manager rebinding before returning a loaded inventory", async () => {
  ownerChanged = true;
  await expect(
    listLoadedSystemdServices({ HOME: home }, "user", performance.now() + 30_000),
  ).rejects.toMatchObject({ reason: "systemd-manager-changed" });
  expect(closed).toHaveBeenCalledExactlyOnceWith("user");
  await expect(inspect()).rejects.toMatchObject({ reason: "systemd-manager-changed" });
});

it("inspects a system-only host without requiring an absent user manager", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const inspectRuntime = vi.mocked(fs.lstat).getMockImplementation()!;
  vi.mocked(fs.lstat).mockImplementation(async (target, options) => {
    if (target === "/run/systemd") {
      return inspectRuntime(target, options);
    }
    throw missing;
  });
  const result = await findGatewayServices(
    {
      HOME: home,
      DBUS_SESSION_BUS_ADDRESS: undefined,
      SUDO_USER: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
    },
    { deep: true, includeLoaded: true, timeoutMs: 30_000 },
  );
  expect(result).toEqual({ services: [], errors: [] });
  expect(resolveSystemdUserTransport).not.toHaveBeenCalled();
  expect(openSystemdSystemBroker).toHaveBeenCalledOnce();
});

it("carries one caller budget through a large manager inventory", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  for (let index = 0; index < 8; index++) {
    systemUnits.push({
      label: `unrelated-${index}.service`,
      argv: ["/usr/bin/sleep", "100"],
      fragment: "/fixture/unrelated.service",
    });
  }
  const manager = connection("system");
  vi.mocked(openSystemdSystemBroker).mockResolvedValue({
    ...manager,
    query: async (...args: Parameters<typeof manager.query>) => {
      now += 600;
      expect(args[2]).toBe(30_100);
      if (now >= args[2]) {
        throw new Error("caller deadline expired");
      }
      return manager.query(...args);
    },
  });
  expect(
    await findGatewayServices(
      { HOME: home },
      { deep: true, includeLoaded: true, timeoutMs: 30_000 },
    ),
  ).toEqual({ services: [], errors: [] });
  expect(now).toBeGreaterThan(5_100);
});

it.each(["user", "system"] as const)(
  "retains a custom loaded %s Gateway after its unit definition is removed",
  async (scope) => {
    const unit = {
      label: "custom-runtime.service",
      fragment: path.join(home, "deleted.service"),
      argv: ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "gateway", "run"],
    };
    await fs.writeFile(unit.fragment, "[Service]\nExecStart=/usr/bin/openclaw gateway run\n");
    await fs.unlink(unit.fragment);
    (scope === "user" ? userUnits : systemUnits).push(unit);
    const result = await inspect();
    expect(result.services).toEqual([expect.objectContaining({ label: unit.label, scope })]);
    expect(result.services[0]?.sourcePath).toBe(unit.fragment);
    expect(result.errors).toEqual([]);
    expect(closed.mock.calls.map(([closedScope]) => closedScope)).toEqual(["user", "system"]);
    for (const managerScope of ["user", "system"]) {
      expect(
        new Set(
          queryCalls
            .filter(({ scope: observedScope }) => observedScope === managerScope)
            .map(({ deadline }) => deadline),
        ).size,
      ).toBe(1);
    }
    expect(queryCalls.some(({ args }) => args.includes("LoadUnit"))).toBe(false);
  },
);

async function sharedSystemConsumer(argv0: "ordinary" | "overridden" = "ordinary") {
  const root = path.join(home, "installation");
  const entrypoint = path.join(root, "openclaw.mjs");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.writeFile(entrypoint, "export {};\n");
  const executable = "/usr/bin/node";
  const expected = [executable, entrypoint, "gateway", "run"];
  const unit = {
    label: "custom-runtime.service",
    executable,
    argv: [argv0 === "ordinary" ? executable : "custom-argv-zero", ...expected.slice(1)],
    fragment: path.join(home, "deleted.service"),
  };
  systemUnits.push(unit);
  vi.mocked(readSystemdServiceRuntime).mockResolvedValue({
    status: "running",
    pid: 45001,
    systemd: { scope: "system", unit: unit.label, managerUid: 0 },
  });
  vi.mocked(readSystemdServiceExecStart).mockImplementation(async (_env, options) => {
    options?.onCommandInspection?.({ kind: "present" });
    return { programArguments: expected, sourcePath: unit.fragment };
  });
  await fs.writeFile(unit.fragment, "[Service]\nExecStart=/fixture/retained gateway\n");
  await fs.unlink(unit.fragment);
  return { root, unit, expected };
}

it.each(["ordinary", "overridden"] as const)(
  "normalizes %s ExecStart argv[0] and identifies the live shared consumer",
  async (argv0) => {
    const { root, unit, expected } = await sharedSystemConsumer(argv0);
    const inventory = await inspect();
    expect(inventory.errors).toEqual([]);
    expect(inventory.services).toEqual([
      expect.objectContaining({ label: unit.label, scope: "system", sourcePath: unit.fragment }),
    ]);
    const consumers = await inspectServicePublicationConsumers({
      inventory,
      targets: [await inspectServicePublicationFootprint(root, () => {})],
      mode: "whole-package",
      env: { HOME: home },
      assertCurrent: () => {},
      timeoutMs: 30_000,
    });
    expect(consumers.warnings).toEqual([]);
    expect(consumers.blockers).toEqual([
      expect.objectContaining({
        source: unit.fragment,
        message: expect.stringContaining("consumes the installation"),
      }),
    ]);
    const loaded = await listLoadedSystemdServices(
      { HOME: home },
      "system",
      performance.now() + 30_000,
    );
    expect(loaded.services[0]?.commands).toEqual([expected]);
  },
);

it.each(["unavailable", "disappeared"] as const)(
  "keeps an earlier loaded shared consumer when a later unrelated unit is %s",
  async (fault) => {
    const { root, unit } = await sharedSystemConsumer();
    const unrelated = "unrelated-later.service";
    systemUnits.push({
      label: unrelated,
      argv: ["/usr/bin/sleep", "100"],
      fragment: path.join(home, "unrelated.service"),
      propertyFailure: new Error(
        fault === "disappeared" ? "No such object" : "Property unavailable",
      ),
    });
    const warn = vi.fn();
    await expect(
      prepareUpdateServiceConsumers({
        roots: [root],
        mode: "whole-package",
        env: { HOME: home },
        assertCurrent: () => {},
        timeoutMs: 30_000,
        warn,
      }),
    ).rejects.toMatchObject({
      reason: "managed-service-preflight",
      message: expect.stringContaining(`${unit.fragment}: This system service consumes`),
    });
    expect(warn).toHaveBeenCalledWith(
      `systemd:system/${unrelated}: Loaded service metadata could not be inspected.`,
    );
    const systemQueries = queryCalls.filter(({ scope }) => scope === "system");
    expect(systemQueries.at(-1)?.args[4]).toBe("GetNameOwner");
    expect(new Set(systemQueries.map(({ deadline }) => deadline)).size).toBe(1);
    expect(queryCalls.some(({ args }) => args.includes("LoadUnit"))).toBe(false);
    expect(closed.mock.calls.map(([scope]) => scope)).toEqual(["user", "system"]);
  },
);

it.each(["authority", "cleanup", "manager"] as const)(
  "does not turn a later %s refusal into partial inventory",
  async (kind) => {
    await sharedSystemConsumer();
    const failure =
      kind === "authority"
        ? new GatewayServiceAuthorityError(new Error("retired"))
        : kind === "cleanup"
          ? new CommandProcessCleanupError()
          : new ServiceOwnershipRefusalError("systemd-manager-changed");
    systemUnits.push({
      label: "unrelated-later.service",
      argv: ["/usr/bin/sleep", "100"],
      fragment: "",
      propertyFailure: failure,
    });
    await expect(inspect()).rejects.toBe(failure);
    expect(closed.mock.calls.map(([scope]) => scope)).toEqual(["user", "system"]);
  },
);

it("discards partial records if the final manager owner changed", async () => {
  await sharedSystemConsumer();
  systemUnits.push({
    label: "unrelated-later.service",
    argv: ["/usr/bin/sleep", "100"],
    fragment: "",
    propertyFailure: new Error("Property unavailable"),
  });
  const native = connection("system");
  let ownerReads = 0;
  vi.mocked(openSystemdSystemBroker).mockResolvedValue({
    ...native,
    query: async (...args: Parameters<typeof native.query>) =>
      args[0][4] === "GetNameOwner" && ++ownerReads > 1 ? [[":1.43"]] : await native.query(...args),
  });
  await expect(inspect()).rejects.toMatchObject({ reason: "systemd-manager-changed" });
  expect(closed.mock.calls.map(([scope]) => scope)).toEqual(["user", "system"]);
});

it("does not query another unit or renew the deadline after partial inventory expires", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  systemUnits.push(
    {
      label: "first.service",
      argv: ["/usr/bin/openclaw", "gateway"],
      fragment: "/fixture/first.service",
    },
    { label: "expired.service", argv: ["/usr/bin/sleep", "1"], fragment: "" },
    { label: "later.service", argv: ["/usr/bin/sleep", "1"], fragment: "" },
  );
  const native = connection("system");
  vi.mocked(openSystemdSystemBroker).mockResolvedValue({
    ...native,
    query: async (...args: Parameters<typeof native.query>) => {
      if (args[0][2] === "/org/freedesktop/systemd1/unit/unit1") {
        now = 200;
        throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
      }
      return await native.query(...args);
    },
  });
  await expect(listLoadedSystemdServices({ HOME: home }, "system", 200)).rejects.toMatchObject({
    reason: "systemd-inspection-deadline-exceeded",
  });
  expect(queryCalls.some(({ args }) => args[2] === "/org/freedesktop/systemd1/unit/unit2")).toBe(
    false,
  );
  expect(new Set(queryCalls.map(({ deadline }) => deadline))).toEqual(new Set([200]));
  expect(closed).toHaveBeenCalledExactlyOnceWith("system");
});

it("does not classify an unrelated loaded command from its deceptive authored argv[0]", async () => {
  systemUnits.push({
    label: "unrelated.service",
    executable: "/usr/bin/node",
    argv: ["/opt/openclaw/openclaw.mjs", "/opt/unrelated/worker.mjs", "gateway"],
    fragment: path.join(home, "unrelated.service"),
  });
  expect(await inspect()).toEqual({ services: [], errors: [] });
});

it("classifies custom Node launchers by exact manager markers and excludes unrelated services", async () => {
  userUnits.push(
    {
      label: "custom-node.service",
      argv: ["/usr/bin/node", "/opt/launcher.mjs"],
      fragment: "",
      environment: ["OPENCLAW_SERVICE_MARKER=openclaw", "OPENCLAW_SERVICE_KIND=node"],
    },
    {
      label: "openclaw-gateway-helper.service",
      argv: ["/usr/bin/openclaw-helper", "sync"],
      fragment: "",
    },
  );
  expect((await inspect()).services.map(({ label }) => label)).toEqual(["custom-node.service"]);
});

it("does not duplicate a loaded unit already discovered through its definition", async () => {
  const dir = path.join(home, ".config/systemd/user");
  await fs.mkdir(dir, { recursive: true });
  const fragment = path.join(dir, "custom-runtime.service");
  await fs.writeFile(fragment, "[Service]\nExecStart=/usr/bin/openclaw gateway run\n");
  userUnits.push({
    label: "custom-runtime.service",
    fragment,
    argv: ["/usr/bin/openclaw", "gateway", "run"],
  });
  const result = await inspect();
  expect(result.errors).toEqual([]);
  expect(result.services).toHaveLength(1);
  expect(result.services[0]?.sourcePath).toBe(fragment);
});

it.each(["machine", "private", "uninspectable"])(
  "keeps %s manager selection explicit",
  async (scenario) => {
    userUnits.push({
      label: "custom-runtime.service",
      argv: ["/usr/bin/openclaw", "gateway"],
      fragment: "",
    });
    if (scenario === "machine") {
      vi.mocked(resolveSystemdUserTransport).mockResolvedValue({
        kind: "machine",
        user: "operator",
      });
    } else if (scenario === "private") {
      vi.mocked(resolveSystemdUserTransport).mockResolvedValue({
        kind: "private",
        address: "unix:path=/fixture/private",
        runtimeDir: "/fixture",
      });
    } else {
      failProperties = true;
    }
    const result = await findGatewayServices({ HOME: home }, { includeLoaded: true });
    expect(result.errors).toEqual([
      {
        source: "systemd:user/custom-runtime.service",
        message: expect.any(String),
      },
    ]);
    if (scenario === "machine" || scenario === "private") {
      expect(openSystemdBroker).not.toHaveBeenCalled();
    }
    expect(openSystemdSystemBroker).not.toHaveBeenCalled();
  },
);

it("leaves ordinary and Doctor diagnostics on their existing discovery path", async () => {
  await findGatewayServices({ HOME: home });
  await findExtraGatewayServices({ HOME: home }, { deep: true });
  expect(resolveSystemdUserTransport).not.toHaveBeenCalled();
  expect(openSystemdBroker).not.toHaveBeenCalled();
  expect(openSystemdSystemBroker).not.toHaveBeenCalled();
});

it.each(["absent", "unreadable runtime", "explicit bus"])(
  "preserves affirmative managerless proof while keeping %s distinct",
  async (condition) => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    vi.mocked(fs.lstat).mockRejectedValue(
      condition === "unreadable runtime"
        ? Object.assign(new Error("access denied"), { code: "EACCES" })
        : missing,
    );
    vi.spyOn(fs, "access").mockRejectedValue(missing);
    vi.mocked(resolveSystemdUserTransport).mockRejectedValue(new Error("manager unavailable"));
    vi.mocked(openSystemdSystemBroker).mockRejectedValue(new Error("manager unavailable"));
    const result = await findGatewayServices(
      {
        HOME: home,
        DBUS_SESSION_BUS_ADDRESS:
          condition === "explicit bus" ? "unix:path=/fixture/bus" : undefined,
        DBUS_SYSTEM_BUS_ADDRESS: undefined,
        SYSTEMD_UNIT_PATH: undefined,
        SUDO_USER: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_PROFILE: undefined,
        XDG_RUNTIME_DIR: path.join(home, "runtime"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_CONFIG_DIRS: "/etc/xdg",
        XDG_DATA_DIRS: "/usr/local/share:/usr/share",
      },
      { deep: true, includeLoaded: true },
    );
    expect(result).toEqual({
      services: [],
      errors:
        condition === "absent"
          ? []
          : [
              { source: "systemd:user", message: "Loaded services could not be inspected." },
              ...(condition === "unreadable runtime"
                ? [{ source: "systemd:system", message: "Loaded services could not be inspected." }]
                : []),
            ],
    });
    if (condition === "absent") {
      expect(resolveSystemdUserTransport).not.toHaveBeenCalled();
      expect(openSystemdSystemBroker).not.toHaveBeenCalled();
    }
  },
);
