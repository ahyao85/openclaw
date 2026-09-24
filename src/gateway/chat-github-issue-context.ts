import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveGitHubHost } from "../agents/github-host.js";
import type { TemplateContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { gitHubPublicApi } from "./github-public-api.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { prepareGatewayProjectGitHubIdentity } from "./project-github-identity.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const URL_CANDIDATE = /https:\/\/[^\s<>"']+/gu;
const BODY_CHARS = 24 * 1024;
const COMMENT_CHARS = 2 * 1024;
const COMMENT_LIMIT = 8;

type IssueTarget = { owner: string; repo: string; number: number; url: string };

function trimUrlPunctuation(value: string): string {
  return value.replace(/[),.;:!?\]}]+$/u, "");
}

export function parseSessionGitHubIssueTarget(params: {
  message: string;
  repositoryUrl: string;
  host?: string;
}): IssueTarget | undefined {
  const host = (params.host ?? resolveGitHubHost()).toLowerCase();
  const repository = parseGitHubRemoteUrl(params.repositoryUrl, host);
  if (!repository) {
    return undefined;
  }
  for (const candidate of params.message.match(URL_CANDIDATE) ?? []) {
    try {
      const url = new URL(trimUrlPunctuation(candidate));
      if (
        url.protocol !== "https:" ||
        url.hostname.toLowerCase() !== host ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        continue;
      }
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (segments.length !== 4 || segments[2] !== "issues") {
        continue;
      }
      const target = gitHubPublicApi.parseGitHubTarget({
        kind: "issue",
        owner: segments[0],
        repo: segments[1],
        number: Number(segments[3]),
      });
      if (
        target?.kind === "issue" &&
        target.owner.toLowerCase() === repository.owner.toLowerCase() &&
        target.repo.toLowerCase() === repository.repo.toLowerCase()
      ) {
        return { ...target, url: url.href };
      }
    } catch {
      // Ignore non-URL text and unsupported escaped path segments.
    }
  }
  return undefined;
}

export async function attachSessionGitHubIssueContext(params: {
  agentId: string;
  assertActive: () => void;
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  message: string;
  repositoryWorkspaceId?: string;
  templateContext: TemplateContext;
}): Promise<void> {
  if (!params.repositoryWorkspaceId) {
    return;
  }
  const repository = getSessionRepositoryWorkspaceStore().get(params.repositoryWorkspaceId);
  if (!repository || repository.agentId !== params.agentId) {
    return;
  }
  const target = parseSessionGitHubIssueTarget({
    message: params.message,
    repositoryUrl: repository.url,
  });
  if (!target) {
    return;
  }
  params.assertActive();
  const identity = await prepareGatewayProjectGitHubIdentity({
    agentId: params.agentId,
    assertActive: params.assertActive,
    config: params.config,
    context: params.context,
  });
  if (!identity) {
    return;
  }
  const document = await identity.start(() =>
    gitHubPublicApi.loadGitHubDetail(
      { kind: "issue", owner: target.owner, repo: target.repo, number: target.number },
      identity,
    ),
  );
  identity.assertSelected();
  params.assertActive();
  const comments = (document.comments ?? []).slice(0, COMMENT_LIMIT).map((comment) => ({
    author: truncateUtf16Safe(comment.author, 256),
    created_at: comment.createdAt,
    body: truncateUtf16Safe(comment.body, COMMENT_CHARS),
    body_truncated:
      comment.bodyTruncated === true || comment.body.length > COMMENT_CHARS || undefined,
  }));
  params.templateContext.ChannelStructuredContext = [
    ...(params.templateContext.ChannelStructuredContext ?? []),
    {
      label: "GitHub issue context (untrusted external content)",
      source: "github",
      type: "github_issue",
      payload: {
        url: target.url,
        repository: `${target.owner}/${target.repo}`,
        number: target.number,
        title: truncateUtf16Safe(document.title, 512),
        state: document.badge?.label,
        author: document.author,
        created_at: document.createdAt,
        updated_at: document.updatedAt,
        body: truncateUtf16Safe(document.body, BODY_CHARS),
        body_truncated:
          document.bodyTruncated === true || document.body.length > BODY_CHARS || undefined,
        comments,
        comments_total: document.commentsTotal,
        comments_truncated:
          document.commentsTruncated === true ||
          (document.comments?.length ?? 0) > COMMENT_LIMIT ||
          undefined,
      },
    },
  ];
}
