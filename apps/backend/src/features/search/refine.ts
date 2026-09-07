import type { AI, CostContext } from "@threahq/agent-runtime"
import { isAbortError } from "@threahq/agent-runtime"
import type { SearchRefinement } from "@threahq/types"
import { logger } from "../../lib/logger"
import type { MemoExplorerResult } from "../memos"
import { latestAt, type SearchCluster } from "./clusters"
import {
  SEARCH_REFINE_HITS_PER_ROW,
  SEARCH_REFINE_MODEL_ID,
  SEARCH_REFINE_SNIPPET_CHARS,
  SEARCH_REFINE_SYSTEM_PROMPT,
  SEARCH_REFINE_TEMPERATURE,
  SEARCH_REFINE_TIMEOUT_MS,
  searchRefineSchema,
} from "./config"

export interface SearchRefineInput {
  query: string
  /** Refinements, oldest first; all of them apply. */
  refines: SearchRefinement[]
  clusters: SearchCluster[]
  memos: MemoExplorerResult[]
  context: { workspaceId: string; userId?: string }
}

export interface SearchRefineResult {
  /** Indexes into `clusters`, in the order to show them. */
  keep: number[]
  /** The model's one-line account of what it did; empty when it said nothing. */
  note: string
}

/**
 * The refine step: one model call that turns the ranked rows plus the user's
 * instructions into a ranked subset. Fail-open like the expander: a timeout,
 * abort, model error or malformed answer returns `null`, and the caller shows
 * the unrefined list and says so.
 */
export interface SearchRefinerLike {
  refine(input: SearchRefineInput): Promise<SearchRefineResult | null>
}

export interface SearchRefinerConfig {
  ai: AI
  model?: string
  timeoutMs?: number
}

export class SearchRefiner implements SearchRefinerLike {
  private readonly ai: AI
  private readonly model: string
  private readonly timeoutMs: number

  constructor(config: SearchRefinerConfig) {
    this.ai = config.ai
    this.model = config.model ?? SEARCH_REFINE_MODEL_ID
    this.timeoutMs = config.timeoutMs ?? SEARCH_REFINE_TIMEOUT_MS
  }

  async refine(input: SearchRefineInput): Promise<SearchRefineResult | null> {
    const { workspaceId, userId } = input.context
    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort(new DOMException("search refine timeout", "TimeoutError"))
      } catch {
        controller.abort(new Error("search refine timeout"))
      }
    }, this.timeoutMs)

    try {
      const costContext: CostContext = { workspaceId, userId, origin: "system" }
      const { value } = await this.ai.generateObject({
        model: this.model,
        schema: searchRefineSchema,
        temperature: SEARCH_REFINE_TEMPERATURE,
        abortSignal: controller.signal,
        telemetry: {
          functionId: "search-refine",
          metadata: { rows: input.clusters.length, refines: input.refines.length },
        },
        context: costContext,
        messages: [
          { role: "system", content: SEARCH_REFINE_SYSTEM_PROMPT },
          { role: "user", content: renderRefinePrompt(input) },
        ],
      })

      return { keep: sanitizeKeep(value.keep, input.clusters.length), note: value.note.trim() }
    } catch (error) {
      if (isAbortError(error)) {
        logger.debug({ workspaceId }, "Search refine timed out; showing the unrefined list")
      } else {
        logger.warn({ error, workspaceId }, "Search refine failed; showing the unrefined list")
      }
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Rows are 1-based in the prompt; the answer comes back the same way. Unknown and repeated numbers are dropped. */
function sanitizeKeep(keep: number[], rowCount: number): number[] {
  const seen = new Set<number>()
  const indexes: number[] = []
  for (const row of keep) {
    const index = row - 1
    if (index < 0 || index >= rowCount || seen.has(index)) continue
    seen.add(index)
    indexes.push(index)
  }
  return indexes
}

export function renderRefinePrompt(input: SearchRefineInput): string {
  const memoById = new Map(input.memos.map((result) => [result.memo.id, result.memo]))
  const rows = input.clusters.map((cluster, index) => {
    const lines: string[] = []
    const { conversation } = cluster
    const latest = latestAt(cluster)
    const latestDay = latest > 0 ? isoDay(new Date(latest)) : null
    if (conversation) {
      const title = conversation.topicSummary ?? conversation.summary ?? "(untitled)"
      const facts = [`${conversation.messageCount} messages`, ...(latestDay ? [`latest ${latestDay}`] : [])]
      lines.push(`[${index + 1}] Conversation: ${title} (${facts.join(", ")})`)
    } else {
      lines.push(`[${index + 1}] Message${latestDay ? ` (${latestDay})` : ""}`)
    }
    for (const hit of cluster.hits.slice(0, SEARCH_REFINE_HITS_PER_ROW)) {
      lines.push(`  - ${isoDay(hit.createdAt)}: ${snippet(hit.content)}`)
    }
    for (const memoId of cluster.memoIds) {
      const memo = memoById.get(memoId)
      if (memo) lines.push(`  memo (${memo.knowledgeType}): ${memo.title}`)
    }
    return lines.join("\n")
  })

  const rowByConversationId = new Map<string, number>()
  input.clusters.forEach((cluster, index) => {
    if (cluster.conversation) rowByConversationId.set(cluster.conversation.id, index + 1)
  })
  const refines = input.refines.map((refine, index) => `${index + 1}. ${renderRefinement(refine, rowByConversationId)}`)
  return [`Query: ${input.query || "(none)"}`, "", "Instructions:", ...refines, "", "Rows:", ...rows].join("\n")
}

/** A row that left the list still reaches the model as its conversation id, never dropped (INV-11). */
function renderRefinement(refine: SearchRefinement, rowByConversationId: Map<string, number>): string {
  if (typeof refine === "string") return refine
  const action = refine.kind === "more" ? "More like" : "Drop"
  const row = rowByConversationId.get(refine.conversationId)
  return row ? `${action} row [${row}]` : `${action} conversation ${refine.conversationId} (not in the list)`
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function snippet(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim()
  return collapsed.length > SEARCH_REFINE_SNIPPET_CHARS
    ? `${collapsed.slice(0, SEARCH_REFINE_SNIPPET_CHARS)}…`
    : collapsed
}
