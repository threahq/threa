import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threahq/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { toActor, truncateBytes } from "./format"
import { toTraceGithubSources } from "./trace"

const MAX_COMMIT_FILES = 30
const MAX_COMMIT_PATCH_BYTES = 32_000

const CommitsSchema = z
  .object({
    mode: z
      .enum(["list", "get"])
      .describe(
        "list: commits on a branch/path, newest first (one-line messages). get: a single commit with full message, stats, and optional file patches (requires ref)."
      ),
    owner: z.string().min(1).describe("Repository owner"),
    repo: z.string().min(1).describe("Repository name"),
    // list filters
    sha: z
      .string()
      .optional()
      .describe("list: branch, tag, or commit SHA to start from. Defaults to the repo's default branch"),
    path: z.string().optional().describe("list: only commits that modify this file path"),
    author: z.string().optional().describe("list: GitHub username or email to filter by author"),
    since: z.string().optional().describe("list: ISO 8601 timestamp; only commits after this time"),
    until: z.string().optional().describe("list: ISO 8601 timestamp; only commits before this time"),
    perPage: z.number().int().min(1).max(100).optional().default(20).describe("list: commits per page (max 100)"),
    page: z.number().int().min(1).optional().default(1).describe("list: 1-indexed page number"),
    // get params
    ref: z.string().min(1).optional().describe("get: commit SHA (full or short) or a branch/tag name to resolve"),
    includeFiles: z
      .boolean()
      .optional()
      .default(true)
      .describe("get: when true, include the changed-files list and diff patches (truncated)"),
  })
  // ref backs the {ref} path param for a single-commit fetch — required for get,
  // unused for list, so it's optional at the schema level and enforced per-mode here.
  .superRefine((value, ctx) => {
    if (value.mode === "get" && !value.ref) {
      ctx.addIssue({ code: "custom", path: ["ref"], message: "ref is required when mode=get" })
    }
  })

export type CommitsInput = z.infer<typeof CommitsSchema>

async function listCommits(deps: GitHubToolDeps, input: CommitsInput): Promise<AgentToolResult> {
  const result = await withGithubClient(deps, input.owner, async (client) => {
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
}

async function getCommit(deps: GitHubToolDeps, input: CommitsInput): Promise<AgentToolResult> {
  const result = await withGithubClient(deps, input.owner, async (client) => {
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
}

export function createGithubCommitsTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_commits",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_COMMITS],
    description: `Read commits in a GitHub repository. mode=list returns commits on a branch or path, newest first (short SHA, author, date, first message line); filter by sha/path/author/since/until and paginate. mode=get fetches one commit (by ref) with full message, stats, and optional changed-file patches — patches truncated to ${MAX_COMMIT_PATCH_BYTES} bytes each, max ${MAX_COMMIT_FILES} files.`,
    inputSchema: CommitsSchema,

    execute: async (input): Promise<AgentToolResult> => {
      if (input.mode === "get") return getCommit(deps, input)
      return listCommits(deps, input)
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify(
          input.mode === "get"
            ? { tool: "github_commits", mode: "get", repo: `${input.owner}/${input.repo}`, ref: input.ref }
            : {
                tool: "github_commits",
                mode: "list",
                repo: `${input.owner}/${input.repo}`,
                path: input.path ?? null,
                author: input.author ?? null,
                page: input.page,
              }
        ),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}
