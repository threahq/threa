import type { AIUsageByDay, AIUsageCategory } from "@threa/types"
import type { DayFunctionBreakdown } from "./usage-repository"

export const FUNCTION_CATEGORY_MAP: Record<string, AIUsageCategory> = {
  "memorize-conversation": "memory",
  "revise-memo": "memory",
  "memo-classify-conversation": "memory",
  "memo-rerank": "memory",
  "memo-explorer-query": "memory",
  "memo-edit-embedding": "memory",
  "memo-embedding": "memory",
  "message-embedding": "memory",

  "boundary-extraction": "conversation",
  "conversation-split": "conversation",

  "agent-loop": "agents",
  "tool-guardian": "agents",
  "turn-digest": "agents",
  "agent-rerun-response-validation": "agents",
  "summary-update": "agents",
  "agent.episode-summary": "agents",
  "context-bag.summarize": "agents",
  "ws-plan": "agents",
  "ws-eval": "agents",
  "ws-memo-embed": "agents",
  "ws-msg-embed": "agents",
  "general-research-loop": "agents",
  "enclave-agent-loop": "agents",
  "langchain-model": "agents",
  "langchain-model-invoke": "agents",

  "pdf-summary": "attachments",
  "pdf-layout-extraction": "attachments",
  "excel-summary": "attachments",
  "word-summary": "attachments",
  "word-image-caption": "attachments",
  "text-summary": "attachments",
  "image-caption": "attachments",
  "attachment-summary-embedding": "attachments",

  "stream-naming": "other",
  "search-query": "other",
  "voice-transcript-polish": "other",
  "suggestion-extract": "other",
}

export function categorizeFunction(functionId: string): AIUsageCategory {
  return FUNCTION_CATEGORY_MAP[functionId] ?? "other"
}

export function aggregateUsageByDay(rows: DayFunctionBreakdown[]): AIUsageByDay[] {
  const buckets = new Map<string, AIUsageByDay>()
  for (const row of rows) {
    const category = categorizeFunction(row.functionId)
    const key = `${row.date} ${category}`
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.totalCostUsd += row.totalCostUsd
      bucket.totalTokens += row.totalTokens
      bucket.recordCount += row.recordCount
    } else {
      buckets.set(key, {
        date: row.date,
        category,
        totalCostUsd: row.totalCostUsd,
        totalTokens: row.totalTokens,
        recordCount: row.recordCount,
      })
    }
  }
  return [...buckets.values()].sort((a, b) =>
    a.date === b.date ? a.category.localeCompare(b.category) : a.date.localeCompare(b.date)
  )
}
