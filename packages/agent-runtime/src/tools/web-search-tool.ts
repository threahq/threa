import { z } from "zod"
import { AgentStepTypes, AgentToolNames, TOOL_CATEGORIES_BY_NAME } from "@threahq/types"
import { logger } from "../logger"
import { defineAgentTool, type AgentToolResult } from "../runtime/agent-tool"
import { composeAbortSignal } from "../research/research-support"
import { describeWebPageAge, searchWebEngines, type WebPage, type WebSearchEngine } from "./web-search-engines"

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
  note?: string
}

export interface WebSearchVerdict {
  /** None of the results are about what the query asks. */
  offTopic: boolean
  /** The results are several different things that share a name. */
  ambiguous: boolean
  /** Per page, in order: its stored text says something a current listing contradicts. */
  stale: boolean[]
}

/** Reads the results against the query. Null when no judgment was made. */
export type WebSearchJudge = (query: string, pages: WebPage[], signal?: AbortSignal) => Promise<WebSearchVerdict | null>

/** The text of a page read now, or null when it could not be read. */
export type WebPageOpener = (url: string, signal: AbortSignal) => Promise<string | null>

export interface CreateWebSearchToolParams {
  engines: WebSearchEngine[]
  maxResults?: number
  /** Invocation time from the agent context, used to ground recency-sensitive searches. */
  currentTime?: string
  timezone?: string
  judge?: WebSearchJudge
  /** Opens thin listings and stale copies. Absent, results stay as the engines returned them. */
  openPage?: WebPageOpener
}

const FETCH_TIMEOUT_MS = 30000
const OPEN_TIMEOUT_MS = 15000
// Three pages is what an answer cites from; a listing alone is a title and a line.
const THIN_OPENED = 3
// The same length as Exa's stored text, so an opened page weighs what a stored one does.
const OPENED_CHARS = 3000

const OFF_TOPIC_NOTE =
  "None of these results are about what was searched for. Do not answer from them: say the search found nothing on it, or search again with different words."
// Live, the model answered from a contradicted stored copy that carried this
// marker beside it, so the text is withheld rather than flagged.
const CONTRADICTED_AGE =
  ". A current title in these results contradicts the stored text and the page could not be opened, so the text is left out"
const AMBIGUOUS_NOTE =
  "These results are several different things that share a name. Do not pick one: name them briefly and ask which one was meant."

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
  const { engines, maxResults = 5, currentTime, timezone, judge, openPage } = params
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
- Each result's \`age\` says how current its text is. Where a listing's title and older text disagree, the title is current
- A \`note\` on the results says how to treat them; follow it`,
    inputSchema: WebSearchSchema,

    execute: async (input, { signal }): Promise<AgentToolResult> => {
      const sanitizedQuery = redactQuery(input.query)
      const found = await searchOrFailure(engines, input.query, sanitizedQuery, maxResults, signal)
      if (!Array.isArray(found)) return found
      const searchedAt = currentTime ? new Date(currentTime) : new Date()

      // Outside the search's catch: the judge returns null on its own failures,
      // and what it throws (a spend denial) has to stop the turn.
      const verdict = judge && found.length > 0 ? await judge(sanitizedQuery, found, signal) : null
      if (verdict) {
        logger.debug(
          { query: input.query, offTopic: verdict.offTopic, ambiguous: verdict.ambiguous, stale: verdict.stale },
          "Web search judged"
        )
      }
      const kept = verdict?.offTopic ? [] : found
      const stale = verdict?.stale ?? []
      const pages = openPage
        ? await openPages(openPage, kept, stale, signal)
        : kept.map((page, index) => ({ ...page, contradicted: stale[index] === true }))
      const note = verdict?.offTopic ? OFF_TOPIC_NOTE : verdict?.ambiguous ? AMBIGUOUS_NOTE : undefined

      const result: WebSearchResult = {
        query: sanitizedQuery,
        ...(currentTime && { searchedAt: searchedAt.toISOString(), timezone }),
        ...(note && { note }),
        results: pages.map((page) => ({
          title: page.title,
          url: page.url,
          content: page.contradicted ? "" : page.content,
          age: describeWebPageAge(page, searchedAt) + (page.contradicted ? CONTRADICTED_AGE : ""),
        })),
      }

      logger.debug({ query: input.query, resultCount: result.results.length }, "Web search completed")

      const sources = result.results.filter((r) => r.title && r.url).map((r) => ({ title: r.title, url: r.url }))
      return { output: JSON.stringify(result), sources }
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

async function searchOrFailure(
  engines: WebSearchEngine[],
  query: string,
  sanitizedQuery: string,
  maxResults: number,
  signal: AbortSignal | undefined
): Promise<WebPage[] | AgentToolResult> {
  // Compose the per-request timeout with the session Stop signal so a user
  // abort cuts the fetch immediately instead of waiting out the timeout.
  const { signal: fetchSignal, cleanup } = composeAbortSignal({
    parent: signal,
    timeoutMs: FETCH_TIMEOUT_MS,
    timeoutReason: "web search timeout",
  })
  try {
    return await searchWebEngines(engines, sanitizedQuery, { maxResults, signal: fetchSignal })
  } catch (error) {
    // A user Stop (the parent session signal) takes precedence: report the
    // cancellation, not a spurious timeout.
    if (signal?.aborted) {
      logger.info({ query }, "Web search stopped by user")
      return { output: JSON.stringify({ stopped: true, query }) }
    }
    // The composed signal's timeout arm firing aborts the fetch. Key off the
    // signal — `composeAbortSignal` aborts with a TimeoutError/reason, not an
    // AbortError-named error — with a name check as a defensive fallback.
    if (
      fetchSignal.aborted ||
      (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      logger.warn({ query }, "Web search timed out")
      return { output: JSON.stringify({ error: `Search timed out after ${FETCH_TIMEOUT_MS / 1000}s`, query }) }
    }

    logger.error({ error, query }, "Web search failed")
    return {
      output: JSON.stringify({
        error: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        query,
      }),
    }
  } finally {
    cleanup()
  }
}

type JudgedPage = WebPage & { contradicted: boolean }

/**
 * Opens, all at once, every stored copy the judge found contradicted by a
 * current listing and the top listings that are only a title and a line. A
 * page that cannot be opened keeps the text the engine gave, unless it is
 * stale: that one is marked contradicted.
 */
async function openPages(
  openPage: WebPageOpener,
  pages: WebPage[],
  stale: boolean[],
  signal: AbortSignal | undefined
): Promise<JudgedPage[]> {
  const thin = new Set(
    pages
      .filter((page) => page.seen === "listed")
      .slice(0, THIN_OPENED)
      .map((page) => page.url)
  )
  const opening = pages.filter((page, index) => stale[index] === true || thin.has(page.url))
  if (opening.length === 0) return pages.map((page, index) => ({ ...page, contradicted: stale[index] === true }))

  const { signal: openSignal, cleanup } = composeAbortSignal({
    parent: signal,
    timeoutMs: OPEN_TIMEOUT_MS,
    timeoutReason: "web search page open timeout",
  })
  try {
    const opened = new Map<string, string>()
    await Promise.all(
      opening.map(async (page) => {
        try {
          const text = await openPage(page.url, openSignal)
          if (text) opened.set(page.url, text.slice(0, OPENED_CHARS))
        } catch (error) {
          logger.debug({ url: page.url, error }, "Web search result could not be opened, keeping the engine's text")
        }
      })
    )
    return pages.map((page, index) => {
      const text = opened.get(page.url)
      // The listing's title and date stay. The text under them is the page itself now.
      return text
        ? { ...page, content: text, seen: "fetched" as const, contradicted: false }
        : { ...page, contradicted: stale[index] === true }
    })
  } finally {
    cleanup()
  }
}
