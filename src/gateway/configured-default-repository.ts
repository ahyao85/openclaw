import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseProjectGitUrl } from "../projects/project-git-url.js";

/** One environment-owned repository projection shared by the picker and prepared pool. */
export function configuredDefaultRepository(env: NodeJS.ProcessEnv = process.env) {
  const identity = normalizeOptionalString(env.OPENCLAW_PROJECTS_DEFAULT_REPOSITORY_IDENTITY);
  const parsed = parseProjectGitUrl(env.OPENCLAW_PROJECTS_DEFAULT_REPOSITORY_URL ?? "");
  const ref = normalizeOptionalString(env.OPENCLAW_PROJECTS_DEFAULT_REPOSITORY_REF);
  const profileId = normalizeOptionalString(env.OPENCLAW_PROJECTS_DEFAULT_REPOSITORY_PROFILE_ID);
  if (
    !identity ||
    identity.length > 200 ||
    !parsed ||
    (ref?.length ?? 0) > 255 ||
    (profileId?.length ?? 0) > 128
  ) {
    return undefined;
  }
  return {
    identity,
    url: parsed.url,
    ...(ref ? { ref } : {}),
    ...(profileId ? { profileId } : {}),
  };
}
