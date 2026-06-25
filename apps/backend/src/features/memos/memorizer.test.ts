import { describe, expect, it } from "bun:test"
import { getMemorizerSystemPrompt, memoSetSchema, MEMO_MAX_PER_CONVERSATION } from "./config"
import { resolveSourceMessageIds } from "./memorizer"

describe("getMemorizerSystemPrompt", () => {
  it("should inject current date in YYYY-MM-DD format for UTC", () => {
    const prompt = getMemorizerSystemPrompt("UTC")
    const today = new Date().toISOString().split("T")[0]

    expect(prompt).toContain(`today's date: ${today}`)
  })

  it("should use author timezone for date formatting", () => {
    const prompt = getMemorizerSystemPrompt("Pacific/Auckland")

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

  it("should force a canonical memo language when one is configured", () => {
    const prompt = getMemorizerSystemPrompt("UTC", "English")

    expect(prompt).toContain("WRITE EVERY MEMO IN English")
    expect(prompt).not.toContain("WRITE IN THE CONVERSATION'S LANGUAGE")
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
})

describe("resolveSourceMessageIds", () => {
  const messages = [
    { id: "msg_1", createdAt: new Date("2024-01-01T10:00:00Z") },
    { id: "msg_2", createdAt: new Date("2024-01-01T10:05:00Z") },
    { id: "msg_3", createdAt: new Date("2024-01-01T10:02:00Z") },
  ]

  it("keeps only the cited ids that were actually shown to the model", () => {
    expect(resolveSourceMessageIds(["msg_1", "msg_3"], messages)).toEqual(["msg_1", "msg_3"])
  })

  it("drops invented ids the model never saw", () => {
    expect(resolveSourceMessageIds(["msg_2", "msg_hallucinated"], messages)).toEqual(["msg_2"])
  })

  it("anchors to the single most-recent message (not the whole conversation) when nothing valid is cited", () => {
    // msg_2 is newest by createdAt even though it isn't last in array order.
    expect(resolveSourceMessageIds(["msg_nope"], messages)).toEqual(["msg_2"])
    expect(resolveSourceMessageIds([], messages)).toEqual(["msg_2"])
  })

  it("returns no anchor when there are no messages", () => {
    expect(resolveSourceMessageIds(["whatever"], [])).toEqual([])
  })
})
