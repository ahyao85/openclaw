import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  inspectServicePublicationFootprint,
  inspectServicePublicationPath,
  servicePublicationFootprintsOverlap,
  servicePublicationPathChanged,
} from "./service-publication-footprint.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const assertCurrent = () => {};

it.each(["same", "serving nested", "target nested", "disjoint"] as const)(
  "distinguishes package replacement from artifact writes: %s roots",
  async (relationship) => {
    const home = tempDirs.make("openclaw-publication-footprint-");
    const outer = path.join(home, "outer");
    const targetRoot =
      relationship === "target nested" ? path.join(outer, "packages", "target") : outer;
    const servingRoot =
      relationship === "same" || relationship === "target nested"
        ? outer
        : relationship === "serving nested"
          ? path.join(outer, ".artifacts", "serving")
          : path.join(home, "other");
    await fs.mkdir(targetRoot, { recursive: true });
    const entry = path.join(servingRoot, "dist", "entry.js");
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, "export {};\n");
    const target = await inspectServicePublicationFootprint(targetRoot, assertCurrent);
    const serving = await inspectServicePublicationFootprint(servingRoot, assertCurrent);
    const entrypoint = await inspectServicePublicationPath(entry, assertCurrent);
    expect(
      servicePublicationFootprintsOverlap(target, serving, {
        mode: "runtime-artifacts",
        entrypoint,
      }),
    ).toBe(relationship === "same");
    expect(servicePublicationFootprintsOverlap(target, serving, { mode: "whole-package" })).toBe(
      relationship !== "disjoint",
    );
  },
);

it.each([
  "serving output into target",
  "target output into serving",
  "missing SDK descendants",
] as const)(
  "includes root/output overlap for whole-package replacement: %s",
  async (relationship) => {
    const home = tempDirs.make("openclaw-publication-alias-");
    const targetRoot = path.join(home, "target");
    const servingRoot = path.join(home, "serving");
    await fs.mkdir(targetRoot);
    await fs.mkdir(path.join(servingRoot, "dist"), { recursive: true });
    const entry = path.join(servingRoot, "dist", "entry.js");
    await fs.writeFile(entry, "export {};\n");
    if (relationship === "missing SDK descendants") {
      await fs.symlink(servingRoot, path.join(targetRoot, "dist"), "junction");
    } else {
      const consumed = path.join(
        relationship === "serving output into target" ? targetRoot : servingRoot,
        "shared-code",
      );
      const link = path.join(
        relationship === "serving output into target" ? servingRoot : targetRoot,
        "dist-runtime",
      );
      await fs.mkdir(consumed);
      await fs.symlink(consumed, link, "junction");
    }
    const target = await inspectServicePublicationFootprint(targetRoot, assertCurrent);
    const serving = await inspectServicePublicationFootprint(servingRoot, assertCurrent);
    const entrypoint = await inspectServicePublicationPath(entry, assertCurrent);
    expect(
      servicePublicationFootprintsOverlap(target, serving, {
        mode: "runtime-artifacts",
        entrypoint,
      }),
    ).toBe(false);
    expect(servicePublicationFootprintsOverlap(target, serving, { mode: "whole-package" })).toBe(
      true,
    );
  },
);

it("refuses a dangling output alias rather than projecting it as an absent directory", async () => {
  const root = tempDirs.make("openclaw-publication-dangling-");
  await fs.symlink(path.join(root, "missing"), path.join(root, "dist-runtime"), "junction");
  await expect(inspectServicePublicationFootprint(root, assertCurrent)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("observes a replaced package root without imposing artifact publication's parent-generation fence", async () => {
  const home = tempDirs.make("openclaw-publication-replacement-");
  const root = path.join(home, "package");
  await fs.mkdir(root);
  const before = await inspectServicePublicationFootprint(root, assertCurrent);
  await fs.rename(root, `${root}-old`);
  await fs.mkdir(root);
  const current = await inspectServicePublicationFootprint(root, assertCurrent);
  expect(current.root.stat?.ino).not.toBe(before.root.stat?.ino);
  expect(servicePublicationFootprintsOverlap(before, current, { mode: "whole-package" })).toBe(
    true,
  );
});

async function mountedFixture() {
  const home = tempDirs.make("openclaw-publication-mount-");
  const target = path.join(home, "package");
  const alias = path.join(home, "alias");
  const unrelated = path.join(home, "other");
  for (const root of [target, alias, unrelated]) {
    await fs.mkdir(root);
  }
  const targetReal = await fs.realpath(target);
  const aliasReal = await fs.realpath(alias);
  const readStat = fs.stat;
  const mounts = new Map([[aliasReal, targetReal]]);
  // A bind mount retains its lexical realpath while its root has the backing inode.
  vi.spyOn(fs, "stat").mockImplementation((file, options) =>
    readStat(typeof file === "string" ? (mounts.get(file) ?? file) : file, options),
  );
  return {
    target,
    alias,
    unrelated,
    bind: async (mounted: string, backing: string) => {
      mounts.set(await fs.realpath(mounted), await fs.realpath(backing));
    },
    retarget: async () => {
      mounts.set(aliasReal, await fs.realpath(unrelated));
    },
  };
}

it.each(["serving nested", "target nested", "sibling", "prefix lookalike"] as const)(
  "compares physical ancestry through a mount alias without conflating %s paths",
  async (relationship) => {
    const f = await mountedFixture();
    const first = path.join(f.target, ".artifacts", "serving");
    const second = path.join(
      f.alias,
      ".artifacts",
      relationship === "prefix lookalike" ? "serving-other" : "other",
    );
    const targetRoot = relationship === "serving nested" ? f.target : first;
    const servingRoot =
      relationship === "target nested"
        ? f.alias
        : relationship === "serving nested"
          ? path.join(f.alias, ".artifacts", "serving")
          : second;
    await fs.mkdir(targetRoot, { recursive: true });
    const entry = path.join(servingRoot, "dist", "entry.js");
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, "export {};\n");
    const target = await inspectServicePublicationFootprint(targetRoot, assertCurrent);
    const serving = await inspectServicePublicationFootprint(servingRoot, assertCurrent);
    const entrypoint = await inspectServicePublicationPath(entry, assertCurrent);
    expect(servicePublicationFootprintsOverlap(target, serving, { mode: "whole-package" })).toBe(
      relationship === "serving nested" || relationship === "target nested",
    );
    expect(
      servicePublicationFootprintsOverlap(target, serving, {
        mode: "runtime-artifacts",
        entrypoint,
      }),
    ).toBe(false);
  },
);

it.each(["same", "nested", "disjoint"] as const)(
  "compares missing output suffixes through physical alias parents: %s",
  async (relationship) => {
    const f = await mountedFixture();
    const left = await inspectServicePublicationPath(
      path.join(f.target, "missing"),
      assertCurrent,
      true,
    );
    const right = await inspectServicePublicationPath(
      path.join(
        f.alias,
        relationship === "same"
          ? "missing"
          : relationship === "nested"
            ? "missing/child"
            : "different",
      ),
      assertCurrent,
      true,
    );
    expect(left.stat).toBeUndefined();
    expect(right.stat).toBeUndefined();
    expect(
      servicePublicationFootprintsOverlap(
        { root: left, outputs: [] },
        { root: right, outputs: [] },
        { mode: "whole-package" },
      ),
    ).toBe(relationship !== "disjoint");
  },
);

it("recognizes an artifact entrypoint beneath a physically aliased output", async () => {
  const f = await mountedFixture();
  const entry = path.join(f.alias, "dist-runtime", "entry.js");
  await fs.mkdir(path.dirname(entry));
  const backingOutput = path.join(f.target, "dist-runtime");
  await fs.mkdir(backingOutput);
  await f.bind(path.dirname(entry), backingOutput);
  await fs.writeFile(entry, "export {};\n");
  const target = await inspectServicePublicationFootprint(f.target, assertCurrent);
  const serving = await inspectServicePublicationFootprint(f.unrelated, assertCurrent);
  const entrypoint = await inspectServicePublicationPath(entry, assertCurrent);
  expect(
    servicePublicationFootprintsOverlap(target, serving, { mode: "runtime-artifacts", entrypoint }),
  ).toBe(true);
});

it.each(["endpoint", "nested", "missing"] as const)(
  "does not infer overlap past an independently mounted subtree: %s",
  async (relationship) => {
    const f = await mountedFixture();
    const targetSubtree = path.join(f.target, "x");
    const mountedSubtree = path.join(f.alias, "x");
    await fs.mkdir(targetSubtree);
    await fs.mkdir(path.join(mountedSubtree, "y"), { recursive: true });
    await f.bind(mountedSubtree, f.unrelated);
    const target = await inspectServicePublicationFootprint(
      relationship === "missing" ? path.join(targetSubtree, "missing") : targetSubtree,
      assertCurrent,
      true,
    );
    const serving = await inspectServicePublicationFootprint(
      relationship === "missing"
        ? path.join(mountedSubtree, "missing", "child")
        : relationship === "nested"
          ? path.join(mountedSubtree, "y")
          : mountedSubtree,
      assertCurrent,
      true,
    );
    expect(servicePublicationFootprintsOverlap(target, serving, { mode: "whole-package" })).toBe(
      false,
    );
  },
);

it("allows materializing missing descendants but detects a changed physical ancestor", async () => {
  const f = await mountedFixture();
  const file = path.join(f.alias, "missing", "child");
  const before = await inspectServicePublicationPath(file, assertCurrent, true);
  await fs.mkdir(path.dirname(file));
  const after = await inspectServicePublicationPath(file, assertCurrent, true);
  expect(servicePublicationPathChanged(before, after)).toBe(false);
  await f.retarget();
  const retargeted = await inspectServicePublicationPath(file, assertCurrent, true);
  expect(retargeted.real).toBe(after.real);
  expect(servicePublicationPathChanged(after, retargeted)).toBe(true);
});

it("checks caller custody after an awaited ancestor inspection", async () => {
  const root = tempDirs.make("openclaw-publication-current-");
  const file = path.join(root, "entry.js");
  await fs.writeFile(file, "export {};\n");
  const parent = await fs.realpath(root);
  const readStat = fs.stat;
  let current = true;
  vi.spyOn(fs, "stat").mockImplementation(async (pathname, options) => {
    const stat = await readStat(pathname, options);
    if (pathname === parent) {
      current = false;
    }
    return stat;
  });
  await expect(
    inspectServicePublicationPath(file, () => {
      if (!current) {
        throw new Error("caller retired");
      }
    }),
  ).rejects.toThrow("caller retired");
});
