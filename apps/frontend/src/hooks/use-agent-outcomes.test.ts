import { describe, expect, it } from "vitest"
import type { AgentOutcomeSummary } from "@threa/types"
import { msUntilNextFollowUpFires } from "./use-agent-outcomes"

const NOW = Date.parse("2026-07-20T10:00:00.000Z")

function followUp(overrides: Partial<AgentOutcomeSummary> = {}): AgentOutcomeSummary {
  return {
    id: "afu_1",
    kind: "follow_up",
    streamId: "stream_1",
    title: "Check the staging deploy",
    status: "pending",
    scheduledFor: "2026-07-20T10:01:00.000Z",
    claimedByLabel: null,
    statusNote: null,
    resultMessageId: null,
    actorType: "persona",
    actorId: "persona_1",
    createdAt: "2026-07-20T09:00:00.000Z",
    statusChangedAt: "2026-07-20T09:00:00.000Z",
    occursAt: "2026-07-20T10:01:00.000Z",
    anchorEventId: "event_1",
    ...overrides,
  } as AgentOutcomeSummary
}

describe("msUntilNextFollowUpFires", () => {
  it("wakes just after the soonest pending firing time", () => {
    const items = [
      followUp({ id: "afu_late", scheduledFor: "2026-07-20T10:05:00.000Z" }),
      followUp({ id: "afu_soon", scheduledFor: "2026-07-20T10:01:00.000Z" }),
    ]

    expect(msUntilNextFollowUpFires(items, NOW)).toBe(60_000 + 5_000)
  })

  it("rechecks a firing that is late, and gives up once it is stuck", () => {
    const queued = followUp({ scheduledFor: "2026-07-20T09:59:00.000Z" })
    const stuck = followUp({ scheduledFor: "2026-07-20T09:50:00.000Z" })

    expect({
      queued: msUntilNextFollowUpFires([queued], NOW),
      stuck: msUntilNextFollowUpFires([stuck], NOW),
    }).toEqual({ queued: 30_000, stuck: false })
  })

  it("never wakes for rows that can no longer change", () => {
    const settled = [
      followUp({ status: "fired" }),
      followUp({ status: "cancelled" }),
      followUp({ status: "pending", scheduledFor: null }),
      { ...followUp(), kind: "delegation", status: "running" } as AgentOutcomeSummary,
    ]

    expect({ settled: msUntilNextFollowUpFires(settled, NOW), empty: msUntilNextFollowUpFires([], NOW) }).toEqual({
      settled: false,
      empty: false,
    })
  })
})
