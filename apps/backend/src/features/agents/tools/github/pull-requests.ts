import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threa/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { toActor, truncateBytes } from "./format"
import { toTraceGithubSources } from "./trace"

const MAX_PR_BODY_BYTES = 8_000
const MAX_PR_FILES = 50
const MAX_PR_FILE_PATCH_BYTES = 16_000

const ListPullRequestsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  state: z.enum(["open", "closed", "all"]).optional().default("open").describe("Filter by PR state"),
  base: z.string().optional().describe("Filter by base branch (e.g. main)"),
  head: z.string().optional().describe("Filter by head user:branch"),
  sort: z.enum(["created", "updated", "popularity", "long-running"]).optional().default("created"),
  direction: z.enum(["asc", "desc"]).optional().default("desc"),
  perPage: z.number().int().min(1).max(100).optional().default(20),
  page: z.number().int().min(1).optional().default(1),
})

export type ListPullRequestsInput = z.infer<typeof ListPullRequestsSchema>

export function createGithubListPullRequestsTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_list_pull_requests",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_LIST_PULL_REQUESTS],
    description: `List pull requests in a GitHub repository. Filter by state (open/closed/all), base branch, or head. Sort by created/updated/popularity/long-running. Returns PR numbers, titles, authors, branches, state, and timestamps.`,
    inputSchema: ListPullRequestsSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
        const response = await client.request<any[]>("GET /repos/{owner}/{repo}/pulls", {
          owner: input.owner,
          repo: input.repo,
          state: input.state,
          base: input.base,
          head: input.head,
          sort: input.sort,
          direction: input.direction,
          per_page: input.perPage,
          page: input.page,
        })
        return response.map((p) => ({
          number: p.number,
          title: p.title,
          state: normalizeState(p),
          draft: Boolean(p.draft),
          author: toActor(p.user),
          baseBranch: p.base?.ref ?? null,
          headBranch: p.head?.ref ?? null,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
          mergedAt: p.merged_at ?? null,
          htmlUrl: typeof p.html_url === "string" ? p.html_url : null,
        }))
      })

      if (isGitHubToolError(result)) return toToolResult(result)

      const sources: SourceItem[] = result
        .filter((p): p is typeof p & { htmlUrl: string } => typeof p.htmlUrl === "string")
        .slice(0, 10)
        .map((p) => ({
          type: "github",
          title: `PR #${p.number}: ${p.title}`.slice(0, 200),
          url: p.htmlUrl,
        }))

      return {
        output: JSON.stringify({
          owner: input.owner,
          repo: input.repo,
          state: input.state,
          page: input.page,
          perPage: input.perPage,
          count: result.length,
          pullRequests: result,
        }),
        sources,
      }
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({
          tool: "github_list_pull_requests",
          repo: `${input.owner}/${input.repo}`,
          state: input.state,
          page: input.page,
        }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}

const GetPullRequestSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().min(1).describe("Pull request number"),
})

export type GetPullRequestInput = z.infer<typeof GetPullRequestSchema>

export function createGithubGetPullRequestTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_get_pull_request",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_GET_PULL_REQUEST],
    description: `Fetch detailed PR information including title, body (truncated to ${MAX_PR_BODY_BYTES} bytes), author, branches, merge state, and review summary. For PRs with ≤100 commits the 10 most recent are included inline; larger PRs return null and should be explored via github_list_commits with --sha=<head-branch>. Use github_list_pr_files to see which files changed.`,
    inputSchema: GetPullRequestSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
        const [pull, reviews, commits] = await Promise.all([
          client.request<any>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            owner: input.owner,
            repo: input.repo,
            pull_number: input.number,
          }),
          client.request<any[]>("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
            owner: input.owner,
            repo: input.repo,
            pull_number: input.number,
            per_page: 100,
          }),
          client.request<any[]>("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
            owner: input.owner,
            repo: input.repo,
            pull_number: input.number,
            per_page: 100,
          }),
        ])

        const bodyText = typeof pull.body === "string" ? pull.body : ""
        const body = truncateBytes(bodyText, MAX_PR_BODY_BYTES)

        return {
          number: pull.number,
          title: pull.title,
          state: normalizeState(pull),
          draft: Boolean(pull.draft),
          author: toActor(pull.user),
          body: { text: body.text, truncated: body.truncated, totalBytes: body.totalBytes },
          baseBranch: pull.base?.ref ?? null,
          headBranch: pull.head?.ref ?? null,
          mergeable: pull.mergeable ?? null,
          mergeableState: pull.mergeable_state ?? null,
          additions: pull.additions ?? 0,
          deletions: pull.deletions ?? 0,
          changedFiles: pull.changed_files ?? 0,
          commitsCount: pull.commits ?? 0,
          createdAt: pull.created_at,
          updatedAt: pull.updated_at,
          mergedAt: pull.merged_at ?? null,
          closedAt: pull.closed_at ?? null,
          mergeCommitSha: pull.merge_commit_sha ?? null,
          htmlUrl: typeof pull.html_url === "string" ? pull.html_url : null,
          reviews: summarizeReviews(reviews, pull),
          // Commits come back oldest-first. Only surface them when we have the
          // full list — for PRs with >100 commits, page 1 doesn't contain the
          // most recent ones, and returning "recent commits" that aren't actually
          // the most recent would mislead the model. In that case suggest
          // github_list_commits for enumeration.
          recentCommits: commitsComplete(pull, commits)
            ? commits.slice(-10).map((c: any) => ({
                sha: c.sha,
                shortSha: typeof c.sha === "string" ? c.sha.slice(0, 7) : null,
                message: typeof c.commit?.message === "string" ? c.commit.message.split("\n")[0] : null,
                author: toActor(c.author) ?? toActor(c.commit?.author),
                committedAt: c.commit?.author?.date ?? null,
              }))
            : null,
        }
      })

      if (isGitHubToolError(result)) return toToolResult(result)

      const sources: SourceItem[] = result.htmlUrl
        ? [
            {
              type: "github",
              title: `PR #${result.number}: ${result.title}`.slice(0, 200),
              url: result.htmlUrl,
            },
          ]
        : []

      return {
        output: JSON.stringify({ owner: input.owner, repo: input.repo, pullRequest: result }),
        sources,
      }
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({ tool: "github_get_pull_request", repo: `${input.owner}/${input.repo}`, number: input.number }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}

const ListPrFilesSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().min(1),
  includePatches: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include per-file diff patches, truncated to bounded size"),
  perPage: z.number().int().min(1).max(100).optional().default(30),
  page: z.number().int().min(1).optional().default(1),
})

export type ListPrFilesInput = z.infer<typeof ListPrFilesSchema>

export function createGithubListPrFilesTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_list_pr_files",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_LIST_PR_FILES],
    description: `List files changed by a pull request with additions/deletions per file. Optionally include per-file diff patches (truncated to ${MAX_PR_FILE_PATCH_BYTES} bytes each, max ${MAX_PR_FILES} files per call). Paginate for larger PRs. Use this to see which paths a PR touched and what changed.`,
    inputSchema: ListPrFilesSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
        const response = await client.request<any[]>("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
          owner: input.owner,
          repo: input.repo,
          pull_number: input.number,
          per_page: Math.min(input.perPage, MAX_PR_FILES),
          page: input.page,
        })
        return response.map((f: any) => {
          const patch =
            input.includePatches && typeof f.patch === "string" ? truncateBytes(f.patch, MAX_PR_FILE_PATCH_BYTES) : null
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
        })
      })

      if (isGitHubToolError(result)) return toToolResult(result)

      return {
        output: JSON.stringify({
          owner: input.owner,
          repo: input.repo,
          number: input.number,
          page: input.page,
          perPage: input.perPage,
          count: result.length,
          files: result,
        }),
      }
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({
          tool: "github_list_pr_files",
          repo: `${input.owner}/${input.repo}`,
          number: input.number,
          page: input.page,
        }),
    },
  })
}

function commitsComplete(pull: any, fetchedCommits: unknown[]): boolean {
  const totalCount = typeof pull.commits === "number" ? pull.commits : fetchedCommits.length
  return fetchedCommits.length >= totalCount
}

function normalizeState(pull: any): "open" | "closed" | "merged" | "draft" {
  if (pull.merged_at) return "merged"
  if (pull.draft && pull.state !== "closed") return "draft"
  return pull.state === "closed" ? "closed" : "open"
}

function summarizeReviews(reviews: any[], pull: any) {
  const latestByUser = new Map<string, string>()
  for (const review of reviews) {
    const login = review.user?.login
    const state = review.state
    if (typeof login !== "string" || typeof state !== "string") continue
    latestByUser.set(login, state)
  }
  let approvals = 0
  let changesRequested = 0
  let comments = 0
  for (const state of latestByUser.values()) {
    if (state === "APPROVED") approvals += 1
    else if (state === "CHANGES_REQUESTED") changesRequested += 1
    else if (state === "COMMENTED") comments += 1
  }
  return {
    approvals,
    changesRequested,
    comments,
    pendingReviewers:
      (Array.isArray(pull.requested_reviewers) ? pull.requested_reviewers.length : 0) +
      (Array.isArray(pull.requested_teams) ? pull.requested_teams.length : 0),
  }
}
