import { describe, test, expect } from "bun:test"
import { memoRepair } from "./repair"

describe("memoRepair", () => {
  test("maps classification field to isKnowledgeWorthy", async () => {
    const input = '{"classification": "not_knowledge_worthy", "reasoning": "test"}'
    const result = await memoRepair({ text: input })
    const parsed = JSON.parse(result)
    expect(parsed.isKnowledgeWorthy).toBe(false)
    expect(parsed.reasoning).toBe("test")
  })

  test("adds defaults for isGem=false", async () => {
    const input = '{"isGem": false, "reasoning": "social chatter"}'
    const result = await memoRepair({ text: input })
    const parsed = JSON.parse(result)
    expect(parsed.isGem).toBe(false)
    expect(parsed.knowledgeType).toBe(null)
    expect(parsed.confidence).toBe(0.5)
  })

  test("adds defaults for isKnowledgeWorthy=false", async () => {
    const input = '{"isKnowledgeWorthy": false, "reasoning": "banter"}'
    const result = await memoRepair({ text: input })
    const parsed = JSON.parse(result)
    expect(parsed.isKnowledgeWorthy).toBe(false)
    expect(parsed.shouldReviseExisting).toBe(false)
    expect(parsed.revisionReason).toBe(null)
    expect(parsed.knowledgeType).toBe(null)
  })

  test("preserves existing confidence value", async () => {
    const input = '{"isGem": true, "confidence": 0.95}'
    const result = await memoRepair({ text: input })
    const parsed = JSON.parse(result)
    expect(parsed.confidence).toBe(0.95)
  })

  test("maps isKnowledgeWorthPreserving to isKnowledgeWorthy", async () => {
    const input = '{"isKnowledgeWorthPreserving": false, "reasoning": "informal chat", "confidence": 0.5}'
    const result = await memoRepair({ text: input })
    const parsed = JSON.parse(result)
    expect(parsed.isKnowledgeWorthy).toBe(false)
    expect(parsed.isKnowledgeWorthPreserving).toBeUndefined()
    expect(parsed.shouldReviseExisting).toBe(false)
    expect(parsed.revisionReason).toBe(null)
    expect(parsed.knowledgeType).toBe(null)
  })

  test("normalizes knowledgeType to lowercase", async () => {
    const input = '{"isGem": true, "knowledgeType": "Decision", "confidence": 0.5}'
    const result = await memoRepair({ text: input })
    const parsed = JSON.parse(result)
    expect(parsed.knowledgeType).toBe("decision")
  })

  test("normalizes standing to lowercase", async () => {
    const input = '{"title": "x", "standing": "Proposed"}'
    const result = await memoRepair({ text: input })
    const parsed = JSON.parse(result)
    expect(parsed.standing).toBe("proposed")
  })
})
