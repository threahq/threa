import { describe, expect, it, mock, spyOn } from "bun:test"
import { SearchQueryExpander } from "./query-expansion"
import { StubQueryExpander } from "./query-expansion.stub"
import { logger } from "../../lib/logger"

describe("SearchQueryExpander", () => {
  it("returns cleaned variants: trimmed, deduped, original query dropped", async () => {
    const generateObject = mock(async () => ({
      value: {
        variants: ["  Deploy pipeline broke  ", "deploy pipeline broke", "railway build failed", "query text", ""],
      },
    }))
    const expander = new SearchQueryExpander({ ai: { generateObject } as never })

    const variants = await expander.expand("query text", { workspaceId: "ws_1" })

    expect(variants).toEqual(["Deploy pipeline broke", "railway build failed"])
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openrouter:openai/gpt-5.6-luna",
        telemetry: expect.objectContaining({ functionId: "search-expand" }),
      })
    )
  })

  it("returns [] and logs a warning when the model call throws", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger)
    try {
      const expander = new SearchQueryExpander({
        ai: {
          generateObject: async () => {
            throw new Error("boom")
          },
        } as never,
      })

      const variants = await expander.expand("some query", { workspaceId: "ws_1" })

      expect(variants).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("StubQueryExpander", () => {
  it("returns no variants (production fail-open behaviour)", async () => {
    const expander = new StubQueryExpander()
    expect(await expander.expand("q", { workspaceId: "ws_1" })).toEqual([])
  })
})
