import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threa/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { toTraceGithubSources } from "./trace"

const ReposSchema = z
  .object({
    mode: z
      .enum(["list_repos", "list_branches"])
      .describe(
        "list_repos: list every repository the workspace's GitHub App installation can access (takes no other arguments). list_branches: list branches in one repository (requires owner and repo)."
      ),
    owner: z
      .string()
      .min(1)
      .optional()
      .describe("Repository owner (org or user login). Required when mode=list_branches."),
    repo: z.string().min(1).optional().describe("Repository name. Required when mode=list_branches."),
    perPage: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(30)
      .describe("Branches per page (max 100). Used by list_branches."),
    page: z.number().int().min(1).optional().default(1).describe("1-indexed page number. Used by list_branches."),
  })
  // owner/repo are optional at the schema level because list_repos needs neither;
  // require them here for the one mode that does so the model gets a clear error
  // instead of a malformed request.
  .superRefine((value, ctx) => {
    if (value.mode === "list_branches") {
      if (!value.owner) {
        ctx.addIssue({ code: "custom", path: ["owner"], message: "owner is required when mode=list_branches" })
      }
      if (!value.repo) {
        ctx.addIssue({ code: "custom", path: ["repo"], message: "repo is required when mode=list_branches" })
      }
    }
  })

export type ReposInput = z.infer<typeof ReposSchema>

async function listRepos(deps: GitHubToolDeps): Promise<AgentToolResult> {
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
}

async function listBranches(deps: GitHubToolDeps, input: ReposInput): Promise<AgentToolResult> {
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
}

export function createGithubReposTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_repos",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_REPOS],
    description: `Discover and inspect GitHub repositories. mode=list_repos returns every repo the workspace's GitHub App installation can access (repo full names, privacy, default branch) — use it first to find which owner/repo pairs exist. mode=list_branches lists branches (name + head SHA) in a given owner/repo, paginated via page/perPage.`,
    inputSchema: ReposSchema,

    execute: async (input): Promise<AgentToolResult> => {
      if (input.mode === "list_repos") return listRepos(deps)
      return listBranches(deps, input)
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify(
          input.mode === "list_repos"
            ? { tool: "github_repos", mode: "list_repos" }
            : { tool: "github_repos", mode: "list_branches", repo: `${input.owner}/${input.repo}`, page: input.page }
        ),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}
