import type { AgentOutcomeSummary } from "@threa/types"
import { describe, expect, it } from "vitest"
import { toOutcomeItem, toOutcomeItems } from "./items"

function followUp(overrides: Partial<AgentOutcomeSummary> = {}): AgentOutcomeSummary {
  return {
    kind: "follow_up",
    id: "fup_1",
    streamId: "str_design",
    title: "Check in on the migration",
    status: "pending",
    scheduledFor: "2026-08-01T18:00:00.000Z",
    claimedByLabel: null,
    statusNote: null,
    resultMessageId: null,
    actorType: "persona",
    actorId: "persona_1",
    createdAt: "2026-07-28T09:00:00.000Z",
    statusChangedAt: "2026-07-28T09:00:00.000Z",
    occursAt: "2026-08-01T18:00:00.000Z",
    anchorEventId: "event_1",
    ...overrides,
  } as AgentOutcomeSummary
}

function delegation(overrides: Partial<AgentOutcomeSummary> = {}): AgentOutcomeSummary {
  return {
    kind: "delegation",
    id: "deleg_1",
    streamId: "str_strategy",
    title: "Run the schema migration locally",
    status: "running",
    scheduledFor: null,
    claimedByLabel: "kris@laptop",
    statusNote: "step 2 of 4",
    resultMessageId: null,
    actorType: "persona",
    actorId: "persona_1",
    createdAt: "2026-07-28T09:00:00.000Z",
    statusChangedAt: "2026-07-28T10:30:00.000Z",
    occursAt: "2026-07-28T10:30:00.000Z",
    anchorEventId: "event_2",
    ...overrides,
  } as AgentOutcomeSummary
}

describe("toOutcomeItem", () => {
  it("maps a pending follow-up to its display shape", () => {
    expect(toOutcomeItem("ws_1", followUp())).toEqual({
      id: "fup_1",
      kind: "follow_up",
      streamId: "str_design",
      title: "Check in on the migration",
      statusLabel: "Scheduled",
      statusPillClass: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
      isSettled: false,
      occursAt: "2026-08-01T18:00:00.000Z",
      scheduledFor: "2026-08-01T18:00:00.000Z",
      claimedByLabel: null,
      statusNote: null,
      createdAt: "2026-07-28T09:00:00.000Z",
      statusChangedAt: "2026-07-28T09:00:00.000Z",
      anchorPath: "/w/ws_1/s/str_design?m=event_1",
      canCancel: true,
      canMarkDone: false,
    })
  })

  it("maps a running delegation, which can be cancelled or marked done", () => {
    expect(toOutcomeItem("ws_1", delegation())).toMatchObject({
      kind: "delegation",
      statusLabel: "Running",
      isSettled: false,
      claimedByLabel: "kris@laptop",
      statusNote: "step 2 of 4",
      anchorPath: "/w/ws_1/s/str_strategy?m=event_2",
      canCancel: true,
      canMarkDone: true,
    })
  })

  it("marks terminal statuses settled and offers no actions", () => {
    expect(toOutcomeItem("ws_1", followUp({ status: "fired" }))).toMatchObject({
      statusLabel: "Ran",
      isSettled: true,
      canCancel: false,
      canMarkDone: false,
    })
    expect(toOutcomeItem("ws_1", delegation({ status: "completed" }))).toMatchObject({
      statusLabel: "Completed",
      isSettled: true,
      canCancel: false,
      canMarkDone: false,
    })
  })

  it("renders a null-anchor follow-up inert rather than as a dead link", () => {
    expect(toOutcomeItem("ws_1", followUp({ anchorEventId: null })).anchorPath).toBe(null)
  })

  it("maps a mixed page in order", () => {
    expect(toOutcomeItems("ws_1", [followUp(), delegation()]).map((i) => i.id)).toEqual(["fup_1", "deleg_1"])
  })
})
