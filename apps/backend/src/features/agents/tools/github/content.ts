import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME, type SourceItem } from "@threahq/types"
import { defineAgentTool, type AgentToolResult } from "../../runtime"
import type { GitHubToolDeps } from "./deps"
import { withGithubClient, isGitHubToolError, toToolResult } from "./client-accessor"
import { sliceLines, truncateBytes } from "./format"
import { toTraceGithubSources } from "./trace"

const MAX_FILE_LINES_PER_CALL = 600
const MAX_FILE_BYTES_PER_CALL = 96_000
const MAX_SEARCH_RESULTS = 20
const MAX_SEARCH_FRAGMENT_BYTES = 2_000

const ContentSchema = z
  .object({
    mode: z
      .enum(["get_file", "search_code"])
      .describe(
        "get_file: fetch a text file's contents at a ref, optionally ranged by line (requires path). search_code: search code within the repo using GitHub code search (requires query)."
      ),
    owner: z.string().min(1).describe("Repository owner"),
    repo: z.string().min(1).describe("Repository name"),
    // get_file params
    path: z
      .string()
      .min(1)
      .optional()
      .describe("get_file: file path within the repo, no leading slash. Required for get_file."),
    ref: z.string().optional().describe("get_file: branch, tag, or commit SHA. Defaults to the repo's default branch"),
    fromLine: z.number().int().min(1).optional().describe("get_file: 1-indexed start line (inclusive)"),
    toLine: z.number().int().min(1).optional().describe("get_file: 1-indexed end line (inclusive)"),
    // search_code params
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        "search_code: search query. Supports GitHub code search qualifiers like language:, path:, filename:, symbol:. Required for search_code."
      ),
    perPage: z.number().int().min(1).max(50).optional().default(20).describe("search_code: results per page (max 50)"),
    page: z.number().int().min(1).optional().default(1).describe("search_code: 1-indexed page number"),
  })
  // path and query are each only meaningful for one mode, so they're optional at
  // the schema level and required for their respective mode here.
  .superRefine((value, ctx) => {
    if (value.mode === "get_file" && !value.path) {
      ctx.addIssue({ code: "custom", path: ["path"], message: "path is required when mode=get_file" })
    }
    if (value.mode === "search_code" && !value.query) {
      ctx.addIssue({ code: "custom", path: ["query"], message: "query is required when mode=search_code" })
    }
  })

export type ContentInput = z.infer<typeof ContentSchema>

async function getFileContents(deps: GitHubToolDeps, input: ContentInput): Promise<AgentToolResult> {
  const result = await withGithubClient(deps, input.owner, async (client) => {
    const response = await client.request<any>("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: input.owner,
      repo: input.repo,
      path: input.path,
      ref: input.ref,
    })

    if (Array.isArray(response) || response?.type !== "file" || typeof response.content !== "string") {
      return { error: "Path is not a file", code: "NOT_A_FILE" as const }
    }

    const decoded = Buffer.from(response.content.replace(/\n/g, ""), "base64").toString("utf8")
    if (decoded.includes("\u0000")) {
      return { error: "File appears to be binary; cannot return as text", code: "BINARY" as const }
    }

    const slice = sliceLines(decoded, {
      fromLine: input.fromLine,
      toLine: input.toLine,
      maxLines: MAX_FILE_LINES_PER_CALL,
      maxBytes: MAX_FILE_BYTES_PER_CALL,
    })

    return {
      path: response.path ?? input.path,
      sha: typeof response.sha === "string" ? response.sha : null,
      size: typeof response.size === "number" ? response.size : null,
      ref: input.ref ?? null,
      htmlUrl: typeof response.html_url === "string" ? response.html_url : null,
      content: slice.text,
      startLine: slice.startLine,
      endLine: slice.endLine,
      totalLines: slice.totalLines,
      totalBytes: slice.totalBytes,
      truncated: slice.truncated,
      truncationReason: slice.truncationReason ?? null,
      nextStartLine: slice.nextStartLine ?? null,
    }
  })

  if (isGitHubToolError(result)) return toToolResult(result)
  if ("error" in result && "code" in result) {
    return toToolResult(result)
  }

  const sources: SourceItem[] = result.htmlUrl
    ? [
        {
          type: "github",
          title: `${input.owner}/${input.repo}:${result.path}${input.ref ? `@${input.ref}` : ""}`,
          url: result.htmlUrl,
        },
      ]
    : []

  return {
    output: JSON.stringify({ owner: input.owner, repo: input.repo, file: result }),
    sources,
  }
}

async function searchCode(deps: GitHubToolDeps, input: ContentInput): Promise<AgentToolResult> {
  const scopedQuery = `${input.query} repo:${input.owner}/${input.repo}`

  const result = await withGithubClient(deps, input.owner, async (client) => {
    const response = await client.request<any>("GET /search/code", {
      q: scopedQuery,
      per_page: input.perPage,
      page: input.page,
      headers: {
        accept: "application/vnd.github.text-match+json",
      },
    })
    const items = Array.isArray(response?.items) ? response.items : []
    return {
      totalCount: response?.total_count ?? 0,
      incompleteResults: Boolean(response?.incomplete_results),
      items: items.slice(0, MAX_SEARCH_RESULTS).map((item: any) => {
        const fragments = Array.isArray(item.text_matches)
          ? item.text_matches.flatMap((m: any) =>
              typeof m.fragment === "string" ? [truncateBytes(m.fragment, MAX_SEARCH_FRAGMENT_BYTES).text] : []
            )
          : []
        return {
          path: item.path,
          name: item.name,
          sha: item.sha,
          htmlUrl: typeof item.html_url === "string" ? item.html_url : null,
          repository: item.repository?.full_name ?? `${input.owner}/${input.repo}`,
          textMatches: fragments,
        }
      }),
    }
  })

  if (isGitHubToolError(result)) return toToolResult(result)

  const sources: SourceItem[] = result.items
    .filter((item: any): item is any & { htmlUrl: string } => typeof item.htmlUrl === "string")
    .slice(0, 10)
    .map((item: any) => ({
      type: "github" as const,
      title: `${item.repository}:${item.path}`,
      url: item.htmlUrl,
    }))

  return {
    output: JSON.stringify({ owner: input.owner, repo: input.repo, query: input.query, ...result }),
    sources,
  }
}

export function createGithubContentTool(deps: GitHubToolDeps) {
  return defineAgentTool({
    name: "github_content",
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.GITHUB_CONTENT],
    description: `Read repository file contents and search code. mode=get_file fetches a text file at a ref (branch/tag/SHA) with optional fromLine/toLine ranges; output is capped at ${MAX_FILE_LINES_PER_CALL} lines / ${MAX_FILE_BYTES_PER_CALL} bytes per call, and when larger the response reports truncated=true with totalLines/totalBytes/nextStartLine to page on (binary files are not returned). mode=search_code runs GitHub code search auto-scoped to the repo (supports language:/path:/filename:/symbol: qualifiers) and returns matching files with truncated text fragments.`,
    inputSchema: ContentSchema,

    execute: async (input): Promise<AgentToolResult> => {
      if (input.mode === "search_code") return searchCode(deps, input)
      return getFileContents(deps, input)
    },

    trace: {
      stepType: AgentStepTypes.GITHUB_ACCESS,
      formatContent: (input) =>
        JSON.stringify(
          input.mode === "get_file"
            ? {
                tool: "github_content",
                mode: "get_file",
                repo: `${input.owner}/${input.repo}`,
                path: input.path,
                ref: input.ref ?? null,
                range: input.fromLine ? `${input.fromLine}-${input.toLine ?? ""}` : null,
              }
            : {
                tool: "github_content",
                mode: "search_code",
                repo: `${input.owner}/${input.repo}`,
                query: input.query,
                page: input.page,
              }
        ),
      extractSources: (_input, result) => toTraceGithubSources(result.sources),
    },
  })
}
