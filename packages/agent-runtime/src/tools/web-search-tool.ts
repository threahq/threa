import { z } from "zod"
import { AgentStepTypes } from "@threa/types"
import { logger } from "../logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"

const WebSearchSchema = z.object({
  query: z.string().describe("The search query to find information on the web"),
})

export type WebSearchInput = z.infer<typeof WebSearchSchema>

export interface WebSearchResultItem {
  title: string
  url: string
  content: string
  score: number
}

export interface WebSearchResult {
  query: string
  searchedAt?: string
  timezone?: string
  results: WebSearchResultItem[]
  answer?: string
}

interface TavilySearchResponse {
  query: string
  answer?: string
  results: Array<{
    title: string
    url: string
    content: string
    score: number
  }>
  response_time: number
}

export interface CreateWebSearchToolParams {
  tavilyApiKey: string
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
  const { tavilyApiKey, maxResults = 5, currentTime, timezone } = params
  const recencyHint = currentTime
    ? ` Current invocation time is ${currentTime}${timezone ? ` (${timezone})` : ""}; for latest, recent, current, or news queries, include the current date/year in your query and judge results against that invocation time.`
    : ""

  return defineAgentTool({
    name: "web_search",
    description: `Search the web for current information. Returns relevant results with titles, URLs, and content snippets. Use this when you need up-to-date information or facts not in your training data.${recencyHint}`,
    inputSchema: WebSearchSchema,

    execute: async (input): Promise<AgentToolResult> => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      const sanitizedQuery = redactQuery(input.query)

      try {
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tavilyApiKey}`,
          },
          body: JSON.stringify({
            query: sanitizedQuery,
            max_results: maxResults,
            include_answer: true,
            search_depth: "basic",
          }),
        })

        if (!response.ok) {
          const errorText = await response.text()
          logger.error({ status: response.status, error: errorText }, "Tavily API error")
          const output = JSON.stringify({ error: `Search failed: ${response.status}`, query: input.query })
          return { output }
        }

        const data = (await response.json()) as TavilySearchResponse

        const result: WebSearchResult = {
          query: data.query,
          ...(currentTime && {
            searchedAt: new Date(currentTime).toISOString(),
            timezone,
          }),
          results: data.results.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
            score: r.score,
          })),
          answer: data.answer,
        }

        logger.debug({ query: input.query, resultCount: result.results.length }, "Web search completed")

        const output = JSON.stringify(result)

        // Extract sources from results
        const sources = result.results.filter((r) => r.title && r.url).map((r) => ({ title: r.title, url: r.url }))

        return { output, sources }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
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
        clearTimeout(timeout)
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
