import { describe, it, expect } from "bun:test"
import { createGithubCommitsTool } from "./commits"
import { createGithubContentTool } from "./content"
import { createGithubPullsTool } from "./pull-requests"
import { createGithubIssuesTool } from "./issues"
import { createGithubWorkflowsTool } from "./workflows"
import type { GitHubToolDeps } from "./deps"
import type { GitHubClient } from "../../../workspace-integrations"

type RequestFn = (route: string, params?: Record<string, unknown>) => Promise<unknown>

function makeDeps(request: RequestFn | null): GitHubToolDeps {
  return {
    workspaceId: "ws_test",
    getClient: async () => (request ? ({ request } as unknown as GitHubClient) : null),
  }
}

const toolOpts = { toolCallId: "test" }

describe("github_commits mode=list", () => {
  it("returns the not-connected error when GitHub is not installed", async () => {
    const tool = createGithubCommitsTool(makeDeps(null))
    const { output } = await tool.config.execute(
      { mode: "list", owner: "o", repo: "r", page: 1, perPage: 20 },
      toolOpts
    )
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe("GITHUB_NOT_CONNECTED")
  })

  it("maps commit responses and builds github sources", async () => {
    const request: RequestFn = async (route) => {
      expect(route).toBe("GET /repos/{owner}/{repo}/commits")
      return [
        {
          sha: "abc1234def",
          commit: {
            message: "Fix authentication bug\n\nDetails follow",
            author: { date: "2026-04-20T10:00:00Z" },
          },
          author: { login: "octocat", html_url: "https://github.com/octocat" },
          html_url: "https://github.com/o/r/commit/abc1234def",
        },
      ]
    }
    const tool = createGithubCommitsTool(makeDeps(request))
    const result = await tool.config.execute({ mode: "list", owner: "o", repo: "r", page: 1, perPage: 20 }, toolOpts)
    const parsed = JSON.parse(result.output)
    expect(parsed.count).toBe(1)
    expect(parsed.commits[0].shortSha).toBe("abc1234")
    expect(parsed.commits[0].message).toBe("Fix authentication bug")
    expect(parsed.commits[0].author.login).toBe("octocat")
    expect(result.sources?.[0].type).toBe("github")
    expect(result.sources?.[0].url).toContain("abc1234")
  })

  it("maps 404 responses to GITHUB_NOT_FOUND", async () => {
    const request: RequestFn = async () => {
      const err = new Error("Not Found") as Error & { status: number }
      err.status = 404
      throw err
    }
    const tool = createGithubCommitsTool(makeDeps(request))
    const { output } = await tool.config.execute(
      { mode: "list", owner: "o", repo: "r", page: 1, perPage: 20 },
      toolOpts
    )
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe("GITHUB_NOT_FOUND")
  })
})

describe("github_commits mode=get", () => {
  it("truncates large file patches and reports sizes", async () => {
    const bigPatch = "+".repeat(50_000)
    const request: RequestFn = async (route) => {
      expect(route).toBe("GET /repos/{owner}/{repo}/commits/{ref}")
      return {
        sha: "abc1234def",
        commit: { message: "big commit", author: { date: "2026-04-20T10:00:00Z" } },
        html_url: "https://github.com/o/r/commit/abc1234def",
        files: [{ filename: "a.ts", status: "modified", additions: 100, deletions: 0, patch: bigPatch }],
        stats: { additions: 100, deletions: 0, total: 100 },
      }
    }
    const tool = createGithubCommitsTool(makeDeps(request))
    const result = await tool.config.execute(
      { mode: "get", owner: "o", repo: "r", ref: "abc1234", includeFiles: true },
      toolOpts
    )
    const parsed = JSON.parse(result.output)
    const patch = parsed.commit.files.items[0].patch
    expect(patch.truncated).toBe(true)
    expect(patch.totalBytes).toBe(50_000)
    expect(patch.text.length).toBeLessThan(50_000)
  })
})

describe("github_content mode=get_file", () => {
  it("decodes base64 content and honors line ranges", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")
    const base64 = Buffer.from(lines, "utf8").toString("base64")
    const request: RequestFn = async (route) => {
      expect(route).toBe("GET /repos/{owner}/{repo}/contents/{path}")
      return {
        type: "file",
        path: "src/auth.ts",
        content: base64,
        sha: "file-sha",
        size: lines.length,
        html_url: "https://github.com/o/r/blob/main/src/auth.ts",
      }
    }
    const tool = createGithubContentTool(makeDeps(request))
    const result = await tool.config.execute(
      { mode: "get_file", owner: "o", repo: "r", path: "src/auth.ts", fromLine: 3, toLine: 5 },
      toolOpts
    )
    const parsed = JSON.parse(result.output)
    expect(parsed.file.startLine).toBe(3)
    expect(parsed.file.endLine).toBe(5)
    expect(parsed.file.content).toBe("line 3\nline 4\nline 5")
    expect(parsed.file.totalLines).toBe(10)
    expect(result.sources?.[0].type).toBe("github")
  })

  it("reports binary files without returning content", async () => {
    const binary = "\x00\x01\x02hello"
    const base64 = Buffer.from(binary, "utf8").toString("base64")
    const request: RequestFn = async () => ({ type: "file", path: "x", content: base64 })
    const tool = createGithubContentTool(makeDeps(request))
    const result = await tool.config.execute({ mode: "get_file", owner: "o", repo: "r", path: "x" }, toolOpts)
    const parsed = JSON.parse(result.output)
    expect(parsed.code).toBe("BINARY")
  })
})

describe("github_pulls mode=get", () => {
  it("fetches PR, reviews, and commits concurrently and summarizes reviews", async () => {
    const calls: string[] = []
    const request: RequestFn = async (route) => {
      calls.push(route)
      switch (route) {
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
          return {
            number: 42,
            title: "Refactor auth",
            state: "open",
            body: "This touches AuthService and SessionRepo.",
            user: { login: "octocat", html_url: "https://github.com/octocat" },
            base: { ref: "main" },
            head: { ref: "refactor-auth" },
            additions: 100,
            deletions: 40,
            changed_files: 5,
            commits: 3,
            html_url: "https://github.com/o/r/pull/42",
            requested_reviewers: [{}],
            requested_teams: [],
          }
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return [
            { user: { login: "alice" }, state: "APPROVED" },
            { user: { login: "bob" }, state: "CHANGES_REQUESTED" },
            { user: { login: "alice" }, state: "APPROVED" },
          ]
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits":
          return [{ sha: "aaa1111222", commit: { message: "one", author: { date: "2026-04-20T10:00:00Z" } } }]
        default:
          throw new Error(`unexpected route: ${route}`)
      }
    }
    const tool = createGithubPullsTool(makeDeps(request))
    const result = await tool.config.execute({ mode: "get", owner: "o", repo: "r", number: 42 }, toolOpts)
    const parsed = JSON.parse(result.output)
    expect(calls).toHaveLength(3)
    expect(parsed.pullRequest.number).toBe(42)
    expect(parsed.pullRequest.reviews.approvals).toBe(1)
    expect(parsed.pullRequest.reviews.changesRequested).toBe(1)
    expect(parsed.pullRequest.reviews.pendingReviewers).toBe(1)
    expect(result.sources?.[0].url).toBe("https://github.com/o/r/pull/42")
  })

  it("returns null recentCommits when the PR has more commits than fit on one page", async () => {
    const request: RequestFn = async (route) => {
      switch (route) {
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
          return {
            number: 1,
            title: "Big PR",
            state: "open",
            body: "",
            commits: 250,
            html_url: "https://github.com/o/r/pull/1",
          }
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
          return []
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits":
          return Array.from({ length: 100 }, (_, i) => ({
            sha: `sha${i}`,
            commit: { message: `c${i}`, author: { date: "2026-04-20T10:00:00Z" } },
          }))
        default:
          throw new Error(`unexpected: ${route}`)
      }
    }
    const tool = createGithubPullsTool(makeDeps(request))
    const { output } = await tool.config.execute({ mode: "get", owner: "o", repo: "r", number: 1 }, toolOpts)
    const parsed = JSON.parse(output)
    expect(parsed.pullRequest.recentCommits).toBeNull()
    expect(parsed.pullRequest.commitsCount).toBe(250)
  })
})

describe("github_pulls mode=files", () => {
  it("truncates per-file patches over the byte cap", async () => {
    const bigPatch = "+".repeat(30_000)
    const request: RequestFn = async () => [
      { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: bigPatch },
      { filename: "b.ts", status: "added", additions: 1, deletions: 0 },
    ]
    const tool = createGithubPullsTool(makeDeps(request))
    const { output } = await tool.config.execute(
      { mode: "files", owner: "o", repo: "r", number: 1, includePatches: true, perPage: 30, page: 1 },
      toolOpts
    )
    const parsed = JSON.parse(output)
    expect(parsed.files[0].patch.truncated).toBe(true)
    expect(parsed.files[1].patch).toBeNull()
  })
})

describe("github_issues mode=get", () => {
  it("requests comments newest-first and returns them in chronological order", async () => {
    const captured: Array<Record<string, unknown> | undefined> = []
    const request: RequestFn = async (route, params) => {
      captured.push(params)
      switch (route) {
        case "GET /repos/{owner}/{repo}/issues/{issue_number}":
          return {
            number: 7,
            title: "Bug",
            state: "open",
            body: "",
            comments: 300,
            html_url: "https://github.com/o/r/issues/7",
          }
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
          // GitHub returns newest-first given direction=desc; simulate.
          return [
            { id: 3, body: "newest", user: { login: "a" }, created_at: "3", updated_at: "3" },
            { id: 2, body: "middle", user: { login: "b" }, created_at: "2", updated_at: "2" },
            { id: 1, body: "oldest", user: { login: "c" }, created_at: "1", updated_at: "1" },
          ]
        default:
          throw new Error(`unexpected: ${route}`)
      }
    }
    const tool = createGithubIssuesTool(makeDeps(request))
    const { output } = await tool.config.execute(
      { mode: "get", owner: "o", repo: "r", number: 7, includeComments: true },
      toolOpts
    )
    const parsed = JSON.parse(output)
    const commentsCall = captured[1] as Record<string, unknown>
    expect(commentsCall.direction).toBe("desc")
    expect(commentsCall.sort).toBe("created")
    // Returned to caller chronologically (oldest first → newest last) so the
    // model reads the conversation naturally.
    expect(parsed.issue.comments.map((c: any) => c.id)).toEqual([1, 2, 3])
  })
})

describe("github_workflows mode=get_run", () => {
  it("fetches failed job logs only and returns tail", async () => {
    const longLog = "log line\n".repeat(5_000)
    const request: RequestFn = async (route, params) => {
      switch (route) {
        case "GET /repos/{owner}/{repo}/actions/runs/{run_id}":
          return {
            id: 1,
            name: "CI",
            workflow_id: 9,
            event: "push",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/o/r/actions/runs/1",
            run_number: 10,
          }
        case "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs":
          return {
            jobs: [
              { id: 101, name: "build", status: "completed", conclusion: "success" },
              { id: 102, name: "test", status: "completed", conclusion: "failure" },
            ],
          }
        case "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs": {
          expect(params?.job_id).toBe(102)
          return longLog
        }
        default:
          throw new Error(`unexpected route ${route}`)
      }
    }
    const tool = createGithubWorkflowsTool(makeDeps(request))
    const result = await tool.config.execute(
      { mode: "get_run", owner: "o", repo: "r", runId: 1, includeFailedJobLogs: true },
      toolOpts
    )
    const parsed = JSON.parse(result.output)
    const successJob = parsed.run.jobs.find((j: any) => j.name === "build")
    const failedJob = parsed.run.jobs.find((j: any) => j.name === "test")
    expect(successJob.logs).toBeNull()
    expect(failedJob.logs.truncated).toBe(true)
    expect(Buffer.byteLength(failedJob.logs.tail, "utf8")).toBeLessThanOrEqual(12_000)
    expect(failedJob.logs.totalBytes).toBe(Buffer.byteLength(longLog, "utf8"))
    expect(parsed.run.failedJobCount).toBe(1)
  })
})
