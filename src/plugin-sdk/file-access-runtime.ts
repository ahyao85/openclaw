// Safe local-file helpers for plugin runtime media and bridge code.
import { statRegularFileSync as inspectRegularFileSync } from "../infra/fs-safe.js";

/** Return whether a path resolves to a regular file, treating filesystem errors as missing. */
export function fileExists(filePath: string): boolean {
  try {
    return !inspectRegularFileSync(filePath).missing;
  } catch {
    return false;
  }
}

export {
  canonicalPathFromExistingAncestor,
  readFileWithinRoot,
  readLocalFileFromRoots,
  readRegularFile,
  readRegularFileSync,
  readSecureFile,
  root,
  statRegularFile,
  statRegularFileSync,
  writeFileWithinRoot,
} from "../infra/fs-safe.js";
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  readFileHandleBounded,
  resolvePathPrefixSync,
  tempFile,
} from "@openclaw/fs-safe/advanced";
export { readFileWindowFully } from "@openclaw/fs-safe/advanced";
export { inspectPathPermissions } from "@openclaw/fs-safe/permissions";
export { writeFileWindowFully } from "../infra/file-descriptor.js";
export { openRootFile } from "../infra/boundary-file-read.js";
export {
  ensureDurableDirectory,
  sha256File,
  syncDirectory,
  type DirectorySyncOutcome,
} from "../infra/directory-durability.js";
export { removePathWithinRoot } from "../infra/fs-safe-remove.js";
export { basenameFromMediaSource, safeFileURLToPath } from "@openclaw/fs-safe/advanced";
export { isPathInside, isPathStrictlyInside } from "../infra/path-guards.js";
export { getFileWatchCapacityCode } from "../infra/fs-watch-errors.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { readFileRangeAsync } from "../config/sessions/file-range.js";
