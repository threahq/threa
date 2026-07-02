import { describe, expect, it, mock } from "bun:test"
import { createScheduleFollowUpTool } from "./schedule-follow-up-tool"
import type { ScheduleFollowUpToolResult } from "./tool-deps"

const EXEC_OPTS = { toolCallId: "call_1" }

function parse(output: string) {
  return JSON.parse(output) as Record<string, unknown>
}

function okResult(): ScheduleFollowUpToolResult {
  return {
    ok: true,
    followUpId: "agfu_01",
    scheduledFor: new Date("2026-07-03T12:00:00.000Z"),
    pendingCount: 1,
    limit: 10,
  }
}

describe("schedule_follow_up tool", () => {
  it("schedules a future follow-up and reports id, count, and limit", async () => {
    const scheduleFollowUp = mock(async () => okResult())
    const tool = createScheduleFollowUpTool({ scheduleFollowUp })

    const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const result = await tool.config.execute({ note: "check the deploy", scheduledFor }, EXEC_OPTS)

    expect(scheduleFollowUp).toHaveBeenCalledTimes(1)
    const body = parse(result.output)
    expect(body).toMatchObject({ ok: true, followUpId: "agfu_01", pendingCount: 1, limit: 10 })
  })

  it("rejects a past date without touching the service", async () => {
    const scheduleFollowUp = mock(async () => okResult())
    const tool = createScheduleFollowUpTool({ scheduleFollowUp })

    const scheduledFor = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const result = await tool.config.execute({ note: "n", scheduledFor }, EXEC_OPTS)

    expect(scheduleFollowUp).not.toHaveBeenCalled()
    expect(parse(result.output).ok).toBe(false)
  })

  it("rejects a date beyond the 30-day horizon", async () => {
    const scheduleFollowUp = mock(async () => okResult())
    const tool = createScheduleFollowUpTool({ scheduleFollowUp })

    const scheduledFor = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString()
    const result = await tool.config.execute({ note: "n", scheduledFor }, EXEC_OPTS)

    expect(scheduleFollowUp).not.toHaveBeenCalled()
    expect(parse(result.output).ok).toBe(false)
  })

  it("echoes the scheduled time in the user's timezone, not raw UTC", async () => {
    const scheduleFollowUp = mock(async () => okResult()) // scheduledFor = 2026-07-03T12:00:00Z
    const tool = createScheduleFollowUpTool({ scheduleFollowUp }, { timezone: "America/New_York" })

    const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const result = await tool.config.execute({ note: "n", scheduledFor }, EXEC_OPTS)

    const body = parse(result.output)
    // 12:00 UTC in July is 8:00 AM EDT — the model must be handed the local render.
    expect(body.scheduledForLocal).toContain("8:00")
    expect(body.scheduledForLocal).not.toBe("2026-07-03T12:00:00.000Z")
  })

  it("validates future/horizon against the injected currentTime, not wall-clock", async () => {
    const scheduleFollowUp = mock(async () => okResult())
    // Inject a "now" in 2027 so a 2026 target is in the past for the tool even
    // though it is still in the future for the real wall clock.
    const tool = createScheduleFollowUpTool({ scheduleFollowUp }, { currentTime: "2027-01-01T00:00:00.000Z" })

    const result = await tool.config.execute({ note: "n", scheduledFor: "2026-07-03T12:00:00.000Z" }, EXEC_OPTS)

    expect(scheduleFollowUp).not.toHaveBeenCalled()
    expect(parse(result.output).ok).toBe(false)
  })

  it("rejects an unparseable timestamp", async () => {
    const scheduleFollowUp = mock(async () => okResult())
    const tool = createScheduleFollowUpTool({ scheduleFollowUp })

    const result = await tool.config.execute({ note: "n", scheduledFor: "not-a-date" }, EXEC_OPTS)

    expect(scheduleFollowUp).not.toHaveBeenCalled()
    expect(parse(result.output).ok).toBe(false)
  })

  it("surfaces the cap-reached signal with the current count and limit", async () => {
    const scheduleFollowUp = mock(
      async (): Promise<ScheduleFollowUpToolResult> => ({
        ok: false,
        reason: "cap_reached",
        pendingCount: 10,
        limit: 10,
      })
    )
    const tool = createScheduleFollowUpTool({ scheduleFollowUp })

    const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const result = await tool.config.execute({ note: "n", scheduledFor }, EXEC_OPTS)

    const body = parse(result.output)
    expect(body).toMatchObject({ ok: false, pendingCount: 10, limit: 10 })
  })
})
