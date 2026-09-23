import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threahq/types"
import { logger } from "../logger"
import { defineAgentTool, type AgentToolResult } from "../runtime/agent-tool"
import { composeAbortSignal } from "../research/research-support"
import { describeWebPageAge, searchWebEngines, type WebSearchEngine } from "./web-search-engines"

const WebSearchSchema = z.object({
  query: z.string().describe("The search query to find information on the web"),
})

export type WebSearchInput = z.infer<typeof WebSearchSchema>

export interface WebSearchResultItem {
  title: string
  url: string
  content: string
  age: string
}

export interface WebSearchResult {
  query: string
  searchedAt?: string
  timezone?: string
  results: WebSearchResultItem[]
  answer?: string
}

export interface CreateWebSearchToolParams {
  engines: WebSearchEngine[]
  maxResults?: number
  /** Invocation time from the agent context, used to ground recency-sensitive searches. */
  currentTime?: string
  timezone?: string
}

const FETCH_TIMEOUT_MS = 30000

// Patterns that might leak internal data in outbound search queries
const SENSITIVE_PATTERNS: RegExp[] = [
  /[A-Za-z0-9+/]{40,}={0,2}/g, // base64-like strings (40+ chars)
  /\b(sk|rk|pk|lf|wos)[-_][A-Za-z0-9_-]{10,}\b/g, // prefixed secrets
  /\b(stream|user|member|workspace|memo|attachment|session|persona)_[0-9A-HJKMNP-TV-Z]{26}\b/g, // internal ULIDs
]

function redactQuery(query: string): string {
  let redacted = query
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]")
  }
  return redacted
}

export function createWebSearchTool(params: CreateWebSearchToolParams) {
  const { engines, maxResults = 5, currentTime, timezone } = params
  // The invocation time is deliberately NOT interpolated into this string.
  // Tool definitions render ahead of the system prompt in the prompt-cache
  // prefix, so a per-request value here changes that prefix on every call and
  // drives the cache hit rate to zero for the whole toolset. The live time
  // reaches the model through the system prompt's `## Current Time` section
  // (same indirection `schedule_follow_up` uses) and rides tool output below.
  const recencyHint = currentTime
    ? ` For latest, recent, current, or news queries, take the current date/year from the "## Current Time" section, include it in your query, and judge results against that time.`
    : ""

  // The system prompt's temporal grounding section only exists when the host
  // supplied an invocation time, so the recency guidance points at it only then.
  const recencyGroundingBullet = currentTime
    ? `- For latest/recent/current/news questions, ground your search and answer against the Current Time section; do not mix stale search results or training-cutoff facts into a "recent" answer`
    : `- For latest/recent/current/news questions, ground recency in web_search tool metadata and fresh results; do not mix stale results or training-cutoff facts into a "recent" answer`

  return defineAgentTool({
    name: "web_search",
    description: `Search the web for current information. Returns relevant results with titles, URLs, and content snippets. Use this when you need up-to-date information or facts not in your training data.${recencyHint}`,
    categories: TOOL_CATEGORIES_BY_NAME[AgentToolNames.WEB_SEARCH],
    promptBlock: `## Web Search

You have a \`web_search\` tool to search the web for current information.

When using web search:
- Search when you need up-to-date information not in your training data
- Search for facts, current events, or specific details you're uncertain about
${recencyGroundingBullet}
- Cite sources in your responses using markdown links: [Title](URL)
- Use the snippets to answer accurately
- Each result's \`age\` says how current its text is. Where a listing's title and older text disagree, the title is current`,
    inputSchema: WebSearchSchema,

    execute: async (input, { signal }): Promise<AgentToolResult> => {
      // Compose the per-request timeout with the session Stop signal so a user
      // abort cuts the fetch immediately instead of waiting out the timeout.
      const { signal: fetchSignal, cleanup } = composeAbortSignal({
        parent: signal,
        timeoutMs: FETCH_TIMEOUT_MS,
        timeoutReason: "web search timeout",
      })
      const sanitizedQuery = redactQuery(input.query)

      try {
        const found = await searchWebEngines(engines, sanitizedQuery, { maxResults, signal: fetchSignal })
        const searchedAt = currentTime ? new Date(currentTime) : new Date()

        const result: WebSearchResult = {
          query: sanitizedQuery,
          ...(currentTime && { searchedAt: searchedAt.toISOString(), timezone }),
          results: found.pages.map((page) => ({
            title: page.title,
            url: page.url,
            content: page.content,
            age: describeWebPageAge(page, searchedAt),
          })),
          ...(found.answer ? { answer: found.answer } : {}),
        }

        logger.debug({ query: input.query, resultCount: result.results.length }, "Web search completed")

        const output = JSON.stringify(result)

        const sources = result.results.filter((r) => r.title && r.url).map((r) => ({ title: r.title, url: r.url }))

        return { output, sources }
      } catch (error) {
        // A user Stop (the parent session signal) takes precedence: report the
        // cancellation, not a spurious timeout.
        if (signal?.aborted) {
          logger.info({ query: input.query }, "Web search stopped by user")
          return { output: JSON.stringify({ stopped: true, query: input.query }) }
        }
        // The composed signal's timeout arm firing aborts the fetch. Key off the
        // signal — `composeAbortSignal` aborts with a TimeoutError/reason, not an
        // AbortError-named error — with a name check as a defensive fallback.
        if (
          fetchSignal.aborted ||
          (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
        ) {
          logger.warn({ query: input.query }, "Web search timed out")
          return {
            output: JSON.stringify({
              error: `Search timed out after ${FETCH_TIMEOUT_MS / 1000}s`,
              query: input.query,
            }),
          }
        }

        logger.error({ error, query: input.query }, "Web search failed")
        return {
          output: JSON.stringify({
            error: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            query: input.query,
          }),
        }
      } finally {
        cleanup()
      }
    },

    executionPhase: "early",

    trace: {
      stepType: AgentStepTypes.WEB_SEARCH,
      formatContent: (input) => input.query,
      extractSources: (_input, result) =>
        (result.sources ?? []).map((s) => ({ type: "web" as const, title: s.title, url: s.url })),
    },
  })
}
