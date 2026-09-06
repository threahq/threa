import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threahq/types"
import { logger } from "../../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { toTraceGithubSources } from "./trace"

const MAX_JOBS_PER_RUN = 20
const MAX_JOB_LOG_BYTES = 12_000

const WorkflowsSchema = z
  .object({
    mode: z
      .enum(["list_runs", "get_run"])
      .describe(
        "list_runs: GitHub Actions workflow runs for a repo, newest first (filterable). get_run: one run with job-level detail and the tail of failed job logs (requires runId)."
      ),
    owner: z.string().min(1).describe("Repository owner"),
    repo: z.string().min(1).describe("Repository name"),
    // list_runs filters
    status: z
      .enum([
        "completed",
        "action_required",
        "cancelled",
        "failure",
        "neutral",
        "skipped",
        "stale",
        "success",
        "timed_out",
        "in_progress",
        "queued",
        "requested",
        "waiting",
      ])
      .optional()
      .describe("list_runs: filter by run status/conclusion"),
    branch: z.string().optional().describe("list_runs: filter by head branch"),
    event: z.string().optional().describe("list_runs: filter by event (push, pull_request, etc.)"),
    workflowId: z
      .union([z.string(), z.number()])
      .optional()
      .describe("list_runs: filter to a single workflow by file name (e.g. ci.yml) or numeric ID"),
    perPage: z.number().int().min(1).max(100).optional().default(20).describe("list_runs: runs per page (max 100)"),
    page: z.number().int().min(1).optional().default(1).describe("list_runs: 1-indexed page number"),
    // get_run params
    runId: z.number().int().min(1).optional().describe("get_run: workflow run ID. Required for get_run."),
    includeFailedJobLogs: z
      .boolean()
      .optional()
      .default(true)
      .describe("get_run: when true and the run failed, fetch the tail of each failed job's logs (truncated per job)"),
  })
  // runId identifies the single run for get_run; list_runs enumerates instead,
  // so it's optional at the schema level and required for get_run here.
  .superRefine((value, ctx) => {
    if (value.mode === "get_run" && value.runId === undefined) {
      ctx.addIssue({ code: "custom", path: ["runId"], message: "runId is required when mode=get_run" })
    }
  })

export type WorkflowsInput = z.infer<typeof WorkflowsSchema>

async function listWorkflowRuns(deps: GitHubToolDeps, input: WorkflowsInput): Promise<AgentToolResult> {
  const route = input.workflowId
    ? "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs"
    : "GET /repos/{owner}/{repo}/actions/runs"

  const result = await withGithubClient(deps, input.owner, async (client) => {
    const response = await client.request<any>(route, {
      owner: input.owner,
      repo: input.repo,
      workflow_id: input.workflowId,
      status: input.status,
      branch: input.branch,
      event: input.event,
      per_page: input.perPage,
      page: input.page,
    })
    const runs = Array.isArray(response?.workflow_runs) ? response.workflow_runs : []
    return {
      totalCount: response?.total_count ?? 0,
      runs: runs.map((r: any) => ({
        id: r.id,
        name: r.name,
        workflowId: r.workflow_id,
        event: r.event,
        status: r.status,
        conclusion: r.conclusion,
        headBranch: r.head_branch,
        headSha: r.head_sha,
        runNumber: r.run_number,
        runAttempt: r.run_attempt,
        displayTitle: r.display_title,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        htmlUrl: typeof r.html_url === "string" ? r.html_url : null,
      })),
    }
  })

  if (isGitHubToolError(result)) return toToolResult(result)

  const sources: SourceItem[] = result.runs
    .filter((r: any): r is any & { htmlUrl: string } => typeof r.htmlUrl === "string")
    .slice(0, 10)
    .map((r: any) => ({
      type: "github" as const,
      title: `${r.name ?? "workflow"} #${r.runNumber} (${r.conclusion ?? r.status})`.slice(0, 200),
      url: r.htmlUrl,
    }))

  return {
    output: JSON.stringify({ owner: input.owner, repo: input.repo, ...result }),
    sources,
  }
}

async function getWorkflowRun(deps: GitHubToolDeps, input: WorkflowsInput): Promise<AgentToolResult> {
  const result = await withGithubClient(deps, input.owner, async (client) => {
    const [run, jobsResponse] = await Promise.all([
      client.request<any>("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
        owner: input.owner,
        repo: input.repo,
        run_id: input.runId,
      }),
      client.request<any>("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
        owner: input.owner,
        repo: input.repo,
        run_id: input.runId,
        per_page: 100,
      }),
    ])

    const jobs = Array.isArray(jobsResponse?.jobs) ? jobsResponse.jobs.slice(0, MAX_JOBS_PER_RUN) : []
    const failedJobs = jobs.filter((j: any) => j.conclusion && j.conclusion !== "success" && j.conclusion !== "skipped")

    const jobsWithLogs = await Promise.all(
      jobs.map(async (j: any) => {
        const base = {
          id: j.id,
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          startedAt: j.started_at,
          completedAt: j.completed_at,
          runnerName: j.runner_name ?? null,
          htmlUrl: typeof j.html_url === "string" ? j.html_url : null,
          steps: Array.isArray(j.steps)
            ? j.steps.map((s: any) => ({
                name: s.name,
                status: s.status,
                conclusion: s.conclusion,
                number: s.number,
                startedAt: s.started_at,
                completedAt: s.completed_at,
              }))
            : [],
          logs: null as null | { tail: string; truncated: boolean; totalBytes: number },
        }
        if (!input.includeFailedJobLogs) return base
        if (!failedJobs.includes(j)) return base
        try {
          const logs = await client.request<string>("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
            owner: input.owner,
            repo: input.repo,
            job_id: j.id,
          })
          if (typeof logs !== "string") return base
          const buf = Buffer.from(logs, "utf8")
          const totalBytes = buf.length
          let tailStart = Math.max(0, totalBytes - MAX_JOB_LOG_BYTES)
          // Walk forward past any UTF-8 continuation bytes (10xxxxxx) so we
          // don't slice mid-character and emit U+FFFD at the tail's head.
          while (tailStart < totalBytes && (buf[tailStart] & 0xc0) === 0x80) tailStart += 1
          const tail = buf.subarray(tailStart).toString("utf8")
          base.logs = { tail, truncated: tailStart > 0, totalBytes }
        } catch (err) {
          logger.warn(
            { err, workspaceId: deps.workspaceId, runId: input.runId, jobId: j.id },
            "failed to fetch workflow job logs"
          )
        }
        return base
      })
    )

    return {
      id: run.id,
      name: run.name,
      workflowId: run.workflow_id,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      runNumber: run.run_number,
      runAttempt: run.run_attempt,
      displayTitle: run.display_title,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      htmlUrl: typeof run.html_url === "string" ? run.html_url : null,
      jobs: jobsWithLogs,
      failedJobCount: failedJobs.length,
    }
  })

  if (isGitHubToolError(result)) return toToolResult(result)

  const sources: SourceItem[] = result.htmlUrl
    ? [
        {
          type: "github",
          title: `${result.name ?? "workflow"} #${result.runNumber} (${result.conclusion ?? result.status})`.slice(
            0,
            200
          ),
          url: result.htmlUrl,
        },
      ]
    : []

  return {
    output: JSON.stringify({ owner: input.owner, repo: input.repo, run: result }),
    sources,
  }
}

export function createGithubWorkflowsTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_workflows",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_WORKFLOWS],
    description: `Inspect GitHub Actions. mode=list_runs lists workflow runs newest first (filter by status incl. failure/success/in_progress, branch, event, or a specific workflow file) returning run IDs, event, branch, SHA, status, conclusion, and timing. mode=get_run fetches one run (by runId) with job-level detail; when includeFailedJobLogs is true (default) and the run did not succeed, it also returns the tail of each failed job's log (${MAX_JOB_LOG_BYTES} bytes per job, max ${MAX_JOBS_PER_RUN} jobs) — use it to diagnose CI failures.`,
    inputSchema: WorkflowsSchema,

    execute: async (input): Promise<AgentToolResult> => {
      if (input.mode === "get_run") return getWorkflowRun(deps, input)
      return listWorkflowRuns(deps, input)
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify(
          input.mode === "get_run"
            ? { tool: "github_workflows", mode: "get_run", repo: `${input.owner}/${input.repo}`, runId: input.runId }
            : {
                tool: "github_workflows",
                mode: "list_runs",
                repo: `${input.owner}/${input.repo}`,
                status: input.status ?? null,
                branch: input.branch ?? null,
              }
        ),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}
