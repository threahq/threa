import { describe, expect, it, mock } from "bun:test"
import { createUpdateFollowUpTool } from "./update-follow-up-tool"
import type { UpdateFollowUpToolResult } from "./tool-deps"

const EXEC_OPTS = { toolCallId: "call_1" }

function parse(output: string) {
  return JSON.parse(output) as Record<string, unknown>
}

function okResult(overrides: Partial<Extract<UpdateFollowUpToolResult, { ok: true }>> = {}): UpdateFollowUpToolResult {
  return {
    ok: true,
    followUpId: "agfu_01",
    note: "new note",
    scheduledFor: new Date("2026-07-10T09:00:00.000Z"),
    ...overrides,
  }
}

describe("update_follow_up tool", () => {
  it("updates note + time and echoes the new time in the user's zone", async () => {
    const updateFollowUp = mock(async () => okResult())
    const tool = createUpdateFollowUpTool({ updateFollowUp }, { timezone: "America/New_York" })

    const scheduledFor = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    const result = await tool.config.execute({ followUpId: "agfu_01", note: "new note", scheduledFor }, EXEC_OPTS)

    expect(updateFollowUp).toHaveBeenCalledTimes(1)
    const body = parse(result.output)
    expect(body).toMatchObject({ ok: true, followUpId: "agfu_01", note: "new note" })
    expect(body.scheduledForLocal).toContain("2026")
  })

  it("rejects a past scheduledFor without touching the service", async () => {
    const updateFollowUp = mock(async () => okResult())
    const tool = createUpdateFollowUpTool({ updateFollowUp })

    const scheduledFor = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const result = await tool.config.execute({ followUpId: "agfu_01", scheduledFor }, EXEC_OPTS)

    expect(updateFollowUp).not.toHaveBeenCalled()
    expect(parse(result.output).ok).toBe(false)
  })

  it("rejects a scheduledFor beyond the 30-day horizon", async () => {
    const updateFollowUp = mock(async () => okResult())
    const tool = createUpdateFollowUpTool({ updateFollowUp })

    const scheduledFor = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString()
    const result = await tool.config.execute({ followUpId: "agfu_01", scheduledFor }, EXEC_OPTS)

    expect(updateFollowUp).not.toHaveBeenCalled()
    expect(parse(result.output).ok).toBe(false)
  })

  it("surfaces not_pending distinctly so the model knows it can't edit a fired follow-up", async () => {
    const updateFollowUp = mock(async (): Promise<UpdateFollowUpToolResult> => ({ ok: false, reason: "not_pending" }))
    const tool = createUpdateFollowUpTool({ updateFollowUp })

    const result = await tool.config.execute({ followUpId: "agfu_01", note: "n" }, EXEC_OPTS)

    const body = parse(result.output)
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain("no longer pending")
  })

  it("rejects an input with neither note nor scheduledFor at the schema layer", () => {
    const parsed = createUpdateFollowUpTool({
      updateFollowUp: mock(async () => okResult()),
    }).config.inputSchema.safeParse({
      followUpId: "agfu_01",
    })
    expect(parsed.success).toBe(false)
  })
})
