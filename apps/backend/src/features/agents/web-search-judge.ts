import {
  AISpendDeniedError,
  isAbortError,
  noulAnswer,
  type AI,
  type DecisionQuestion,
  type DecisionsAvailability,
  type WebPage,
  type WebSearchJudge as WebSearchJudgeFn,
  type WebSearchVerdict,
} from "@threahq/agent-runtime"
import type { AIResidencyPolicy } from "../ai-usage"
import { logger } from "../../lib/logger"
import {
  WEB_SEARCH_DISTINCT_AT,
  WEB_SEARCH_DISTINCT_QUESTION,
  WEB_SEARCH_JUDGE_MODEL_ID,
  WEB_SEARCH_JUDGE_TIMEOUT_MS,
  WEB_SEARCH_ON_TOPIC_FLOOR,
  WEB_SEARCH_ON_TOPIC_QUESTION,
  WEB_SEARCH_ON_TOPIC_SURE,
  WEB_SEARCH_STALE_AT,
  webSearchStaleQuestion,
} from "./config"

interface WebSearchJudgeContext {
  workspaceId: string
  userId?: string
  sessionId?: string
}

const KIND: Record<WebPage["seen"], string> = {
  listed: "current Google listing: the title is current, the text may be old",
  both: "current Google title over a stored copy of the page's text",
  stored: "stored copy of the page",
  fetched: "the page itself, read now",
}

/**
 * Reads web_search results against the query in one decisions call: whether
 * they are about the thing searched for, whether they are namesakes, and which
 * stored copies a current title contradicts. A workspace that pinned its AI
 * residency gets the results unjudged.
 */
export class WebSearchJudge {
  private readonly ai: AI
  private readonly residency: AIResidencyPolicy
  private readonly availability: DecisionsAvailability

  constructor(deps: { ai: AI; residency: AIResidencyPolicy; availability: DecisionsAvailability }) {
    this.ai = deps.ai
    this.residency = deps.residency
    this.availability = deps.availability
  }

  forTurn(context: WebSearchJudgeContext): WebSearchJudgeFn {
    return (query, pages, signal) => this.judge(query, pages, context, signal)
  }

  async judge(
    query: string,
    pages: WebPage[],
    context: WebSearchJudgeContext,
    signal?: AbortSignal
  ): Promise<WebSearchVerdict | null> {
    if ((await this.residency.isPinned(context.workspaceId)) || !this.availability.isAvailable) return null

    const timeout = new AbortController()
    const timer = setTimeout(
      () => timeout.abort(new DOMException("web search judge timeout", "TimeoutError")),
      WEB_SEARCH_JUDGE_TIMEOUT_MS
    )
    const abortSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal

    const questions: Record<string, DecisionQuestion> = {
      onTopic: { type: "noul", instructions: WEB_SEARCH_ON_TOPIC_QUESTION },
      distinct: { type: "noul", instructions: WEB_SEARCH_DISTINCT_QUESTION },
    }
    pages.forEach((page, index) => {
      if (page.seen === "both" || page.seen === "stored") {
        questions[staleKey(index)] = { type: "noul", instructions: webSearchStaleQuestion(index) }
      }
    })

    try {
      const result = await this.ai.generateDecisions({
        model: WEB_SEARCH_JUDGE_MODEL_ID,
        state: {
          query,
          results: pages.map((page, index) => ({
            index,
            kind: KIND[page.seen],
            title: page.title,
            url: page.url,
            ...(page.date ? { date: page.date } : {}),
            text: page.content,
          })),
        },
        questions,
        abortSignal,
        telemetry: { functionId: "web-search-judge", metadata: { resultCount: pages.length } },
        context: { ...context, origin: "user" },
      })

      const onTopic = noulAnswer(result, "onTopic")
      return {
        offTopic: onTopic < WEB_SEARCH_ON_TOPIC_FLOOR,
        ambiguous: onTopic < WEB_SEARCH_ON_TOPIC_SURE && noulAnswer(result, "distinct") >= WEB_SEARCH_DISTINCT_AT,
        stale: pages.map(
          (_, index) =>
            questions[staleKey(index)] !== undefined && noulAnswer(result, staleKey(index)) >= WEB_SEARCH_STALE_AT
        ),
      }
    } catch (error) {
      if (error instanceof AISpendDeniedError) throw error
      if (isAbortError(error)) {
        logger.debug(
          { workspaceId: context.workspaceId },
          "Web search judge timed out or was aborted; results unjudged"
        )
        return null
      }
      this.availability.recordFailure()
      logger.warn({ error, workspaceId: context.workspaceId }, "Web search judge failed; results unjudged")
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

function staleKey(index: number): string {
  return `stale${index}`
}
