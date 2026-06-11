import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threa/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { toActor, truncateBytes } from "./format"
import { toTraceGithubSources } from "./trace"

const MAX_ISSUE_BODY_BYTES = 8_000
const MAX_ISSUE_COMMENTS = 20
const MAX_ISSUE_COMMENT_BYTES = 2_000

const SearchIssuesSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Search query. Supports GitHub issue/PR qualifiers like is:open, is:closed, is:pr, label:, author:, assignee:, milestone:"
    ),
  owner: z.string().min(1).describe("Repository owner; automatically added to the query as repo:owner/repo"),
  repo: z.string().min(1).describe("Repository name"),
  sort: z.enum(["created", "updated", "comments", "reactions", "best-match"]).optional().default("best-match"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  perPage: z.number().int().min(1).max(100).optional().default(20),
  page: z.number().int().min(1).optional().default(1),
})

export type SearchIssuesInput = z.infer<typeof SearchIssuesSchema>

export function createGithubSearchIssuesTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_search_issues",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_SEARCH_ISSUES],
    description: `Search issues and pull requests using GitHub's issue search. Auto-scopes to the given repo. Returns titles, numbers, states, authors, labels, and timestamps. Use is:issue or is:pr qualifiers to restrict to one type.`,
    inputSchema: SearchIssuesSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const scopedQuery = `${input.query} repo:${input.owner}/${input.repo}`

      const result = await withGithubClient(deps, async (client) => {
        const response = await client.request<any>("GET /search/issues", {
          q: scopedQuery,
          sort: input.sort === "best-match" ? undefined : input.sort,
          order: input.order,
          per_page: input.perPage,
          page: input.page,
        })
        const items = Array.isArray(response?.items) ? response.items : []
        return {
          totalCount: response?.total_count ?? 0,
          incompleteResults: Boolean(response?.incomplete_results),
          items: items.map((i: any) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            kind: i.pull_request ? "pull_request" : "issue",
            author: toActor(i.user),
            labels: Array.isArray(i.labels)
              ? i.labels.flatMap((l: any) => (typeof l?.name === "string" ? [l.name] : []))
              : [],
            commentCount: i.comments ?? 0,
            createdAt: i.created_at,
            updatedAt: i.updated_at,
            closedAt: i.closed_at ?? null,
            htmlUrl: typeof i.html_url === "string" ? i.html_url : null,
          })),
        }
      })

      if (isGitHubToolError(result)) return toToolResult(result)

      const sources: SourceItem[] = result.items
        .filter((i: any): i is any & { htmlUrl: string } => typeof i.htmlUrl === "string")
        .slice(0, 10)
        .map((i: any) => ({
          type: "github" as const,
          title: `${i.kind === "pull_request" ? "PR" : "Issue"} #${i.number}: ${i.title}`.slice(0, 200),
          url: i.htmlUrl,
        }))

      return {
        output: JSON.stringify({ owner: input.owner, repo: input.repo, query: input.query, ...result }),
        sources,
      }
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({
          tool: "github_search_issues",
          repo: `${input.owner}/${input.repo}`,
          query: input.query,
          page: input.page,
        }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}

const GetIssueSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().min(1).describe("Issue or pull request number"),
  includeComments: z.boolean().optional().default(true).describe("Include the most recent comments on the issue"),
})

export type GetIssueInput = z.infer<typeof GetIssueSchema>

export function createGithubGetIssueTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_get_issue",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_GET_ISSUE],
    description: `Fetch a single issue (or PR, via the issue endpoint) with full body (truncated to ${MAX_ISSUE_BODY_BYTES} bytes), labels, assignees, and up to ${MAX_ISSUE_COMMENTS} most recent comments (each truncated to ${MAX_ISSUE_COMMENT_BYTES} bytes). For PR-specific detail (branches, review state, diff), use github_get_pull_request.`,
    inputSchema: GetIssueSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
        const issue = await client.request<any>("GET /repos/{owner}/{repo}/issues/{issue_number}", {
          owner: input.owner,
          repo: input.repo,
          issue_number: input.number,
        })

        const bodyText = typeof issue.body === "string" ? issue.body : ""
        const body = truncateBytes(bodyText, MAX_ISSUE_BODY_BYTES)

        let comments: Array<{
          id: number
          author: ReturnType<typeof toActor>
          body: { text: string; truncated: boolean; totalBytes: number }
          createdAt: string
          updatedAt: string
          htmlUrl: string | null
        }> = []
        if (input.includeComments && (issue.comments ?? 0) > 0) {
          // Request newest-first and take the first N so issues with >100 comments
          // still surface the latest activity (default ascending order would give us
          // the oldest N from page 1).
          const commentsResponse = await client.request<any[]>(
            "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
            {
              owner: input.owner,
              repo: input.repo,
              issue_number: input.number,
              per_page: MAX_ISSUE_COMMENTS,
              sort: "created",
              direction: "desc",
            }
          )
          const latestFirst = commentsResponse.slice(0, MAX_ISSUE_COMMENTS).reverse()
          comments = latestFirst.map((c: any) => {
            const b = truncateBytes(typeof c.body === "string" ? c.body : "", MAX_ISSUE_COMMENT_BYTES)
            return {
              id: c.id,
              author: toActor(c.user),
              body: { text: b.text, truncated: b.truncated, totalBytes: b.totalBytes },
              createdAt: c.created_at,
              updatedAt: c.updated_at,
              htmlUrl: typeof c.html_url === "string" ? c.html_url : null,
            }
          })
        }

        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          kind: issue.pull_request ? "pull_request" : "issue",
          author: toActor(issue.user),
          body: { text: body.text, truncated: body.truncated, totalBytes: body.totalBytes },
          labels: Array.isArray(issue.labels)
            ? issue.labels.flatMap((l: any) => (typeof l?.name === "string" ? [l.name] : []))
            : [],
          assignees: Array.isArray(issue.assignees) ? issue.assignees.map(toActor).filter(Boolean) : [],
          commentCount: issue.comments ?? 0,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at ?? null,
          htmlUrl: typeof issue.html_url === "string" ? issue.html_url : null,
          comments,
        }
      })

      if (isGitHubToolError(result)) return toToolResult(result)

      const sources: SourceItem[] = result.htmlUrl
        ? [
            {
              type: "github",
              title: `${result.kind === "pull_request" ? "PR" : "Issue"} #${result.number}: ${result.title}`.slice(
                0,
                200
              ),
              url: result.htmlUrl,
            },
          ]
        : []

      return {
        output: JSON.stringify({ owner: input.owner, repo: input.repo, issue: result }),
        sources,
      }
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({ tool: "github_get_issue", repo: `${input.owner}/${input.repo}`, number: input.number }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}
