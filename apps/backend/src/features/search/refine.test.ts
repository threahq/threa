import { describe, expect, it, mock, spyOn } from "bun:test"
import { SearchRefiner, renderRefinePrompt, type SearchRefineInput } from "./refine"
import { StubSearchRefiner } from "./refine.stub"
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

const input: SearchRefineInput = {
  query: "deploy",
  refines: ["only decisions"],
  clusters: [cluster(), cluster(), cluster()],
  memos: [],
  context: { workspaceId: "ws_1", userId: "usr_1" },
}

describe("SearchRefiner", () => {
  it("should map 1-based row numbers to cluster indexes, dropping unknown and repeated ones", async () => {
    const generateObject = mock(async () => ({ value: { keep: [3, 1, 3, 0, 9], note: "  Kept the decisions. " } }))
    const refiner = new SearchRefiner({ ai: { generateObject } as never })

    const result = await refiner.refine(input)

    expect(result).toEqual({ keep: [2, 0], note: "Kept the decisions." })
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openrouter:openai/gpt-5.6-luna",
        telemetry: expect.objectContaining({ functionId: "search-refine" }),
        context: { workspaceId: "ws_1", userId: "usr_1", origin: "system" },
      })
    )
  })

  it("should give up after the timeout, log at debug, and leave the list unrefined", async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => logger)
    try {
      const refiner = new SearchRefiner({
        timeoutMs: 5,
        ai: {
          generateObject: ({ abortSignal }: { abortSignal: AbortSignal }) =>
            new Promise((_, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason))),
        } as never,
      })

      expect(await refiner.refine(input)).toBeNull()
      expect(debug).toHaveBeenCalledWith({ workspaceId: "ws_1" }, "Search refine timed out; showing the unrefined list")
    } finally {
      debug.mockRestore()
    }
  })

  it("should return null and log a warning when the model call throws", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger)
    try {
      const refiner = new SearchRefiner({
        ai: {
          generateObject: async () => {
            throw new Error("boom")
          },
        } as never,
      })

      expect(await refiner.refine(input)).toBeNull()
      expect(warn).toHaveBeenCalledWith(
        { error: expect.any(Error), workspaceId: "ws_1" },
        "Search refine failed; showing the unrefined list"
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe("renderRefinePrompt", () => {
  it("should number rows, show each row's title, first hits and memo titles, and list every instruction", () => {
    const prompt = renderRefinePrompt({
      query: "deploy",
      refines: ["only decisions", "newest first"],
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
        "[1] Conversation: Railway cutover (12 messages, latest 2026-03-01)",
        "  - 2026-03-01: We agreed to cut over Friday",
        "  memo (decision): Cutover decision",
        "[2] Message (2026-03-02)",
        "  - 2026-03-02: lone message",
      ].join("\n")
    )
  })
})

describe("StubSearchRefiner", () => {
  it("should report the refine as not applied (production fail-open behaviour)", async () => {
    expect(await new StubSearchRefiner().refine(input)).toBeNull()
  })
})
