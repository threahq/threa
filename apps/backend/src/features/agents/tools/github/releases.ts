import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threa/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { toActor, truncateBytes } from "./format"
import { toTraceGithubSources } from "./trace"

const MAX_RELEASE_BODY_BYTES = 8_000

const ListReleasesSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  perPage: z.number().int().min(1).max(100).optional().default(20),
  page: z.number().int().min(1).optional().default(1),
})

export type ListReleasesInput = z.infer<typeof ListReleasesSchema>

export function createGithubListReleasesTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_list_releases",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_LIST_RELEASES],
    description: `List releases in a GitHub repository, newest first. Returns tag name, release name, author, draft/prerelease flags, and publish timestamp.`,
    inputSchema: ListReleasesSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
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
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({ tool: "github_list_releases", repo: `${input.owner}/${input.repo}`, page: input.page }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}

const GetReleaseSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  tag: z.string().optional().describe("Tag name. If omitted, returns the latest non-draft, non-prerelease release"),
})

export type GetReleaseInput = z.infer<typeof GetReleaseSchema>

export function createGithubGetReleaseTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_get_release",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_GET_RELEASE],
    description: `Fetch a single release by tag (or the latest release if tag is omitted). Returns metadata plus the release body/notes (truncated to ${MAX_RELEASE_BODY_BYTES} bytes) and any attached assets.`,
    inputSchema: GetReleaseSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
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
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({
          tool: "github_get_release",
          repo: `${input.owner}/${input.repo}`,
          tag: input.tag ?? "latest",
        }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}
