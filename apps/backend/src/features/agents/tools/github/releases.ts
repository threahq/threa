import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threa/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { toActor, truncateBytes } from "./format"
import { toTraceGithubSources } from "./trace"

const MAX_RELEASE_BODY_BYTES = 8_000

const ReleasesSchema = z.object({
  mode: z
    .enum(["list", "get"])
    .describe(
      "list: releases in a repo, newest first. get: a single release by tag, or the latest release when tag is omitted."
    ),
  owner: z.string().min(1).describe("Repository owner"),
  repo: z.string().min(1).describe("Repository name"),
  // get param
  tag: z
    .string()
    .optional()
    .describe("get: tag name. If omitted, returns the latest non-draft, non-prerelease release"),
  // list pagination
  perPage: z.number().int().min(1).max(100).optional().default(20).describe("list: releases per page (max 100)"),
  page: z.number().int().min(1).optional().default(1).describe("list: 1-indexed page number"),
})

export type ReleasesInput = z.infer<typeof ReleasesSchema>

async function listReleases(deps: GitHubToolDeps, input: ReleasesInput): Promise<AgentToolResult> {
  const result = await withGithubClient(deps, input.owner, async (client) => {
    const response = await client.request<any[]>("GET /repos/{owner}/{repo}/releases", {
      owner: input.owner,
      repo: input.repo,
      per_page: input.perPage,
      page: input.page,
    })
    return response.map((r) => ({
      id: r.id,
      tagName: r.tag_name,
      name: r.name,
      draft: Boolean(r.draft),
      prerelease: Boolean(r.prerelease),
      author: toActor(r.author),
      createdAt: r.created_at,
      publishedAt: r.published_at,
      htmlUrl: typeof r.html_url === "string" ? r.html_url : null,
    }))
  })

  if (isGitHubToolError(result)) return toToolResult(result)

  const sources: SourceItem[] = result
    .filter((r): r is typeof r & { htmlUrl: string } => typeof r.htmlUrl === "string")
    .slice(0, 10)
    .map((r) => ({
      type: "github",
      title: `${input.owner}/${input.repo} ${r.tagName ?? r.name ?? ""}`.trim().slice(0, 200),
      url: r.htmlUrl,
    }))

  return {
    output: JSON.stringify({
      owner: input.owner,
      repo: input.repo,
      page: input.page,
      perPage: input.perPage,
      count: result.length,
      releases: result,
    }),
    sources,
  }
}

async function getRelease(deps: GitHubToolDeps, input: ReleasesInput): Promise<AgentToolResult> {
  const result = await withGithubClient(deps, input.owner, async (client) => {
    const release = input.tag
      ? await client.request<any>("GET /repos/{owner}/{repo}/releases/tags/{tag}", {
          owner: input.owner,
          repo: input.repo,
          tag: input.tag,
        })
      : await client.request<any>("GET /repos/{owner}/{repo}/releases/latest", {
          owner: input.owner,
          repo: input.repo,
        })

    const body = truncateBytes(typeof release.body === "string" ? release.body : "", MAX_RELEASE_BODY_BYTES)

    return {
      id: release.id,
      tagName: release.tag_name,
      name: release.name,
      draft: Boolean(release.draft),
      prerelease: Boolean(release.prerelease),
      author: toActor(release.author),
      targetCommitish: release.target_commitish ?? null,
      body: { text: body.text, truncated: body.truncated, totalBytes: body.totalBytes },
      createdAt: release.created_at,
      publishedAt: release.published_at,
      htmlUrl: typeof release.html_url === "string" ? release.html_url : null,
      assets: Array.isArray(release.assets)
        ? release.assets.map((a: any) => ({
            name: a.name,
            contentType: a.content_type,
            size: a.size,
            downloadCount: a.download_count,
            browserDownloadUrl: typeof a.browser_download_url === "string" ? a.browser_download_url : null,
          }))
        : [],
    }
  })

  if (isGitHubToolError(result)) return toToolResult(result)

  const sources: SourceItem[] = result.htmlUrl
    ? [
        {
          type: "github",
          title: `${input.owner}/${input.repo} ${result.tagName ?? result.name ?? ""}`.trim().slice(0, 200),
          url: result.htmlUrl,
        },
      ]
    : []

  return {
    output: JSON.stringify({ owner: input.owner, repo: input.repo, release: result }),
    sources,
  }
}

export function createGithubReleasesTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_releases",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_RELEASES],
    description: `Read GitHub releases. mode=list returns releases newest first (tag, name, author, draft/prerelease flags, publish time). mode=get fetches one release by tag (or the latest when tag is omitted) with metadata, the release notes/body (truncated to ${MAX_RELEASE_BODY_BYTES} bytes), and any attached assets.`,
    inputSchema: ReleasesSchema,

    execute: async (input): Promise<AgentToolResult> => {
      if (input.mode === "get") return getRelease(deps, input)
      return listReleases(deps, input)
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify(
          input.mode === "get"
            ? { tool: "github_releases", mode: "get", repo: `${input.owner}/${input.repo}`, tag: input.tag ?? "latest" }
            : { tool: "github_releases", mode: "list", repo: `${input.owner}/${input.repo}`, page: input.page }
        ),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}
