import { describe, expect, it, mock } from "bun:test"
import { createUpdateStreamBriefTool } from "./update-stream-brief-tool"
import type { UpdateStreamBriefToolResult } from "./tool-deps"

const EXEC_OPTS = { toolCallId: "call_1" }

function parse(output: string) {
  return JSON.parse(output) as Record<string, unknown>
}

describe("update_stream_brief tool", () => {
  it("writes at the context-time version and echoes the new version", async () => {
    const updateBrief = mock(
      async (_params: {
        content: string
        reason: string
        expectedVersion: number
      }): Promise<UpdateStreamBriefToolResult> => ({
        ok: true,
        version: 4,
      })
    )
    const tool = createUpdateStreamBriefTool({ updateBrief }, { currentVersion: 3 })

    const result = await tool.config.execute(
      { content: "Goal: ship weekly", reason: "recorded the decision" },
      EXEC_OPTS
    )

    expect(updateBrief).toHaveBeenCalledTimes(1)
    expect(updateBrief.mock.calls[0]?.[0]).toMatchObject({
      content: "Goal: ship weekly",
      reason: "recorded the decision",
      expectedVersion: 3,
    })
    expect(parse(result.output)).toEqual({ ok: true, version: 4 })
  })

  it("advances its known version after a write so a second write in the same turn targets the fresh version", async () => {
    const updateBrief = mock(
      async ({ expectedVersion }: { expectedVersion: number }): Promise<UpdateStreamBriefToolResult> => ({
        ok: true,
        version: expectedVersion + 1,
      })
    )
    const tool = createUpdateStreamBriefTool({ updateBrief }, { currentVersion: 1 })

    await tool.config.execute({ content: "a", reason: "r1" }, EXEC_OPTS)
    await tool.config.execute({ content: "b", reason: "r2" }, EXEC_OPTS)

    expect(updateBrief.mock.calls[0]?.[0].expectedVersion).toBe(1)
    expect(updateBrief.mock.calls[1]?.[0].expectedVersion).toBe(2)
  })

  it("surfaces a version conflict with the current content and arms the fresh version for a retry", async () => {
    const updateBrief = mock(
      async ({ expectedVersion }: { expectedVersion: number }): Promise<UpdateStreamBriefToolResult> =>
        expectedVersion === 3
          ? { ok: false, reason: "version_conflict", currentContent: "their newer brief", currentVersion: 5 }
          : { ok: true, version: 6 }
    )
    const tool = createUpdateStreamBriefTool({ updateBrief }, { currentVersion: 3 })

    const conflict = parse((await tool.config.execute({ content: "mine", reason: "r" }, EXEC_OPTS)).output)
    expect(conflict).toMatchObject({ ok: false, currentVersion: 5, currentContent: "their newer brief" })

    // The retry writes on top of the fresh version, not the stale one it read.
    const retry = parse((await tool.config.execute({ content: "mine reconciled", reason: "r" }, EXEC_OPTS)).output)
    expect(updateBrief.mock.calls[1]?.[0].expectedVersion).toBe(5)
    expect(retry).toEqual({ ok: true, version: 6 })
  })

  it("returns a graceful error (not a throw) when the write fails unexpectedly", async () => {
    const updateBrief = mock(async (): Promise<UpdateStreamBriefToolResult> => {
      throw new Error("db down")
    })
    const tool = createUpdateStreamBriefTool({ updateBrief }, { currentVersion: 0 })

    const result = await tool.config.execute({ content: "x", reason: "r" }, EXEC_OPTS)
    expect(parse(result.output).ok).toBe(false)
  })
})

describe("update_stream_brief effects", () => {
  const INPUT = { content: "Goal: ship weekly", reason: "recorded the decision" }

  // Target-less on purpose: the write lands on the stream the trace sits in.
  it("declares the version it moved the brief from and to", async () => {
    const tool = createUpdateStreamBriefTool(
      { updateBrief: mock(async (): Promise<UpdateStreamBriefToolResult> => ({ ok: true, version: 4 })) },
      { currentVersion: 3 }
    )
    const out = await tool.config.execute(INPUT, EXEC_OPTS)

    expect(tool.config.trace.effects?.(INPUT, out)).toEqual([{ kind: "brief", before: "3", after: "4" }])
  })

  it("declares nothing on a version conflict", async () => {
    const tool = createUpdateStreamBriefTool(
      {
        updateBrief: mock(
          async (): Promise<UpdateStreamBriefToolResult> => ({
            ok: false,
            reason: "version_conflict",
            currentContent: "theirs",
            currentVersion: 5,
          })
        ),
      },
      { currentVersion: 3 }
    )
    const out = await tool.config.execute(INPUT, EXEC_OPTS)

    expect(tool.config.trace.effects?.(INPUT, out)).toEqual([])
  })

  it("declares nothing when the write threw", async () => {
    const tool = createUpdateStreamBriefTool(
      {
        updateBrief: mock(async (): Promise<UpdateStreamBriefToolResult> => {
          throw new Error("db down")
        }),
      },
      { currentVersion: 3 }
    )
    const out = await tool.config.execute(INPUT, EXEC_OPTS)

    expect(tool.config.trace.effects?.(INPUT, out)).toEqual([])
  })
})
