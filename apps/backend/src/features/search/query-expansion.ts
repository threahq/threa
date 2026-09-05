import type { AI, CostContext } from "@threa/agent-runtime"
import { isAbortError } from "@threa/agent-runtime"
import { logger } from "../../lib/logger"
import {
  SEARCH_EXPANSION_MODEL_ID,
  SEARCH_EXPANSION_SYSTEM_PROMPT,
  SEARCH_EXPANSION_TEMPERATURE,
  SEARCH_EXPANSION_TIMEOUT_MS,
  searchExpansionSchema,
} from "./config"

export interface QueryExpansionContext {
  workspaceId: string
  userId?: string
}

/**
 * Deep search's query-rewrite step. Fail-open like the reranker: any
 * failure (timeout, abort, model error, malformed output) returns `[]` so a
 * broken expander can only shrink deep mode to the original query, never
 * block search.
 */
export interface QueryExpanderLike {
  expand(query: string, context: QueryExpansionContext): Promise<string[]>
}

export interface QueryExpanderServiceConfig {
  ai: AI
  model?: string
  timeoutMs?: number
}

export class SearchQueryExpander implements QueryExpanderLike {
  private readonly ai: AI
  private readonly model: string
  private readonly timeoutMs: number

  constructor(config: QueryExpanderServiceConfig) {
    this.ai = config.ai
    this.model = config.model ?? SEARCH_EXPANSION_MODEL_ID
    this.timeoutMs = config.timeoutMs ?? SEARCH_EXPANSION_TIMEOUT_MS
  }

  async expand(query: string, context: QueryExpansionContext): Promise<string[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort(new DOMException("search expand timeout", "TimeoutError"))
      } catch {
        controller.abort(new Error("search expand timeout"))
      }
    }, this.timeoutMs)

    try {
      const costContext: CostContext = {
        workspaceId: context.workspaceId,
        userId: context.userId,
        origin: "system",
      }

      const { value } = await this.ai.generateObject({
        model: this.model,
        schema: searchExpansionSchema,
        temperature: SEARCH_EXPANSION_TEMPERATURE,
        abortSignal: controller.signal,
        telemetry: {
          functionId: "search-expand",
          metadata: { queryLength: query.length },
        },
        context: costContext,
        messages: [
          { role: "system", content: SEARCH_EXPANSION_SYSTEM_PROMPT },
          { role: "user", content: query },
        ],
      })

      return sanitizeVariants(value.variants, query)
    } catch (error) {
      if (isAbortError(error)) {
        logger.debug(
          { workspaceId: context.workspaceId },
          "Search query expansion timed out; using original query only"
        )
      } else {
        logger.warn(
          { error, workspaceId: context.workspaceId },
          "Search query expansion failed; using original query only"
        )
      }
      return []
    } finally {
      clearTimeout(timer)
    }
  }
}

function sanitizeVariants(variants: string[], originalQuery: string): string[] {
  const seen = new Set<string>([originalQuery.trim()])
  const cleaned: string[] = []

  for (const variant of variants) {
    const trimmed = variant.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    cleaned.push(trimmed)
  }

  return cleaned
}
