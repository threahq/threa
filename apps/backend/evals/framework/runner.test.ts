import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import type { AI } from "@threahq/agent-runtime"
import { createUsageTrackingAI } from "./runner"
import { createSpendGuard, createUsageAccumulator } from "./types"

const creditRejection = new APICallError({
  message: "Insufficient credits",
  url: "https://openrouter.ai/api/v1/embeddings",
  requestBodyValues: {},
  statusCode: 402,
})

const context = { workspaceId: "ws_eval" }

function fakeAI(overrides: Record<string, unknown>): AI {
  return overrides as unknown as AI
}

describe("createUsageTrackingAI", () => {
  test("counts embedding spend toward usage and the budget", async () => {
    const usage = createUsageAccumulator()
    const spend = createSpendGuard(0.75)
    const ai = createUsageTrackingAI(
      fakeAI({
        embed: async () => ({ value: [0], usage: { promptTokens: 8, cost: 0.25 } }),
        embedMany: async () => ({ value: [[0]], usage: { promptTokens: 20, cost: 0.5 } }),
      }),
      usage,
      { rejections: 0 },
      spend
    )

    await ai.embed({ model: "openrouter:openai/text-embedding-3-small", value: "a", context })
    await ai.embedMany({ model: "openrouter:openai/text-embedding-3-small", values: ["a", "b"], context })

    expect({ total: usage.getTotal(), aborted: spend.signal.aborted }).toEqual({
      total: { inputTokens: 28, outputTokens: 0, reasoningTokens: 0, totalCost: 0.75 },
      aborted: true,
    })
  })

  test("refuses calls once the run has stopped", async () => {
    let calls = 0
    const spend = createSpendGuard()
    const ai = createUsageTrackingAI(
      fakeAI({
        embed: async () => {
          calls++
          return { value: [0], usage: { promptTokens: 1, cost: 0 } }
        },
      }),
      createUsageAccumulator(),
      undefined,
      spend
    )

    spend.stop(new Error("stopped"))

    await expect(ai.embed({ model: "openrouter:openai/text-embedding-3-small", value: "a", context })).rejects.toThrow(
      "stopped"
    )
    expect(calls).toBe(0)
  })

  test("a credit rejection stops the run", async () => {
    const credit = { rejections: 0 }
    const spend = createSpendGuard()
    const ai = createUsageTrackingAI(
      fakeAI({
        embed: async () => {
          throw creditRejection
        },
      }),
      createUsageAccumulator(),
      credit,
      spend
    )

    await expect(ai.embed({ model: "openrouter:openai/text-embedding-3-small", value: "a", context })).rejects.toBe(
      creditRejection
    )

    expect({ rejections: credit.rejections, reason: (spend.signal.reason as Error).message }).toEqual({
      rejections: 1,
      reason: "OpenRouter rejected a call for insufficient credit: run stopped",
    })
  })
})
