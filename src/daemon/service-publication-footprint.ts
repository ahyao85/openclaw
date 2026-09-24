/** Physical publication footprints; lifecycle policy and generation fences stay with callers. */
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode, isPathInside } from "../infra/path-guards.js";

export const DEFAULT_SERVICE_PUBLICATION_OUTPUT_PATHS = [
  "dist-runtime",
  path.join("dist", "extensions", "node_modules", "openclaw"),
] as const;

type FileIdentity = Pick<Stats, "dev" | "ino">;
export type ServicePublicationPath<T extends FileIdentity = Stats> = {
  real: string;
  stat?: T;
  /** Physical ancestors plus the relative path from each ancestor to this observation. */
  ancestors: readonly (FileIdentity & { suffix: string })[];
};
export type ServicePublicationFootprint<T extends FileIdentity = Stats> = {
  root: ServicePublicationPath<T>;
  outputs: ServicePublicationPath<T>[];
};

export async function inspectServicePublicationPath(
  file: string,
  assertCurrent: () => void,
  allowMissing = false,
): Promise<ServicePublicationPath> {
  try {
    const real = await fs.realpath(file);
    assertCurrent();
    const stat = await fs.stat(real);
    assertCurrent();
    const ancestors = [{ suffix: "", dev: stat.dev, ino: stat.ino }];
    for (let cursor = path.dirname(real); cursor !== real;) {
      const parent = await fs.stat(cursor);
      assertCurrent();
      ancestors.push({ suffix: path.relative(cursor, real), dev: parent.dev, ino: parent.ino });
      const next = path.dirname(cursor);
      if (next === cursor) {
        break;
      }
      cursor = next;
    }
    return { real, stat, ancestors };
  } catch (error) {
    assertCurrent();
    if (!allowMissing || !hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
    // Resolve absent descendants through their existing ancestor, but never through a dangling link.
    const present = await fs.lstat(file).catch((statError: unknown) => {
      if (!hasNodeErrorCode(statError, "ENOENT")) {
        throw statError;
      }
      return undefined;
    });
    assertCurrent();
    if (present) {
      throw error;
    }
    const directory = path.dirname(file);
    if (directory === file) {
      throw error;
    }
    const parent = await inspectServicePublicationPath(directory, assertCurrent, true);
    assertCurrent();
    const name = path.basename(file);
    return {
      real: path.join(parent.real, name),
      ancestors: parent.ancestors.map((ancestor) => ({
        suffix: path.join(ancestor.suffix, name),
        dev: ancestor.dev,
        ino: ancestor.ino,
      })),
    };
  }
}

/** These are overlap observations, not a promise that a package root survives replacement. */
export async function inspectServicePublicationFootprint(
  root: string,
  assertCurrent: () => void,
  allowMissing = false,
  outputPaths: readonly string[] = DEFAULT_SERVICE_PUBLICATION_OUTPUT_PATHS,
): Promise<ServicePublicationFootprint> {
  const identity = await inspectServicePublicationPath(root, assertCurrent, allowMissing);
  const outputs = await Promise.all(
    outputPaths.map((output) =>
      inspectServicePublicationPath(path.join(identity.real, output), assertCurrent, true),
    ),
  );
  assertCurrent();
  return { root: identity, outputs };
}

function same(
  a: ServicePublicationPath<FileIdentity>,
  b: ServicePublicationPath<FileIdentity>,
): boolean {
  if (a.real === b.real) {
    return true;
  }
  const left = a.ancestors[0],
    right = b.ancestors[0];
  return Boolean(
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.suffix === right.suffix,
  );
}

function contains(
  a: ServicePublicationPath<FileIdentity>,
  b: ServicePublicationPath<FileIdentity>,
): boolean {
  if (same(a, b) || isPathInside(a.real, b.real)) {
    return true;
  }
  const stat = a.stat;
  if (stat) {
    return b.ancestors.some((ancestor) => stat.dev === ancestor.dev && stat.ino === ancestor.ino);
  }
  if (b.stat) {
    return false;
  }
  // Only missing endpoints can project suffixes, and only from their nearest
  // existing anchor. A higher shared ancestor cannot override a mounted subtree.
  const left = a.ancestors[0],
    right = b.ancestors[0];
  const base = path.parse(a.real).root;
  return Boolean(
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    isPathInside(path.join(base, left.suffix), path.join(base, right.suffix)),
  );
}

function intersects(
  a: ServicePublicationPath<FileIdentity>,
  b: ServicePublicationPath<FileIdentity>,
): boolean {
  return contains(a, b) || contains(b, a);
}

/** Newly materialized descendants may add anchors; previously observed anchors must survive. */
export function servicePublicationPathChanged(
  previous: ServicePublicationPath<FileIdentity>,
  current: ServicePublicationPath<FileIdentity>,
): boolean {
  return (
    previous.real !== current.real ||
    previous.ancestors.some(
      (before) =>
        !current.ancestors.some(
          (after) =>
            before.suffix === after.suffix && before.dev === after.dev && before.ino === after.ino,
        ),
    )
  );
}

export function servicePublicationFootprintsOverlap(
  target: ServicePublicationFootprint<FileIdentity>,
  serving: ServicePublicationFootprint<FileIdentity>,
  comparison:
    | { mode: "runtime-artifacts"; entrypoint: ServicePublicationPath<FileIdentity> }
    | { mode: "whole-package"; entrypoint?: ServicePublicationPath<FileIdentity> },
): boolean {
  if (same(target.root, serving.root)) {
    return true;
  }
  if (comparison.mode === "whole-package") {
    const consumed = [
      serving.root,
      ...serving.outputs,
      ...(comparison.entrypoint ? [comparison.entrypoint] : []),
    ];
    return [target.root, ...target.outputs].some((changed) =>
      consumed.some((used) => intersects(changed, used)),
    );
  }
  return target.outputs.some(
    (destination) =>
      same(destination, serving.root) ||
      contains(destination, comparison.entrypoint) ||
      serving.outputs.some((output) => intersects(destination, output)),
  );
}
