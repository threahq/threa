import type { AgentOutcomeSummary } from "@threahq/types"
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

function subagent(overrides: Partial<AgentOutcomeSummary> = {}): AgentOutcomeSummary {
  return {
    kind: "subagent",
    id: "subagent_1",
    streamId: "str_strategy",
    title: "Second opinion on retry semantics",
    status: "active",
    scheduledFor: null,
    claimedByLabel: null,
    statusNote: null,
    resultMessageId: null,
    actorType: "user",
    actorId: "usr_kris",
    createdAt: "2026-07-28T09:00:00.000Z",
    statusChangedAt: "2026-07-28T10:30:00.000Z",
    occursAt: "2026-07-28T10:30:00.000Z",
    anchorEventId: "event_3",
    lastAgentMessageAt: null,
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
      canRequeue: false,
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
      canRequeue: false,
      canMarkDone: true,
    })
  })

  it("marks terminal statuses settled and offers no actions", () => {
    expect(toOutcomeItem("ws_1", followUp({ status: "fired" }))).toMatchObject({
      statusLabel: "Ran",
      isSettled: true,
      canCancel: false,
      canRequeue: false,
      canMarkDone: false,
    })
    expect(toOutcomeItem("ws_1", delegation({ status: "completed" }))).toMatchObject({
      statusLabel: "Completed",
      isSettled: true,
      canCancel: false,
      canRequeue: false,
      canMarkDone: false,
    })
  })

  it("keeps an expired delegation outstanding and recoverable", () => {
    expect(toOutcomeItem("ws_1", delegation({ status: "expired" }))).toMatchObject({
      statusLabel: "Claim expired",
      isSettled: false,
      canCancel: true,
      canRequeue: true,
      canMarkDone: true,
    })
  })

  it("renders a null-anchor follow-up inert rather than as a dead link", () => {
    expect(toOutcomeItem("ws_1", followUp({ anchorEventId: null })).anchorPath).toBe(null)
  })

  it("reads an active run as working and leaves its actions on the card", () => {
    expect(toOutcomeItem("ws_1", subagent())).toMatchObject({
      kind: "subagent",
      statusLabel: "Working",
      isSettled: false,
      anchorPath: "/w/ws_1/s/str_strategy?m=event_3",
      canCancel: false,
      canRequeue: false,
      canMarkDone: false,
    })
  })

  it("says a run is waiting once it has spoken, and never spins without a session", () => {
    expect(toOutcomeItem("ws_1", subagent({ lastAgentMessageAt: "2026-07-28T10:31:00.000Z" }))).toMatchObject({
      statusLabel: "Waiting for you",
      isSettled: false,
    })
    // The list has no session signal, so the animated state is unreachable here.
    expect(toOutcomeItem("ws_1", subagent()).statusLabel).toBe("Working")
  })

  it("turns a run's failure reason CODE into words and settles it", () => {
    expect(toOutcomeItem("ws_1", subagent({ status: "failed", statusNote: "kickoff_failed" }))).toMatchObject({
      statusLabel: "Failed",
      statusNote: "it never started",
      isSettled: true,
    })
  })

  it("maps a mixed page in order", () => {
    expect(toOutcomeItems("ws_1", [followUp(), delegation(), subagent()]).map((i) => i.id)).toEqual([
      "fup_1",
      "deleg_1",
      "subagent_1",
    ])
  })
})
