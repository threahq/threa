import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threa/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { toActor, truncateBytes } from "./format"
import { toTraceGithubSources } from "./trace"

const MAX_COMMIT_FILES = 30
const MAX_COMMIT_PATCH_BYTES = 32_000

const ListCommitsSchema = z.object({
  owner: z.string().min(1).describe("Repository owner"),
  repo: z.string().min(1).describe("Repository name"),
  sha: z
    .string()
    .optional()
    .describe("Branch, tag, or commit SHA to start from. Defaults to the repo's default branch"),
  path: z.string().optional().describe("Only commits that modify this file path"),
  author: z.string().optional().describe("GitHub username or email to filter by author"),
  since: z.string().optional().describe("ISO 8601 timestamp; only commits after this time"),
  until: z.string().optional().describe("ISO 8601 timestamp; only commits before this time"),
  perPage: z.number().int().min(1).max(100).optional().default(20).describe("Commits per page (max 100)"),
  page: z.number().int().min(1).optional().default(1).describe("1-indexed page number"),
})

export type ListCommitsInput = z.infer<typeof ListCommitsSchema>

export function createGithubListCommitsTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_list_commits",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_LIST_COMMITS],
    description: `List commits on a branch or path in a GitHub repository, newest first. Use this to find recent work, commits touching a specific file or directory, or commits by a particular author. Returns short SHA, author, date, and the first line of each commit message.`,
    inputSchema: ListCommitsSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
        const response = await client.request<any[]>("GET /repos/{owner}/{repo}/commits", {
          owner: input.owner,
          repo: input.repo,
          sha: input.sha,
          path: input.path,
          author: input.author,
          since: input.since,
          until: input.until,
          per_page: input.perPage,
          page: input.page,
        })
        return response.map((c) => ({
          sha: c.sha,
          shortSha: typeof c.sha === "string" ? c.sha.slice(0, 7) : null,
          message: typeof c.commit?.message === "string" ? c.commit.message.split("\n")[0] : null,
          author: toActor(c.author) ?? toActor(c.commit?.author),
          committedAt: c.commit?.author?.date ?? c.commit?.committer?.date ?? null,
          htmlUrl: typeof c.html_url === "string" ? c.html_url : null,
        }))
      })

      if (isGitHubToolError(result)) return toToolResult(result)

      const sources: SourceItem[] = result
        .filter((c): c is typeof c & { htmlUrl: string } => typeof c.htmlUrl === "string")
        .slice(0, 10)
        .map((c) => ({
          type: "github",
          title: `${input.owner}/${input.repo}@${c.shortSha ?? ""}: ${c.message ?? ""}`.slice(0, 200),
          url: c.htmlUrl,
        }))

      return {
        output: JSON.stringify({
          owner: input.owner,
          repo: input.repo,
          page: input.page,
          perPage: input.perPage,
          count: result.length,
          commits: result,
        }),
        sources,
      }
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({
          tool: "github_list_commits",
          repo: `${input.owner}/${input.repo}`,
          path: input.path ?? null,
          author: input.author ?? null,
          page: input.page,
        }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}

const GetCommitSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1).describe("Commit SHA (full or short) or a branch/tag name to resolve"),
  includeFiles: z
    .boolean()
    .optional()
    .default(true)
    .describe("When true, include the changed-files list and diff patches (truncated)"),
})

export type GetCommitInput = z.infer<typeof GetCommitSchema>

export function createGithubGetCommitTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_get_commit",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_GET_COMMIT],
    description: `Fetch a single commit with full message, author, stats, and optional changed-file patches. Use this after github_list_commits to inspect what a specific commit changed. File patches are truncated to ${MAX_COMMIT_PATCH_BYTES} bytes each and limited to ${MAX_COMMIT_FILES} files; large commits return a summary with per-file addition/deletion counts so the model knows how much was trimmed.`,
    inputSchema: GetCommitSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
        const commit = await client.request<any>("GET /repos/{owner}/{repo}/commits/{ref}", {
          owner: input.owner,
          repo: input.repo,
          ref: input.ref,
        })

        const files = Array.isArray(commit.files) ? commit.files : []
        const totalFiles = files.length
        const returnedFiles = input.includeFiles ? files.slice(0, MAX_COMMIT_FILES) : []

        return {
          sha: commit.sha,
          shortSha: typeof commit.sha === "string" ? commit.sha.slice(0, 7) : null,
          message: typeof commit.commit?.message === "string" ? commit.commit.message : null,
          author: toActor(commit.author) ?? toActor(commit.commit?.author),
          committer: toActor(commit.committer) ?? toActor(commit.commit?.committer),
          committedAt: commit.commit?.author?.date ?? null,
          htmlUrl: typeof commit.html_url === "string" ? commit.html_url : null,
          parents: Array.isArray(commit.parents)
            ? commit.parents.map((p: any) => ({ sha: p.sha, htmlUrl: p.html_url ?? null }))
            : [],
          stats: {
            additions: commit.stats?.additions ?? 0,
            deletions: commit.stats?.deletions ?? 0,
            total: commit.stats?.total ?? 0,
          },
          files: {
            total: totalFiles,
            returned: returnedFiles.length,
            truncated: returnedFiles.length < totalFiles,
            items: returnedFiles.map((f: any) => {
              const patch = typeof f.patch === "string" ? truncateBytes(f.patch, MAX_COMMIT_PATCH_BYTES) : null
              return {
                filename: f.filename,
                status: f.status,
                additions: f.additions ?? 0,
                deletions: f.deletions ?? 0,
                changes: f.changes ?? 0,
                previousFilename: typeof f.previous_filename === "string" ? f.previous_filename : null,
                blobUrl: typeof f.blob_url === "string" ? f.blob_url : null,
                patch: patch ? { text: patch.text, truncated: patch.truncated, totalBytes: patch.totalBytes } : null,
              }
            }),
          },
        }
      })

      if (isGitHubToolError(result)) return toToolResult(result)

      const sources: SourceItem[] = result.htmlUrl
        ? [
            {
              type: "github",
              title:
                `${input.owner}/${input.repo}@${result.shortSha ?? ""}: ${(result.message ?? "").split("\n")[0] ?? ""}`.slice(
                  0,
                  200
                ),
              url: result.htmlUrl,
            },
          ]
        : []

      return {
        output: JSON.stringify({ owner: input.owner, repo: input.repo, commit: result }),
        sources,
      }
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({ tool: "github_get_commit", repo: `${input.owner}/${input.repo}`, ref: input.ref }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}
