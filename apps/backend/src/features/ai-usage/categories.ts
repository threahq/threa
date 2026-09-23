import type { AISpendStage, AIUsageByDay, AIUsageCategory } from "@threahq/types"
import type { DayFunctionBreakdown } from "./usage-repository"

/**
 * The order AI work stops in as a workspace approaches its limit: agents first,
 * embeddings last, so search and memory keep working longest.
 */

interface AIFunction {
  category: AIUsageCategory
  stage: AISpendStage
}

/** Every `telemetry.functionId` a production AI call can carry. */
export const AI_FUNCTIONS: Record<string, AIFunction> = {
  "agent-loop": { category: "agents", stage: "agents" },
  "companion-response": { category: "agents", stage: "agents" },
  "general-research-loop": { category: "agents", stage: "agents" },
  "enclave-agent-loop": { category: "agents", stage: "agents" },
  "tool-guardian": { category: "agents", stage: "agents" },
  "tool-guardian-decisions": { category: "agents", stage: "agents" },
  "turn-digest": { category: "agents", stage: "agents" },
  "summary-update": { category: "agents", stage: "agents" },
  "agent.episode-summary": { category: "agents", stage: "agents" },
  "agent-rerun-response-validation": { category: "agents", stage: "agents" },
  "context-bag.summarize": { category: "agents", stage: "agents" },
  "ws-plan": { category: "agents", stage: "agents" },
  "ws-eval": { category: "agents", stage: "agents" },
  "ws-memo-embed": { category: "agents", stage: "agents" },
  "ws-msg-embed": { category: "agents", stage: "agents" },

  "image-caption": { category: "attachments", stage: "enrichment" },
  "word-image-caption": { category: "attachments", stage: "enrichment" },
  "pdf-summary": { category: "attachments", stage: "enrichment" },
  "pdf-layout-extraction": { category: "attachments", stage: "enrichment" },
  "word-summary": { category: "attachments", stage: "enrichment" },
  "excel-summary": { category: "attachments", stage: "enrichment" },
  "text-summary": { category: "attachments", stage: "enrichment" },
  "search-expand": { category: "other", stage: "enrichment" },
  "search-refine": { category: "other", stage: "enrichment" },
  "search-rerank": { category: "other", stage: "enrichment" },
  "search-score": { category: "other", stage: "enrichment" },
  "memo-rerank": { category: "memory", stage: "enrichment" },
  "dynamic-naming-evaluate": { category: "other", stage: "enrichment" },
  "stream-naming": { category: "other", stage: "enrichment" },
  "suggestion-extract": { category: "other", stage: "enrichment" },

  "boundary-extraction": { category: "conversation", stage: "core" },
  "boundary-naming": { category: "conversation", stage: "core" },
  "conversation-split": { category: "conversation", stage: "core" },
  "memo-classify-conversation": { category: "memory", stage: "core" },
  "memorize-conversation": { category: "memory", stage: "core" },
  "revise-memo": { category: "memory", stage: "core" },
  "voice-transcript-polish": { category: "other", stage: "core" },
  "voice-transcription-realtime": { category: "other", stage: "core" },
  "voice-transcript-boundary-scope": { category: "other", stage: "core" },

  "message-embedding": { category: "memory", stage: "embeddings" },
  "message-embedding-backfill": { category: "memory", stage: "embeddings" },
  "memo-embedding": { category: "memory", stage: "embeddings" },
  "memo-edit-embedding": { category: "memory", stage: "embeddings" },
  "conversation-embedding": { category: "conversation", stage: "embeddings" },
  "conversation-embedding-backfill": { category: "conversation", stage: "embeddings" },
  "attachment-summary-embedding": { category: "attachments", stage: "embeddings" },
  "search-query": { category: "other", stage: "embeddings" },
  "memo-explorer-query": { category: "memory", stage: "embeddings" },
  "embedding-single": { category: "memory", stage: "embeddings" },
  "embedding-batch": { category: "memory", stage: "embeddings" },
}

export function categorizeFunction(functionId: string): AIUsageCategory {
  return AI_FUNCTIONS[functionId]?.category ?? "other"
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
