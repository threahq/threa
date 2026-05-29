import { describe, expect, it } from "bun:test"
import { getMemorizerSystemPrompt, memoSetSchema, MEMO_MAX_PER_CONVERSATION } from "./config"

describe("getMemorizerSystemPrompt", () => {
  it("should inject current date in YYYY-MM-DD format for UTC", () => {
    const prompt = getMemorizerSystemPrompt("UTC")
    const today = new Date().toISOString().split("T")[0]

    expect(prompt).toContain(`today's date: ${today}`)
  })

  it("should use author timezone for date formatting", () => {
    // Use a timezone where the date might differ from UTC
    const prompt = getMemorizerSystemPrompt("Pacific/Auckland")

    // Should contain a valid YYYY-MM-DD date
    expect(prompt).toMatch(/today's date: \d{4}-\d{2}-\d{2}/)
  })

  it("should default to UTC when no timezone provided", () => {
    const prompt = getMemorizerSystemPrompt()
    const today = new Date().toISOString().split("T")[0]

    expect(prompt).toContain(`today's date: ${today}`)
  })

  it("should contain normalization guidance", () => {
    const prompt = getMemorizerSystemPrompt()

    expect(prompt).toContain("RESOLVE PRONOUNS")
    expect(prompt).toContain("ANCHOR DATES")
  })

  it("should steer toward terse, single-topic extraction rather than summarization", () => {
    const prompt = getMemorizerSystemPrompt()

    expect(prompt).toContain("ONE TOPIC PER MEMO")
    expect(prompt).toContain("EXTRACT, DON'T SUMMARIZE")
    expect(prompt).toContain("BE TERSE")
  })

  it("should instruct the model not to translate the conversation's language", () => {
    const prompt = getMemorizerSystemPrompt()

    expect(prompt).toContain("WRITE IN THE CONVERSATION'S LANGUAGE")
    expect(prompt).toContain("Do NOT translate")
  })
})

describe("memoSetSchema", () => {
  const validMemo = {
    title: "Use ULIDs for all entity ids",
    abstract: "The team standardized on prefixed ULIDs for every entity.",
    knowledgeType: "decision" as const,
    keyPoints: [],
    tags: ["ids"],
    sourceMessageIds: ["msg_1"],
    continuesExistingMemo: null,
  }

  it("accepts a set of single-topic memos", () => {
    const result = memoSetSchema.safeParse({ memos: [validMemo, { ...validMemo, title: "Second topic" }] })
    expect(result.success).toBe(true)
  })

  it("accepts an empty set (nothing worth remembering)", () => {
    const result = memoSetSchema.safeParse({ memos: [] })
    expect(result.success).toBe(true)
  })

  it("rejects more memos than the per-conversation cap", () => {
    const tooMany = Array.from({ length: MEMO_MAX_PER_CONVERSATION + 1 }, (_, i) => ({
      ...validMemo,
      title: `Topic ${i}`,
    }))
    const result = memoSetSchema.safeParse({ memos: tooMany })
    expect(result.success).toBe(false)
  })

  it("rejects an unknown knowledge type", () => {
    const result = memoSetSchema.safeParse({ memos: [{ ...validMemo, knowledgeType: "gossip" }] })
    expect(result.success).toBe(false)
  })

  it("accepts a 1-based link to an existing memo", () => {
    const result = memoSetSchema.safeParse({ memos: [{ ...validMemo, continuesExistingMemo: 2 }] })
    expect(result.success).toBe(true)
  })

  it("rejects a zero or negative link index", () => {
    const result = memoSetSchema.safeParse({ memos: [{ ...validMemo, continuesExistingMemo: 0 }] })
    expect(result.success).toBe(false)
  })
})
