import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AIUsageRepository } from "../../src/features/ai-usage"
import { aiUsageId } from "../../src/lib/id"
import { createTestPool } from "../integration/setup"

const workspaceId = `ws_cachedtok_${Math.random().toString(36).slice(2)}`
const periodStart = new Date("2026-01-01T00:00:00Z")
const periodEnd = new Date("2027-01-01T00:00:00Z")

function record(overrides: {
  functionId: string
  model: string
  promptTokens: number
  cachedPromptTokens: number
  completionTokens: number
  costUsd: number
}) {
  return {
    id: aiUsageId(),
    workspaceId,
    functionId: overrides.functionId,
    model: overrides.model,
    provider: "openrouter",
    promptTokens: overrides.promptTokens,
    cachedPromptTokens: overrides.cachedPromptTokens,
    completionTokens: overrides.completionTokens,
    totalTokens: overrides.promptTokens + overrides.completionTokens,
    costUsd: overrides.costUsd,
    origin: "system" as const,
  }
}

describe("ai_usage_records.cached_prompt_tokens", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = createTestPool()
    await AIUsageRepository.insert(
      pool,
      record({
        functionId: "boundary-extraction",
        model: "openai/gpt-5.4-mini",
        promptTokens: 4000,
        cachedPromptTokens: 2816,
        completionTokens: 240,
        costUsd: 0.000713,
      })
    )
    await AIUsageRepository.insert(
      pool,
      record({
        functionId: "boundary-extraction",
        model: "openai/gpt-5.4-mini",
        promptTokens: 4000,
        cachedPromptTokens: 0,
        completionTokens: 240,
        costUsd: 0.002576,
      })
    )
    await AIUsageRepository.insert(
      pool,
      record({
        functionId: "image-caption",
        model: "google/gemini-2.5-flash",
        promptTokens: 2400,
        cachedPromptTokens: 0,
        completionTokens: 350,
        costUsd: 0.0016,
      })
    )
  })

  afterAll(async () => {
    await pool.query("DELETE FROM ai_usage_records WHERE workspace_id = $1", [workspaceId])
    await pool.end()
  })

  test("survives the insert/read round-trip through the repository", async () => {
    const inserted = await AIUsageRepository.insert(
      pool,
      record({
        functionId: "memo-classify-conversation",
        model: "openai/gpt-5.4-mini",
        promptTokens: 3000,
        cachedPromptTokens: 1024,
        completionTokens: 40,
        costUsd: 0.001,
      })
    )

    const readBack = await AIUsageRepository.findById(pool, inserted.id)

    expect(inserted.cachedPromptTokens).toBe(1024)
    expect(readBack?.cachedPromptTokens).toBe(1024)
  })

  test("sums into the workspace summary alongside prompt tokens", async () => {
    const summary = await AIUsageRepository.getWorkspaceUsage(pool, workspaceId, periodStart, periodEnd)

    expect({
      promptTokens: summary.promptTokens,
      cachedPromptTokens: summary.cachedPromptTokens,
      recordCount: summary.recordCount,
    }).toEqual({ promptTokens: 13400, cachedPromptTokens: 3840, recordCount: 4 })
  })

  test("sums per function, so a component's cache hit rate is computable", async () => {
    const byFunction = await AIUsageRepository.getUsageByFunction(pool, workspaceId, periodStart, periodEnd)
    const boundary = byFunction.find((row) => row.functionId === "boundary-extraction")

    expect({ promptTokens: boundary?.promptTokens, cachedPromptTokens: boundary?.cachedPromptTokens }).toEqual({
      promptTokens: 8000,
      cachedPromptTokens: 2816,
    })
  })

  test("sums per model, and reports zero for a model that cached nothing", async () => {
    const byModel = await AIUsageRepository.getUsageByModel(pool, workspaceId, periodStart, periodEnd)
    const gemini = byModel.find((row) => row.model === "google/gemini-2.5-flash")

    expect({ promptTokens: gemini?.promptTokens, cachedPromptTokens: gemini?.cachedPromptTokens }).toEqual({
      promptTokens: 2400,
      cachedPromptTokens: 0,
    })
  })
})
