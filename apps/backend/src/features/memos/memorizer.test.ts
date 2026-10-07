import type { AI } from "@threahq/agent-runtime"
import { describe, expect, it, mock } from "bun:test"
import type { ConfigResolver } from "../../lib/ai/config-resolver"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import { getMemorizerSystemPrompt, memoSetSchema, MEMO_MAX_PER_CONVERSATION } from "./config"
import { Memorizer, resolveSourceMessageIds } from "./memorizer"
import type { Memo } from "./repository"

const NOW = new Date("2025-03-01T12:00:00Z")

describe("getMemorizerSystemPrompt", () => {
  it("should inject the supplied date in YYYY-MM-DD format for UTC", () => {
    const prompt = getMemorizerSystemPrompt("UTC", undefined, NOW)

    expect(prompt).toContain("\nToday: 2025-03-01")
  })

  it("should use author timezone for date formatting", () => {
    const prompt = getMemorizerSystemPrompt("Pacific/Auckland", undefined, NOW)

    expect(prompt).toMatch(/\nToday: \d{4}-\d{2}-\d{2}$/)
  })

  it("should default to UTC when no timezone provided", () => {
    const prompt = getMemorizerSystemPrompt(undefined, undefined, NOW)

    expect(prompt).toContain("\nToday: 2025-03-01")
  })

  it("keeps the date and language rule in the tail, so the block above them is a stable cache prefix", () => {
    // Two renderings that differ in both timezone and canonical language must
    // share everything up to the tail — that shared span is what the provider
    // caches, and it has to clear the 1024-token floor to cache at all.
    const sv = getMemorizerSystemPrompt("Europe/Stockholm", "Swedish", NOW)
    const en = getMemorizerSystemPrompt("America/New_York", null, NOW)

    let shared = 0
    while (shared < Math.min(sv.length, en.length) && sv[shared] === en[shared]) shared++

    // ~4.6 chars/token on this prose; 4800 chars is comfortably over the floor.
    expect(shared).toBeGreaterThan(4800)
    expect(sv.slice(0, shared)).toContain("NEVER INVERT A CONCLUSION")
    expect(sv.slice(shared)).toContain("Swedish")
    expect(sv.slice(shared)).toMatch(/Today: \d{4}-\d{2}-\d{2}$/)
  })

  it("should contain normalization guidance", () => {
    const prompt = getMemorizerSystemPrompt(undefined, undefined, NOW)

    expect(prompt).toContain("RESOLVE PRONOUNS")
    expect(prompt).toContain("ANCHOR DATES")
  })

  it("should steer toward terse, single-topic extraction rather than summarization", () => {
    const prompt = getMemorizerSystemPrompt(undefined, undefined, NOW)

    expect(prompt).toContain("ONE TOPIC PER MEMO")
    expect(prompt).toContain("EXTRACT, DON'T SUMMARIZE")
    expect(prompt).toContain("BE TERSE")
  })

  it("should instruct the model not to translate the conversation's language", () => {
    const prompt = getMemorizerSystemPrompt(undefined, undefined, NOW)

    expect(prompt).toContain("WRITE IN THE CONVERSATION'S LANGUAGE")
    expect(prompt).toContain("Do NOT translate")
  })

  it("should force a canonical memo language when one is configured", () => {
    const prompt = getMemorizerSystemPrompt("UTC", "English", NOW)

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
    supersedesMemoIds: null,
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

describe("Memorizer — supersession targets", () => {
  it("lets a new conversation retire a stream memo it was shown, and drops ids it never saw", async () => {
    const generateObject = mock(async (_params: { messages: { content: string }[] }) => ({
      value: {
        memos: [
          {
            title: "Pro costs $9 per user",
            abstract: "They cut Pro to $9 per user with 20% off annual plans.",
            knowledgeType: "decision",
            keyPoints: [],
            tags: [],
            sourceMessageIds: [],
            supersedesMemoIds: ["memo_price", "memo_invented"],
          },
        ],
      },
    }))
    const memorizer = new Memorizer(
      { generateObject } as unknown as AI,
      { resolve: async () => ({ modelId: "test:model", temperature: 0 }) } as unknown as ConfigResolver,
      new MessageFormatter()
    )
    const streamMemo = { id: "memo_price", title: "Pro costs $12", abstract: "Pro is $12 per user." } as Memo

    const [memo] = await memorizer.memorizeConversation("<message/>", {
      memoryContext: [streamMemo],
      content: [],
      workspaceId: "ws_1",
      now: NOW,
    })

    expect({
      supersedesMemoIds: memo?.supersedesMemoIds,
      shownWithId: generateObject.mock.calls[0]?.[0].messages[1]?.content.includes("[memo_price] Pro costs $12"),
    }).toEqual({ supersedesMemoIds: ["memo_price"], shownWithId: true })
  })
})
