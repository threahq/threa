import { describe, expect, it, mock } from "bun:test"
import { createCancelFollowUpTool } from "./cancel-follow-up-tool"
import type { CancelFollowUpToolResult } from "./tool-deps"

const EXEC_OPTS = { toolCallId: "call_1" }

function parse(output: string) {
  return JSON.parse(output) as Record<string, unknown>
}

describe("cancel_follow_up tool", () => {
  it("cancels a pending follow-up and reports the id", async () => {
    const cancelFollowUp = mock(async (): Promise<CancelFollowUpToolResult> => ({ ok: true, followUpId: "agfu_01" }))
    const tool = createCancelFollowUpTool({ cancelFollowUp })

    const result = await tool.config.execute({ followUpId: "agfu_01" }, EXEC_OPTS)

    expect(cancelFollowUp).toHaveBeenCalledWith({ followUpId: "agfu_01" })
    expect(parse(result.output)).toMatchObject({ ok: true, followUpId: "agfu_01", status: "cancelled" })
  })

  it("reports failure (re-list) when the id isn't a pending follow-up in this stream", async () => {
    const cancelFollowUp = mock(async (): Promise<CancelFollowUpToolResult> => ({ ok: false }))
    const tool = createCancelFollowUpTool({ cancelFollowUp })

    const result = await tool.config.execute({ followUpId: "agfu_gone" }, EXEC_OPTS)

    const body = parse(result.output)
    expect(body.ok).toBe(false)
    expect(body.followUpId).toBe("agfu_gone")
  })
})

describe("cancel_follow_up effects", () => {
  const effectsOf = async (result: CancelFollowUpToolResult) => {
    const tool = createCancelFollowUpTool({ cancelFollowUp: mock(async () => result) })
    const input = { followUpId: "agfu_01" }
    const out = await tool.config.execute(input, EXEC_OPTS)
    return tool.config.trace.effects?.(input, out)
  }

  it("declares the follow-up it cancelled", async () => {
    expect(await effectsOf({ ok: true, followUpId: "agfu_01" })).toEqual([{ kind: "follow_up", target: "agfu_01" }])
  })

  it("declares nothing when there was no pending follow-up to cancel", async () => {
    expect(await effectsOf({ ok: false })).toEqual([])
  })
})
