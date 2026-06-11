import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threa/types"
import { logger } from "../../../../lib/logger"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { toTraceGithubSources } from "./trace"

const MAX_JOBS_PER_RUN = 20
const MAX_JOB_LOG_BYTES = 12_000

const ListWorkflowRunsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
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
    .describe("Filter by run status/conclusion"),
  branch: z.string().optional().describe("Filter by head branch"),
  event: z.string().optional().describe("Filter by event (push, pull_request, etc.)"),
  workflowId: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Filter to a single workflow by file name (e.g. ci.yml) or numeric ID"),
  perPage: z.number().int().min(1).max(100).optional().default(20),
  page: z.number().int().min(1).optional().default(1),
})

export type ListWorkflowRunsInput = z.infer<typeof ListWorkflowRunsSchema>

export function createGithubListWorkflowRunsTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_list_workflow_runs",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_LIST_WORKFLOW_RUNS],
    description: `List GitHub Actions workflow runs for a repository, newest first. Filter by status (including failure, success, in_progress), branch, event, or a specific workflow file. Returns run IDs, the triggering event, head branch, commit SHA, status, conclusion, and timing.`,
    inputSchema: ListWorkflowRunsSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const route = input.workflowId
        ? "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs"
        : "GET /repos/{owner}/{repo}/actions/runs"

      const result = await withGithubClient(deps, async (client) => {
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
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({
          tool: "github_list_workflow_runs",
          repo: `${input.owner}/${input.repo}`,
          status: input.status ?? null,
          branch: input.branch ?? null,
        }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}

const GetWorkflowRunSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  runId: z.number().int().min(1).describe("Workflow run ID"),
  includeFailedJobLogs: z
    .boolean()
    .optional()
    .default(true)
    .describe("When true and the run failed, fetch the tail of each failed job's logs (truncated per job)"),
})

export type GetWorkflowRunInput = z.infer<typeof GetWorkflowRunSchema>

export function createGithubGetWorkflowRunTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_get_workflow_run",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_GET_WORKFLOW_RUN],
    description: `Fetch a GitHub Actions run with job-level detail. When includeFailedJobLogs is true (default) and the run did not succeed, this also fetches the tail of each failed job's log stream (${MAX_JOB_LOG_BYTES} bytes per job, max ${MAX_JOBS_PER_RUN} jobs). Use this to diagnose CI failures. Logs may be rotated or unavailable for very old runs.`,
    inputSchema: GetWorkflowRunSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withGithubClient(deps, async (client) => {
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
        const failedJobs = jobs.filter(
          (j: any) => j.conclusion && j.conclusion !== "success" && j.conclusion !== "skipped"
        )

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
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify({ tool: "github_get_workflow_run", repo: `${input.owner}/${input.repo}`, runId: input.runId }),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}
