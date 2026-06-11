import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threa/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { LinearToolDeps } from "./deps"
import { isLinearToolError, toToolResult, withLinearClient } from "./client-accessor"
import { toLinearActor, truncateBytes } from "./format"
import { toTraceLinearSources } from "./trace"

const MAX_ISSUE_DESCRIPTION_BYTES = 8_000
const MAX_ISSUE_COMMENTS = 20
const MAX_ISSUE_COMMENT_BYTES = 2_000

const LIST_ISSUES_QUERY = /* GraphQL */ `
  query ThreaLinearListIssues($first: Int!) {
    issues(first: $first, orderBy: updatedAt) {
      nodes {
        identifier
        title
        url
        priority
        priorityLabel
        updatedAt
        createdAt
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
        team {
          key
          name
        }
        project {
          id
          name
        }
        labels(first: 10) {
          nodes {
            name
          }
        }
      }
    }
  }
`

const ListIssuesSchema = z.object({
  first: z.number().int().min(1).max(50).optional().default(20).describe("Number of recently updated issues to return"),
})

export type LinearListIssuesInput = z.infer<typeof ListIssuesSchema>

export function createLinearListIssuesTool(deps: LinearToolDeps) {
  return defineAgentTool({
    name: "linear_list_issues",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.LINEAR_LIST_ISSUES],
    description:
      "List recently updated Linear issues visible to the workspace integration. Use this to discover issue identifiers before calling linear_get_issue.",
    inputSchema: ListIssuesSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withLinearClient(deps, async (client) => {
        const response = await client.request<{ issues?: { nodes?: LinearIssueListNode[] } }>(LIST_ISSUES_QUERY, {
          first: input.first,
        })
        const issues = response.issues?.nodes ?? []
        return issues.map(toIssueListItem)
      })

      if (isLinearToolError(result)) return toToolResult(result)

      const sources: SourceItem[] = result
        .filter((issue): issue is typeof issue & { url: string } => typeof issue.url === "string")
        .slice(0, 10)
        .map((issue) => ({ type: "web", title: `${issue.identifier}: ${issue.title}`.slice(0, 200), url: issue.url }))

      return { output: JSON.stringify({ count: result.length, issues: result }), sources }
    },

    trace: {
      stepType: AgentStepTypes.LINEAR_ACCESS,
      formatContent: (input) => JSON.stringify({ tool: "linear_list_issues", first: input.first }),
      extractSources: (_input, result) => toTraceLinearSources(result.sources),
    },
  })
}

const GET_ISSUE_QUERY = /* GraphQL */ `
  query ThreaLinearGetIssue($id: String!, $commentsFirst: Int!) {
    issue(id: $id) {
      identifier
      title
      url
      description
      priority
      priorityLabel
      estimate
      dueDate
      createdAt
      updatedAt
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
      creator {
        id
        name
        displayName
        email
      }
      team {
        key
        name
      }
      project {
        id
        name
        url
      }
      labels(first: 20) {
        nodes {
          name
          color
        }
      }
      comments(first: $commentsFirst) {
        nodes {
          id
          url
          body
          createdAt
          updatedAt
          user {
            id
            name
            displayName
            email
          }
        }
      }
    }
  }
`

const GetIssueSchema = z.object({
  id: z.string().min(1).describe("Linear issue identifier or UUID, e.g. ENG-123"),
  includeComments: z.boolean().optional().default(true).describe("Include recent comments on the issue"),
})

export type LinearGetIssueInput = z.infer<typeof GetIssueSchema>

export function createLinearGetIssueTool(deps: LinearToolDeps) {
  return defineAgentTool({
    name: "linear_get_issue",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.LINEAR_GET_ISSUE],
    description: `Fetch a Linear issue by identifier (for example ENG-123) with description, metadata, labels, project, and up to ${MAX_ISSUE_COMMENTS} recent comments.`,
    inputSchema: GetIssueSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const result = await withLinearClient(deps, async (client) => {
        const response = await client.request<{ issue: LinearIssueDetailNode | null }>(GET_ISSUE_QUERY, {
          id: input.id,
          commentsFirst: input.includeComments ? MAX_ISSUE_COMMENTS : 0,
        })
        return response.issue ? toIssueDetail(response.issue) : null
      })

      if (isLinearToolError(result)) return toToolResult(result)
      if (!result) return toToolResult({ error: "Linear issue not found", code: "LINEAR_NOT_FOUND" })

      const sources: SourceItem[] = result.url
        ? [{ type: "web", title: `${result.identifier}: ${result.title}`.slice(0, 200), url: result.url }]
        : []

      return { output: JSON.stringify({ issue: result }), sources }
    },

    trace: {
      stepType: AgentStepTypes.LINEAR_ACCESS,
      formatContent: (input) => JSON.stringify({ tool: "linear_get_issue", id: input.id }),
      extractSources: (_input, result) => toTraceLinearSources(result.sources),
    },
  })
}

interface LinearIssueListNode {
  identifier: string
  title: string
  url?: string | null
  priority?: number | null
  priorityLabel?: string | null
  createdAt: string
  updatedAt: string
  state?: { name?: string; type?: string; color?: string } | null
  assignee?: unknown
  team?: { key?: string; name?: string } | null
  project?: { id?: string; name?: string } | null
  labels?: { nodes?: Array<{ name?: string }> } | null
}

interface LinearIssueDetailNode extends LinearIssueListNode {
  description?: string | null
  estimate?: number | null
  dueDate?: string | null
  creator?: unknown
  project?: { id?: string; name?: string; url?: string | null } | null
  labels?: { nodes?: Array<{ name?: string; color?: string }> } | null
  comments?: { nodes?: LinearCommentNode[] } | null
}

interface LinearCommentNode {
  id: string
  url?: string | null
  body?: string | null
  createdAt: string
  updatedAt: string
  user?: unknown
}

function toIssueListItem(issue: LinearIssueListNode) {
  return {
    identifier: issue.identifier,
    title: issue.title,
    url: typeof issue.url === "string" ? issue.url : null,
    state: issue.state
      ? { name: issue.state.name ?? "", type: issue.state.type ?? "", color: issue.state.color ?? "" }
      : null,
    priority:
      typeof issue.priority === "number" && typeof issue.priorityLabel === "string"
        ? { value: issue.priority, label: issue.priorityLabel }
        : null,
    assignee: toLinearActor(issue.assignee),
    team: issue.team ? { key: issue.team.key ?? "", name: issue.team.name ?? "" } : null,
    project: issue.project ? { id: issue.project.id ?? "", name: issue.project.name ?? "" } : null,
    labels: issue.labels?.nodes?.flatMap((label) => (typeof label.name === "string" ? [label.name] : [])) ?? [],
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }
}

function toIssueDetail(issue: LinearIssueDetailNode) {
  const descriptionText = typeof issue.description === "string" ? issue.description : ""
  const description = truncateBytes(descriptionText, MAX_ISSUE_DESCRIPTION_BYTES)
  return {
    ...toIssueListItem(issue),
    description: { text: description.text, truncated: description.truncated, totalBytes: description.totalBytes },
    estimate: typeof issue.estimate === "number" ? issue.estimate : null,
    dueDate: typeof issue.dueDate === "string" ? issue.dueDate : null,
    creator: toLinearActor(issue.creator),
    labels:
      issue.labels?.nodes?.flatMap((label) =>
        typeof label.name === "string"
          ? [{ name: label.name, color: typeof label.color === "string" ? label.color : null }]
          : []
      ) ?? [],
    comments: (issue.comments?.nodes ?? []).map((comment) => {
      const body = truncateBytes(typeof comment.body === "string" ? comment.body : "", MAX_ISSUE_COMMENT_BYTES)
      return {
        id: comment.id,
        url: typeof comment.url === "string" ? comment.url : null,
        body: { text: body.text, truncated: body.truncated, totalBytes: body.totalBytes },
        author: toLinearActor(comment.user),
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      }
    }),
  }
}
