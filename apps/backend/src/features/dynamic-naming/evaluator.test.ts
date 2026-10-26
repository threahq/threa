import { describe, expect, test } from "bun:test"
import { DynamicNamingDecisionSchema } from "./types"
import { DynamicNamingEvaluator, StubDynamicNamingEvaluator } from "./evaluator"

const input = {
  workspaceId: "ws_1",
  targetKind: "stream" as const,
  targetId: "stream_1",
  checkpoint: 3 as const,
  forced: true,
  messageCount: 3,
  currentTitle: "Old title",
  context: "<messages></messages>",
  existingTitles: [],
}

describe("dynamic naming evaluator", () => {
  test("schema rejects illegal action/title pairs and overlong titles", () => {
    expect(DynamicNamingDecisionSchema.safeParse({ action: "keep", title: "Unexpected" }).success).toBe(false)
    expect(DynamicNamingDecisionSchema.safeParse({ action: "rename" }).success).toBe(false)
    expect(DynamicNamingDecisionSchema.safeParse({ action: "rename", title: "x".repeat(101) }).success).toBe(false)
  })

  test("rejects defer returned at a forced checkpoint", async () => {
    const evaluator = new DynamicNamingEvaluator(
      { generateObject: async () => ({ value: { action: "defer", title: "" } }) } as never,
      { resolve: async () => ({ modelId: "test", temperature: 0 }) } as never
    )
    await expect(evaluator.decide(input, new AbortController().signal)).rejects.toThrow("forced checkpoint")
  })

  test("rejects keep when there is no title to keep", async () => {
    const evaluator = new DynamicNamingEvaluator(
      { generateObject: async () => ({ value: { action: "keep", title: "" } }) } as never,
      { resolve: async () => ({ modelId: "test", temperature: 0 }) } as never
    )
    await expect(evaluator.decide({ ...input, currentTitle: null }, new AbortController().signal)).rejects.toThrow(
      "missing title"
    )
  })

  test("passes current title and checkpoint metadata to structured generation", async () => {
    let request: Record<string, unknown> | undefined
    const evaluator = new DynamicNamingEvaluator(
      {
        generateObject: async (value: Record<string, unknown>) => {
          request = value
          return { value: { action: "rename", title: "Specific title" } }
        },
      } as never,
      { resolve: async () => ({ modelId: "test", temperature: 0.2 }) } as never
    )
    expect(await evaluator.decide(input, new AbortController().signal)).toEqual({
      action: "rename",
      title: "Specific title",
    })
    expect(request).toMatchObject({
      model: "test",
      temperature: 0.2,
      telemetry: {
        functionId: "dynamic-naming-evaluate",
        metadata: { checkpoint: 3, forced: true, hasCurrentTitle: true },
      },
    })
    expect(JSON.stringify(request?.messages)).toContain("Old title")
  })

  test("should tell the model the target kind when the target is a doc", async () => {
    let request: { messages: Array<{ role: string; content: string }> } | undefined
    const evaluator = new DynamicNamingEvaluator(
      {
        generateObject: async (value: typeof request) => {
          request = value
          return { value: { action: "rename", title: "Launch plan" } }
        },
      } as never,
      { resolve: async () => ({ modelId: "test", temperature: 0 }) } as never
    )
    await evaluator.decide({ ...input, targetKind: "doc", context: "# Launch plan" }, new AbortController().signal)
    const user = request?.messages.find((message) => message.role === "user")?.content ?? ""
    expect(JSON.parse(user.split("\n\n")[0]!)).toMatchObject({ targetKind: "doc", checkpoint: 3 })
  })

  test("stub decisions are deterministic and obey forced checkpoints", async () => {
    const evaluator = new StubDynamicNamingEvaluator()
    expect(await evaluator.decide({ ...input, checkpoint: 1, forced: false, currentTitle: null })).toEqual({
      action: "defer",
    })
    expect(await evaluator.decide({ ...input, currentTitle: null })).toEqual({
      action: "rename",
      title: "Untitled conversation",
    })
    expect(await evaluator.decide(input)).toEqual({ action: "keep" })
  })

  test("should rename a doc to the stub doc title until it holds that title", async () => {
    const evaluator = new StubDynamicNamingEvaluator()
    const doc = { ...input, targetKind: "doc" as const }
    expect(await evaluator.decide({ ...doc, checkpoint: 1, forced: false, currentTitle: null })).toEqual({
      action: "rename",
      title: "Generated doc title",
    })
    expect(await evaluator.decide({ ...doc, currentTitle: "Launch plan" })).toEqual({
      action: "rename",
      title: "Generated doc title",
    })
    expect(await evaluator.decide({ ...doc, currentTitle: "Generated doc title" })).toEqual({ action: "keep" })
  })
})
