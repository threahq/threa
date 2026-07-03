import { describe, expect, it, mock } from "bun:test"
import { createListFollowUpsTool } from "./list-follow-ups-tool"
import type { FollowUpSummary } from "./tool-deps"

const EXEC_OPTS = { toolCallId: "call_1" }

function parse(output: string) {
  return JSON.parse(output) as Record<string, unknown>
}

describe("list_follow_ups tool", () => {
  it("returns the stream's pending follow-ups with ids, notes, and local times", async () => {
    const rows: FollowUpSummary[] = [
      { followUpId: "agfu_01", note: "check the deploy", scheduledFor: new Date("2026-07-03T12:00:00.000Z") },
      { followUpId: "agfu_02", note: "revisit pricing", scheduledFor: new Date("2026-07-05T09:00:00.000Z") },
    ]
    const listFollowUps = mock(async () => rows)
    const tool = createListFollowUpsTool({ listFollowUps }, { timezone: "America/New_York" })

    const result = await tool.config.execute({}, EXEC_OPTS)

    expect(listFollowUps).toHaveBeenCalledTimes(1)
    const body = parse(result.output)
    expect(body.ok).toBe(true)
    expect(body.count).toBe(2)
    expect(body.followUps).toMatchObject([
      { followUpId: "agfu_01", note: "check the deploy" },
      { followUpId: "agfu_02", note: "revisit pricing" },
    ])
    // Local time rendered in the injected zone, not raw UTC.
    expect((body.followUps as Array<{ scheduledForLocal: string }>)[0]?.scheduledForLocal).toContain("2026")
  })

  it("reports an empty list cleanly", async () => {
    const listFollowUps = mock(async () => [])
    const tool = createListFollowUpsTool({ listFollowUps })

    const result = await tool.config.execute({}, EXEC_OPTS)

    expect(parse(result.output)).toMatchObject({ ok: true, count: 0, followUps: [] })
  })
})
