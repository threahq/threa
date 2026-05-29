import { describe, expect, test, mock } from "bun:test"
import { AgentStepTypes } from "@threa/types"
import type { GeneralResearchResult } from "../general-researcher"
import { createGeneralResearchTool, type RunGeneralResearchOptions } from "./general-research-tool"

function buildResult(overrides: Partial<GeneralResearchResult> = {}): GeneralResearchResult {
  return {
    brief: "Synthesised, cited research brief.",
    sources: [
      { type: "web", title: "Docs", url: "https://example.com/docs", snippet: "…" },
      // Missing url — must be filtered out of the surfaced source list.
      { type: "workspace", title: "Orphan", url: "" },
    ],
    substeps: [{ text: "Searching the web…", at: "2026-05-29T00:00:00.000Z" }],
    ...overrides,
  }
}

describe("general_research tool", () => {
  test("folds the brief into systemContext and returns a compact status output", async () => {
    const runGeneralResearch = mock(async (_query: string, _opts: RunGeneralResearchOptions) => buildResult())
    const tool = createGeneralResearchTool({ runGeneralResearch })

    const result = await tool.config.execute({ query: "Is the auth PR merged?" }, { toolCallId: "tc_1" })

    expect(tool.config.trace.stepType).toBe(AgentStepTypes.RESEARCH)
    expect(result.systemContext).toBe("Synthesised, cited research brief.")
    // Only the source with both title and url survives.
    expect(result.sources).toEqual([{ type: "web", title: "Docs", url: "https://example.com/docs", snippet: "…" }])

    const output = JSON.parse(result.output)
    expect(output).toMatchObject({
      status: "ok",
      partial: false,
      briefAdded: true,
      sourceCount: 1,
    })
    expect(output.substeps[0].text).toBe("Searching the web…")
  })

  test("passes a wall-clock deadline and the abort signal through to the researcher", async () => {
    let seen: RunGeneralResearchOptions | undefined
    const runGeneralResearch = mock(async (_query: string, opts: RunGeneralResearchOptions) => {
      seen = opts
      return buildResult()
    })
    const tool = createGeneralResearchTool({ runGeneralResearch })
    const controller = new AbortController()
    const before = Date.now()

    await tool.config.execute(
      { query: "anything" },
      { toolCallId: "tc_1", signal: controller.signal, onProgress: () => {} }
    )

    expect(seen?.signal).toBe(controller.signal)
    expect(seen?.deadlineAt).toBeGreaterThan(before)
  })

  test("surfaces partial results with their reason", async () => {
    const runGeneralResearch = mock(async () => buildResult({ partial: true, partialReason: "timeout", brief: "" }))
    const tool = createGeneralResearchTool({ runGeneralResearch })

    const result = await tool.config.execute({ query: "anything" }, { toolCallId: "tc_1" })

    const output = JSON.parse(result.output)
    expect(output).toMatchObject({
      status: "partial",
      partial: true,
      partialReason: "timeout",
      briefAdded: false,
    })
    expect(result.systemContext).toBeUndefined()
  })
})
