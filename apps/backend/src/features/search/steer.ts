import type { AI, CostContext } from "@threahq/agent-runtime"
import { isAbortError } from "@threahq/agent-runtime"
import { logger } from "../../lib/logger"
import type { MemoExplorerResult } from "../memos"
import { latestAt, type SearchCluster } from "./clusters"
import {
  SEARCH_STEER_HITS_PER_ROW,
  SEARCH_STEER_MODEL_ID,
  SEARCH_STEER_SNIPPET_CHARS,
  SEARCH_STEER_SYSTEM_PROMPT,
  SEARCH_STEER_TEMPERATURE,
  SEARCH_STEER_TIMEOUT_MS,
  searchSteerSchema,
} from "./config"

export interface SearchSteerInput {
  query: string
  /** Plain-language refinements, oldest first; all of them apply. */
  steers: string[]
  clusters: SearchCluster[]
  memos: MemoExplorerResult[]
  context: { workspaceId: string; userId?: string }
}

export interface SearchSteerResult {
  /** Indexes into `clusters`, in the order to show them. */
  keep: number[]
  /** The model's one-line account of what it did; empty when it said nothing. */
  note: string
}

/**
 * The `/steer` step: one model call that turns the ranked rows plus the user's
 * instructions into a ranked subset. Fail-open like the expander: a timeout,
 * abort, model error or malformed answer returns `null`, and the caller shows
 * the unsteered list and says so.
 */
export interface SearchSteererLike {
  steer(input: SearchSteerInput): Promise<SearchSteerResult | null>
}

export interface SearchSteererConfig {
  ai: AI
  model?: string
  timeoutMs?: number
}

export class SearchSteerer implements SearchSteererLike {
  private readonly ai: AI
  private readonly model: string
  private readonly timeoutMs: number

  constructor(config: SearchSteererConfig) {
    this.ai = config.ai
    this.model = config.model ?? SEARCH_STEER_MODEL_ID
    this.timeoutMs = config.timeoutMs ?? SEARCH_STEER_TIMEOUT_MS
  }

  async steer(input: SearchSteerInput): Promise<SearchSteerResult | null> {
    const { workspaceId, userId } = input.context
    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort(new DOMException("search steer timeout", "TimeoutError"))
      } catch {
        controller.abort(new Error("search steer timeout"))
      }
    }, this.timeoutMs)

    try {
      const costContext: CostContext = { workspaceId, userId, origin: "system" }
      const { value } = await this.ai.generateObject({
        model: this.model,
        schema: searchSteerSchema,
        temperature: SEARCH_STEER_TEMPERATURE,
        abortSignal: controller.signal,
        telemetry: {
          functionId: "search-steer",
          metadata: { rows: input.clusters.length, steers: input.steers.length },
        },
        context: costContext,
        messages: [
          { role: "system", content: SEARCH_STEER_SYSTEM_PROMPT },
          { role: "user", content: renderSteerPrompt(input) },
        ],
      })

      return { keep: sanitizeKeep(value.keep, input.clusters.length), note: value.note.trim() }
    } catch (error) {
      if (isAbortError(error)) {
        logger.debug({ workspaceId }, "Search steer timed out; showing the unsteered list")
      } else {
        logger.warn({ error, workspaceId }, "Search steer failed; showing the unsteered list")
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

export function renderSteerPrompt(input: SearchSteerInput): string {
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
    for (const hit of cluster.hits.slice(0, SEARCH_STEER_HITS_PER_ROW)) {
      lines.push(`  - ${isoDay(hit.createdAt)}: ${snippet(hit.content)}`)
    }
    for (const memoId of cluster.memoIds) {
      const memo = memoById.get(memoId)
      if (memo) lines.push(`  memo (${memo.knowledgeType}): ${memo.title}`)
    }
    return lines.join("\n")
  })

  const steers = input.steers.map((steer, index) => `${index + 1}. ${steer}`)
  return [`Query: ${input.query || "(none)"}`, "", "Instructions:", ...steers, "", "Rows:", ...rows].join("\n")
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function snippet(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim()
  return collapsed.length > SEARCH_STEER_SNIPPET_CHARS
    ? `${collapsed.slice(0, SEARCH_STEER_SNIPPET_CHARS)}…`
    : collapsed
}
