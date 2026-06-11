import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threa/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { LinearToolDeps } from "./deps"
import { isLinearToolError, toToolResult, withLinearClient } from "./client-accessor"
import { toLinearActor, truncateBytes } from "./format"
import { toTraceLinearSources } from "./trace"

const MAX_PROJECT_DESCRIPTION_BYTES = 8_000

const LIST_PROJECTS_QUERY = /* GraphQL */ `
  query ThreaLinearListProjects($first: Int!) {
    projects(first: $first) {
      nodes {
        id
        name
        url
        description
        state
        progress
        startDate
        targetDate
        updatedAt
        lead {
          id
          name
          displayName
          email
        }
        initiative {
          id
          name
        }
      }
    }
  }
`

const ListProjectsSchema = z.object({
  first: z.number().int().min(1).max(50).optional().default(20).describe("Number of Linear projects to return"),
})

export type LinearListProjectsInput = z.infer<typeof ListProjectsSchema>

export function createLinearListProjectsTool(deps: LinearToolDeps) {
  return defineAgentTool({
    name: "linear_list_projects",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.LINEAR_LIST_PROJECTS],
    description:
      "List Linear projects visible to the workspace integration. Returns names, status, progress, lead, initiative, and URLs.",
    inputSchema: ListProjectsSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withLinearClient(deps, async (client) => {
        const response = await client.request<{ projects?: { nodes?: LinearProjectNode[] } }>(LIST_PROJECTS_QUERY, {
          first: input.first,
        })
        return (response.projects?.nodes ?? []).map(toProjectSummary)
      })

      if (isLinearToolError(result)) return toToolResult(result)

      const sources: SourceItem[] = result
        .filter((project): project is typeof project & { url: string } => typeof project.url === "string")
        .slice(0, 10)
        .map((project) => ({ type: "web", title: project.name.slice(0, 200), url: project.url }))

      return { output: JSON.stringify({ count: result.length, projects: result }), sources }
    },

    trace: {
      stepType: AgentStepTypes.LINEAR_ACCESS,
      formatContent: (input) => JSON.stringify({ tool: "linear_list_projects", first: input.first }),
      extractSources: (_input, result) => toTraceLinearSources(result.sources),
    },
  })
}

const GET_PROJECT_QUERY = /* GraphQL */ `
  query ThreaLinearGetProject($id: String!) {
    project(id: $id) {
      id
      name
      url
      description
      state
      progress
      startDate
      targetDate
      updatedAt
      lead {
        id
        name
        displayName
        email
      }
      initiative {
        id
        name
      }
      issues(first: 30) {
        nodes {
          identifier
          title
          url
          state {
            name
            type
            color
          }
          assignee {
            id
            name
            displayName
            email
          }
          updatedAt
        }
      }
    }
  }
`

const GetProjectSchema = z.object({
  id: z.string().min(1).describe("Linear project UUID, slug, or trailing short ID from a Linear project URL"),
})

export type LinearGetProjectInput = z.infer<typeof GetProjectSchema>

export function createLinearGetProjectTool(deps: LinearToolDeps) {
  return defineAgentTool({
    name: "linear_get_project",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.LINEAR_GET_PROJECT],
    description:
      "Fetch a Linear project by ID/slug/short ID with description, status, progress, lead, initiative, and up to 30 linked issues.",
    inputSchema: GetProjectSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withLinearClient(deps, async (client) => fetchProject(client, input.id))
      if (isLinearToolError(result)) return toToolResult(result)
      if (!result) return toToolResult({ error: "Linear project not found", code: "LINEAR_NOT_FOUND" })

      const sources: SourceItem[] = result.url
        ? [{ type: "web", title: result.name.slice(0, 200), url: result.url }]
        : []
      return { output: JSON.stringify({ project: result }), sources }
    },

    trace: {
      stepType: AgentStepTypes.LINEAR_ACCESS,
      formatContent: (input) => JSON.stringify({ tool: "linear_get_project", id: input.id }),
      extractSources: (_input, result) => toTraceLinearSources(result.sources),
    },
  })
}

interface LinearProjectNode {
  id: string
  name: string
  url?: string | null
  description?: string | null
  state?: string | null
  progress?: number | null
  startDate?: string | null
  targetDate?: string | null
  updatedAt?: string | null
  lead?: unknown
  initiative?: { id?: string; name?: string } | null
  issues?: { nodes?: LinearProjectIssueNode[] } | null
}

interface LinearProjectIssueNode {
  identifier: string
  title: string
  url?: string | null
  state?: { name?: string; type?: string; color?: string } | null
  assignee?: unknown
  updatedAt?: string | null
}

async function fetchProject(
  client: { request<T>(query: string, variables?: Record<string, unknown>): Promise<T> },
  id: string
) {
  const candidates = projectLookupCandidates(id)
  for (const [index, candidate] of candidates.entries()) {
    try {
      const response = await client.request<{ project: LinearProjectNode | null }>(GET_PROJECT_QUERY, { id: candidate })
      if (response.project) return toProjectDetail(response.project)
    } catch (error) {
      // Some URL slug forms are rejected before returning null; try the short-id
      // fallback when available, but preserve the final error so auth/rate-limit
      // failures are not mislabeled as "not found".
      if (index === candidates.length - 1) throw error
    }
  }
  return null
}

function projectLookupCandidates(id: string): string[] {
  const candidates = [id]
  const shortId = id.split("-").at(-1)
  if (shortId && shortId !== id && /^[a-zA-Z0-9]{6,}$/.test(shortId)) candidates.push(shortId)
  return candidates
}

function toProjectSummary(project: LinearProjectNode) {
  const descriptionText = typeof project.description === "string" ? project.description : ""
  const description = truncateBytes(descriptionText, MAX_PROJECT_DESCRIPTION_BYTES)
  return {
    id: project.id,
    name: project.name,
    url: typeof project.url === "string" ? project.url : null,
    description: { text: description.text, truncated: description.truncated, totalBytes: description.totalBytes },
    status: typeof project.state === "string" ? project.state : null,
    progress: typeof project.progress === "number" ? project.progress : null,
    startDate: typeof project.startDate === "string" ? project.startDate : null,
    targetDate: typeof project.targetDate === "string" ? project.targetDate : null,
    updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : null,
    lead: toLinearActor(project.lead),
    initiative: project.initiative ? { id: project.initiative.id ?? "", name: project.initiative.name ?? "" } : null,
  }
}

function toProjectDetail(project: LinearProjectNode) {
  return {
    ...toProjectSummary(project),
    issues: (project.issues?.nodes ?? []).map((issue) => ({
      identifier: issue.identifier,
      title: issue.title,
      url: typeof issue.url === "string" ? issue.url : null,
      state: issue.state
        ? { name: issue.state.name ?? "", type: issue.state.type ?? "", color: issue.state.color ?? "" }
        : null,
      assignee: toLinearActor(issue.assignee),
      updatedAt: typeof issue.updatedAt === "string" ? issue.updatedAt : null,
    })),
  }
}
