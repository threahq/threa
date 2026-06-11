import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threa/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { toTraceGithubSources } from "./trace"

const ListReposSchema = z.object({})

export type ListReposInput = z.infer<typeof ListReposSchema>

export function createGithubListReposTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_list_repos",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_LIST_REPOS],
    description: `List the GitHub repositories the workspace's GitHub App installation can access. Use this first to discover which owner/repo pairs are available before calling other GitHub tools. Returns repo full names (owner/repo), privacy, and default branch.`,
    inputSchema: ListReposSchema,

    execute: async (): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
        const repos: any[] = []
        let page = 1
        for (;;) {
          const response = await client.request<any>("GET /installation/repositories", { per_page: 100, page })
          const items = Array.isArray(response?.repositories) ? response.repositories : []
          repos.push(...items)
          if (items.length < 100) break
          page += 1
          if (page > 5) break // hard cap: 500 repos per tool call
        }
        return repos.map((r) => ({
          fullName: r.full_name,
          private: Boolean(r.private),
          defaultBranch: typeof r.default_branch === "string" ? r.default_branch : null,
          description: typeof r.description === "string" ? r.description : null,
          htmlUrl: typeof r.html_url === "string" ? r.html_url : null,
        }))
      })

      if (isGitHubToolError(result)) return toToolResult(result)

      const sources: SourceItem[] = result
        .filter((r): r is typeof r & { htmlUrl: string } => typeof r.htmlUrl === "string")
        .slice(0, 10)
        .map((r) => ({ type: "github", title: r.fullName, url: r.htmlUrl }))

      return {
        output: JSON.stringify({ count: result.length, repositories: result }),
        sources,
      }
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: () => JSON.stringify({ tool: "github_list_repos" }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}

const ListBranchesSchema = z.object({
  owner: z.string().min(1).describe("Repository owner (org or user login)"),
  repo: z.string().min(1).describe("Repository name"),
  perPage: z.number().int().min(1).max(100).optional().default(30).describe("Number of branches per page (max 100)"),
  page: z.number().int().min(1).optional().default(1).describe("1-indexed page number"),
})

export type ListBranchesInput = z.infer<typeof ListBranchesSchema>

export function createGithubListBranchesTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_list_branches",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_LIST_BRANCHES],
    description: `List branches in a GitHub repository. Returns branch names and the commit SHA each branch points at. Paginated; use page/perPage for more.`,
    inputSchema: ListBranchesSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
        const response = await client.request<any[]>("GET /repos/{owner}/{repo}/branches", {
          owner: input.owner,
          repo: input.repo,
          per_page: input.perPage,
          page: input.page,
        })
        return response.map((b) => ({
          name: b.name,
          sha: b.commit?.sha,
          protected: Boolean(b.protected),
        }))
      })

      if (isGitHubToolError(result)) return toToolResult(result)

      return {
        output: JSON.stringify({
          owner: input.owner,
          repo: input.repo,
          page: input.page,
          perPage: input.perPage,
          count: result.length,
          branches: result,
        }),
      }
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({ tool: "github_list_branches", repo: `${input.owner}/${input.repo}`, page: input.page }),
    },
  })
}
