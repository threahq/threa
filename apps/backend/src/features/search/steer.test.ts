import { describe, expect, it, mock, spyOn } from "bun:test"
import { SearchSteerer, renderSteerPrompt, type SearchSteerInput } from "./steer"
import { StubSearchSteerer } from "./steer.stub"
import { logger } from "../../lib/logger"
import type { SearchCluster } from "./clusters"

function cluster(overrides: Partial<SearchCluster> = {}): SearchCluster {
  return {
    conversation: null,
    streamId: "stream_1",
    matchedVia: ["message"],
    hits: [],
    memoIds: [],
    score: 1,
    ...overrides,
  }
}

const input: SearchSteerInput = {
  query: "deploy",
  steers: ["only decisions"],
  clusters: [cluster(), cluster(), cluster()],
  memos: [],
  context: { workspaceId: "ws_1", userId: "usr_1" },
}

describe("SearchSteerer", () => {
  it("should map 1-based row numbers to cluster indexes, dropping unknown and repeated ones", async () => {
    const generateObject = mock(async () => ({ value: { keep: [3, 1, 3, 0, 9], note: "  Kept the decisions. " } }))
    const steerer = new SearchSteerer({ ai: { generateObject } as never })

    const result = await steerer.steer(input)

    expect(result).toEqual({ keep: [2, 0], note: "Kept the decisions." })
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openrouter:openai/gpt-5.6-luna",
        telemetry: expect.objectContaining({ functionId: "search-steer" }),
        context: { workspaceId: "ws_1", userId: "usr_1", origin: "system" },
      })
    )
  })

  it("should return null and log a warning when the model call throws", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger)
    try {
      const steerer = new SearchSteerer({
        ai: {
          generateObject: async () => {
            throw new Error("boom")
          },
        } as never,
      })

      expect(await steerer.steer(input)).toBeNull()
      expect(warn).toHaveBeenCalledWith(
        { error: expect.any(Error), workspaceId: "ws_1" },
        "Search steer failed; showing the unsteered list"
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe("renderSteerPrompt", () => {
  it("should number rows, show each row's title, first hits and memo titles, and list every instruction", () => {
    const prompt = renderSteerPrompt({
      query: "deploy",
      steers: ["only decisions", "newest first"],
      clusters: [
        cluster({
          conversation: { id: "conv_1", topicSummary: "Railway cutover", summary: null, messageCount: 12 } as never,
          hits: [{ content: "We   agreed to\ncut over Friday", createdAt: new Date("2026-03-01T10:00:00Z") } as never],
          memoIds: ["memo_1", "memo_missing"],
        }),
        cluster({ hits: [{ content: "lone message", createdAt: new Date("2026-03-02T10:00:00Z") } as never] }),
      ],
      memos: [{ memo: { id: "memo_1", title: "Cutover decision", knowledgeType: "decision" } } as never],
      context: { workspaceId: "ws_1" },
    })

    expect(prompt).toBe(
      [
        "Query: deploy",
        "",
        "Instructions:",
        "1. only decisions",
        "2. newest first",
        "",
        "Rows:",
        "[1] Conversation: Railway cutover (12 messages)",
        "  - 2026-03-01: We agreed to cut over Friday",
        "  memo (decision): Cutover decision",
        "[2] Message",
        "  - 2026-03-02: lone message",
      ].join("\n")
    )
  })
})

describe("StubSearchSteerer", () => {
  it("should report the steer as not applied (production fail-open behaviour)", async () => {
    expect(await new StubSearchSteerer().steer(input)).toBeNull()
  })
})
