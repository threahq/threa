import { describe, expect, it } from "vitest"
import type { ThreadSummary } from "@threahq/types"
import type { SubagentCreatedEventPayload, SubagentStatus } from "@threahq/types"
import {
  isSubagentAuthoredMessage,
  resolveSubagentCardState,
  resolveSubagentThreadRun,
  subagentFailureLabel,
  subagentStateAnimates,
  SUBAGENT_STATE_LABEL,
} from "./subagent-display"

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
    expect(resolveSubagentCardState({ status: "active", hasLiveSession: true, lastAgentMessageAt: AGENT_AT })).toBe(
      "working"
    )
  })

  it("never resolves the animated state without a live session", () => {
    expect(resolveSubagentCardState({ status: "active", hasLiveSession: false })).toBe("starting")
    // Same words to the reader, no motion behind them.
    expect(SUBAGENT_STATE_LABEL.starting).toBe(SUBAGENT_STATE_LABEL.working)
    expect([subagentStateAnimates("working"), subagentStateAnimates("starting")]).toEqual([true, false])
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

  it("stops waiting — but does not start spinning — once the reader replied", () => {
    expect(
      resolveSubagentCardState({
        status: "active",
        hasLiveSession: false,
        lastAgentMessageAt: AGENT_AT,
        threadSummary: summary("2026-09-01T10:05:00.000Z", "user"),
      })
    ).toBe("starting")
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

describe("resolveSubagentThreadRun", () => {
  const card = {
    createdAt: "2026-09-01T10:00:00.000Z",
    payload: {
      subagentId: "subagent_1",
      title: "Second opinion",
      model: "openrouter:anthropic/claude-opus-5",
      personaId: "persona_ariadne",
      threadStreamId: "stream_thread",
      createdBy: "usr_kris",
      sourceConversationId: null,
    } satisfies SubagentCreatedEventPayload,
  }

  function patch(status: SubagentStatus, at: string) {
    return { at, status }
  }

  it("leaves the window open while the run is active", () => {
    expect(resolveSubagentThreadRun({ card, orderedPatches: [] }).endedAt).toBeNull()
  })

  it("closes the window on the run's last transition", () => {
    const run = resolveSubagentThreadRun({
      card,
      orderedPatches: [patch("active", "2026-09-01T10:05:00.000Z"), patch("completed", "2026-09-01T10:12:00.000Z")],
    })
    expect(run.endedAt).toBe("2026-09-01T10:12:00.000Z")
  })

  it("reopens the window when a requeue follows a terminal patch", () => {
    // The trap: reading "the latest TERMINAL patch" would leave the window shut
    // and unbadge every message of the restarted run, permanently.
    const run = resolveSubagentThreadRun({
      card,
      orderedPatches: [patch("failed", "2026-09-01T10:12:00.000Z"), patch("active", "2026-09-01T10:20:00.000Z")],
    })
    expect(run.endedAt).toBeNull()
  })

  it("closes the window from the run row when no patch is in reach", () => {
    // A deep link into a finished thread caches no parent events at all.
    const run = resolveSubagentThreadRun({
      card,
      orderedPatches: [],
      fallback: { status: "completed", statusChangedAt: "2026-09-01T10:12:00.000Z" },
    })
    expect(run.endedAt).toBe("2026-09-01T10:12:00.000Z")
  })

  it("prefers a patch it can see over the fallback", () => {
    const run = resolveSubagentThreadRun({
      card,
      orderedPatches: [patch("active", "2026-09-01T10:20:00.000Z")],
      fallback: { status: "completed", statusChangedAt: "2026-09-01T10:12:00.000Z" },
    })
    expect(run.endedAt).toBeNull()
  })
})
