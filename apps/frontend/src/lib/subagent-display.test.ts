import { describe, expect, it } from "vitest"
import type { ThreadSummary } from "@threa/types"
import { isSubagentAuthoredMessage, resolveSubagentCardState, subagentFailureLabel } from "./subagent-display"

const AGENT_AT = "2026-09-01T10:00:00.000Z"

function summary(lastReplyAt: string, actorType: "user" | "persona"): ThreadSummary {
  return {
    lastReplyAt,
    participants: [],
    latestReply: { messageId: "msg_1", actorId: "a", actorType, contentMarkdown: "…" },
  }
}

describe("resolveSubagentCardState", () => {
  it("passes every terminal status straight through", () => {
    const states = (["completed", "cancelled", "failed", "expired"] as const).map((status) =>
      resolveSubagentCardState({ status, hasLiveSession: false })
    )
    expect(states).toEqual(["completed", "cancelled", "failed", "expired"])
  })

  it("prefers a live session over anything the patches say", () => {
    expect(
      resolveSubagentCardState({ status: "active", hasLiveSession: true, lastAgentMessageAt: AGENT_AT })
    ).toBe("working")
  })

  it("does not claim to wait before the subagent has spoken", () => {
    expect(resolveSubagentCardState({ status: "active", hasLiveSession: false })).toBe("working")
  })

  it("waits when the subagent's message is the newest thing either source knows", () => {
    expect(
      resolveSubagentCardState({
        status: "active",
        hasLiveSession: false,
        lastAgentMessageAt: AGENT_AT,
        threadSummary: summary("2026-09-01T09:59:00.000Z", "persona"),
      })
    ).toBe("waiting")
  })

  it("stops waiting once newer thread stats say the reader replied", () => {
    expect(
      resolveSubagentCardState({
        status: "active",
        hasLiveSession: false,
        lastAgentMessageAt: AGENT_AT,
        threadSummary: summary("2026-09-01T10:05:00.000Z", "user"),
      })
    ).toBe("working")
  })

  it("keeps waiting when the newer reply is the subagent's own", () => {
    expect(
      resolveSubagentCardState({
        status: "active",
        hasLiveSession: false,
        lastAgentMessageAt: AGENT_AT,
        threadSummary: summary("2026-09-01T10:05:00.000Z", "persona"),
      })
    ).toBe("waiting")
  })
})

describe("subagentFailureLabel", () => {
  it("turns each reason code into words", () => {
    expect([
      subagentFailureLabel("turn_failed"),
      subagentFailureLabel("session_orphaned"),
      subagentFailureLabel("kickoff_failed"),
    ]).toEqual(["the turn failed", "the session was lost", "it never started"])
  })

  it("renders nothing rather than leaking an unknown note at the reader", () => {
    expect([subagentFailureLabel(null), subagentFailureLabel("boom: upstream 502")]).toEqual([null, null])
  })
})

describe("isSubagentAuthoredMessage", () => {
  const run = {
    subagentId: "subagent_1",
    model: "openrouter:anthropic/claude-opus-5",
    personaId: "persona_ariadne",
    startedAt: "2026-09-01T10:00:00.000Z",
    endedAt: null as string | null,
  }

  it("badges the run's persona inside an open window", () => {
    expect(
      isSubagentAuthoredMessage(run, {
        actorId: "persona_ariadne",
        actorType: "persona",
        createdAt: "2026-09-01T10:05:00.000Z",
      })
    ).toBe(true)
  })

  it("never badges the user or another persona", () => {
    expect([
      isSubagentAuthoredMessage(run, { actorId: "usr_1", actorType: "user", createdAt: "2026-09-01T10:05:00.000Z" }),
      isSubagentAuthoredMessage(run, {
        actorId: "persona_other",
        actorType: "persona",
        createdAt: "2026-09-01T10:05:00.000Z",
      }),
    ]).toEqual([false, false])
  })

  it("stops badging after the run closed — that reply is the persona's own model again", () => {
    const closed = { ...run, endedAt: "2026-09-01T10:10:00.000Z" }
    expect([
      isSubagentAuthoredMessage(closed, {
        actorId: "persona_ariadne",
        actorType: "persona",
        createdAt: "2026-09-01T10:09:00.000Z",
      }),
      isSubagentAuthoredMessage(closed, {
        actorId: "persona_ariadne",
        actorType: "persona",
        createdAt: "2026-09-01T10:11:00.000Z",
      }),
      isSubagentAuthoredMessage(closed, {
        actorId: "persona_ariadne",
        actorType: "persona",
        createdAt: "2026-09-01T09:59:00.000Z",
      }),
    ]).toEqual([true, false, false])
  })
})
