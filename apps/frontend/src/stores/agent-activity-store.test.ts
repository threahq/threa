import { describe, expect, it, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { ActiveAgentSession } from "@threa/types"
import {
  seedAgentActivity,
  upsertAgentSession,
  removeAgentSession,
  getAgentActivityForStream,
  getAgentSession,
  updateAgentSessionProgress,
  useAgentSessionActivities,
  useAgentSessionActivity,
  __resetAgentActivityStore,
} from "./agent-activity-store"

const WS = "ws_1"

function session(overrides: Partial<ActiveAgentSession>): ActiveAgentSession {
  return {
    sessionId: "sess_1",
    streamId: "stream_a",
    rootStreamId: "stream_a",
    personaName: "Ada",
    startedAt: "2026-06-10T10:00:00.000Z",
    ...overrides,
  }
}

describe("agent-activity-store", () => {
  beforeEach(() => __resetAgentActivityStore())

  it("seeds by stream and reads back the running sessions", () => {
    seedAgentActivity(WS, [session({ sessionId: "s1", streamId: "stream_a" })])
    expect(getAgentActivityForStream(WS, "stream_a").map((s) => s.sessionId)).toEqual(["s1"])
    expect(getAgentActivityForStream(WS, "stream_b")).toEqual([])
  })

  it("re-seed replaces the set, dropping entries whose end was missed (reconnect)", () => {
    seedAgentActivity(WS, [session({ sessionId: "s1", streamId: "stream_a" })])
    // Reconnect bootstrap no longer lists s1 → it must clear.
    seedAgentActivity(WS, [session({ sessionId: "s2", streamId: "stream_c" })])
    expect(getAgentActivityForStream(WS, "stream_a")).toEqual([])
    expect(getAgentActivityForStream(WS, "stream_c").map((s) => s.sessionId)).toEqual(["s2"])
  })

  it("keeps thread activity separate from its parent stream", () => {
    seedAgentActivity(WS, [
      session({ sessionId: "thread_session", streamId: "stream_thread", rootStreamId: "stream_parent" }),
    ])
    expect(getAgentActivityForStream(WS, "stream_parent")).toEqual([])
    expect(getAgentActivityForStream(WS, "stream_thread").map((s) => s.sessionId)).toEqual(["thread_session"])
  })

  it("orders multiple sessions in a stream by most recently started", () => {
    seedAgentActivity(WS, [
      session({
        sessionId: "old",
        rootStreamId: "stream_a",
        startedAt: "2026-06-10T10:00:00.000Z",
        personaName: "Old",
      }),
      session({
        sessionId: "new",
        rootStreamId: "stream_a",
        startedAt: "2026-06-10T10:05:00.000Z",
        personaName: "New",
      }),
    ])
    expect(getAgentActivityForStream(WS, "stream_a").map((s) => s.sessionId)).toEqual(["new", "old"])
  })

  it("upsert adds a live session and keeps a referentially-stable snapshot when unchanged", () => {
    upsertAgentSession(WS, session({ sessionId: "s1", rootStreamId: "stream_a" }))
    const first = getAgentActivityForStream(WS, "stream_a")
    // Idempotent upsert must not churn the snapshot reference (avoids row re-render).
    upsertAgentSession(WS, session({ sessionId: "s1", rootStreamId: "stream_a" }))
    expect(getAgentActivityForStream(WS, "stream_a")).toBe(first)
  })

  it("removes by session id regardless of root (terminal signal)", () => {
    seedAgentActivity(WS, [session({ sessionId: "s1", rootStreamId: "stream_a" })])
    removeAgentSession(WS, "s1")
    expect(getAgentActivityForStream(WS, "stream_a")).toEqual([])
  })

  it("moving a session to a new stream clears the old stream's snapshot", () => {
    upsertAgentSession(WS, session({ sessionId: "s1", streamId: "stream_a" }))
    upsertAgentSession(WS, session({ sessionId: "s1", streamId: "stream_b" }))
    expect(getAgentActivityForStream(WS, "stream_a")).toEqual([])
    expect(getAgentActivityForStream(WS, "stream_b").map((s) => s.sessionId)).toEqual(["s1"])
  })

  it("folds a progress tick into a tracked session's live counts", () => {
    upsertAgentSession(WS, session({ sessionId: "s1" }))
    updateAgentSessionProgress(WS, "s1", { stepCount: 3, messageCount: 1 })
    expect(getAgentSession(WS, "s1")).toEqual({
      ...session({ sessionId: "s1" }),
      stepCount: 3,
      messageCount: 1,
      substep: null,
    })
  })

  it("ignores progress for a session it doesn't track (untracked stays absent)", () => {
    updateAgentSessionProgress(WS, "ghost", { stepCount: 9 })
    expect(getAgentSession(WS, "ghost")).toBeUndefined()
  })

  it("a later `started` upsert keeps counts a progress tick already delivered", () => {
    upsertAgentSession(WS, session({ sessionId: "s1" }))
    updateAgentSessionProgress(WS, "s1", { stepCount: 4, messageCount: 2, substep: "Reading docs" })
    upsertAgentSession(WS, session({ sessionId: "s1", personaName: "Ada" }))
    expect(getAgentSession(WS, "s1")).toMatchObject({ stepCount: 4, messageCount: 2, substep: "Reading docs" })
  })

  it("a step advance drops the previous step's substep", () => {
    upsertAgentSession(WS, session({ sessionId: "s1" }))
    updateAgentSessionProgress(WS, "s1", { stepCount: 1, substep: "Evaluating results" })
    updateAgentSessionProgress(WS, "s1", { stepCount: 2, messageCount: 0 })
    expect(getAgentSession(WS, "s1")).toMatchObject({ stepCount: 2, substep: null })
  })

  it("a tick on one session leaves another session's counts untouched", () => {
    upsertAgentSession(WS, session({ sessionId: "s1" }))
    upsertAgentSession(WS, session({ sessionId: "s2", streamId: "stream_b" }))
    updateAgentSessionProgress(WS, "s1", { stepCount: 5 })
    updateAgentSessionProgress(WS, "s2", { stepCount: 7 })
    updateAgentSessionProgress(WS, "s1", { stepCount: 6 })
    expect(getAgentSession(WS, "s2")).toMatchObject({ stepCount: 7 })
  })

  it("counts seeded by the join-time bootstrap tick survive until the next change", () => {
    // The join emits a progress tick before any row mounts; a row mounting later
    // must read the stored count, not 0.
    upsertAgentSession(WS, session({ sessionId: "s1", stepCount: 8, messageCount: 3 }))
    expect(getAgentSession(WS, "s1")).toMatchObject({ stepCount: 8, messageCount: 3 })
  })

  it("a reconnect re-seed keeps a still-running session's live progress", () => {
    // Reconnect order: the rejoin's bootstrap tick lands first, THEN the workspace
    // bootstrap re-seed. The bootstrap projection carries no progress fields, so a
    // blind replace would blank the row back to "0 steps • 0 messages sent".
    seedAgentActivity(WS, [session({ sessionId: "s1" })])
    updateAgentSessionProgress(WS, "s1", { stepCount: 4, messageCount: 2, substep: "Evaluating results…" })

    seedAgentActivity(WS, [session({ sessionId: "s1" })])

    expect(getAgentSession(WS, "s1")).toMatchObject({
      stepCount: 4,
      messageCount: 2,
      substep: "Evaluating results…",
    })
  })

  describe("comparator scoping (a tick only invalidates what renders it)", () => {
    it("a substep-only tick leaves the stream snapshot referentially identical", () => {
      upsertAgentSession(WS, session({ sessionId: "s1" }))
      const before = getAgentActivityForStream(WS, "stream_a")
      act(() => updateAgentSessionProgress(WS, "s1", { substep: "Reading docs" }))
      expect(getAgentActivityForStream(WS, "stream_a")).toBe(before)
    })

    it("a substep-only tick does not re-render the plural (chip) hook, but a stepCount change does", () => {
      upsertAgentSession(WS, session({ sessionId: "s1", stepCount: 1 }))
      let renders = 0
      const { result } = renderHook(() => {
        renders += 1
        return useAgentSessionActivities(WS, ["s1"])
      })
      const initialRenders = renders
      const first = result.current

      act(() => updateAgentSessionProgress(WS, "s1", { substep: "Reading docs" }))
      expect(renders).toBe(initialRenders)
      expect(result.current).toBe(first)

      act(() => updateAgentSessionProgress(WS, "s1", { stepCount: 2 }))
      expect(renders).toBeGreaterThan(initialRenders)
      expect(result.current[0]).toMatchObject({ stepCount: 2 })
    })

    it("the singular (row) hook sees both a substep tick and a stepCount change", () => {
      upsertAgentSession(WS, session({ sessionId: "s1", stepCount: 1 }))
      const { result } = renderHook(() => useAgentSessionActivity(WS, "s1"))

      act(() => updateAgentSessionProgress(WS, "s1", { substep: "Reading docs" }))
      expect(result.current).toMatchObject({ stepCount: 1, substep: "Reading docs" })

      act(() => updateAgentSessionProgress(WS, "s1", { stepCount: 2, substep: "Evaluating" }))
      expect(result.current).toMatchObject({ stepCount: 2, substep: "Evaluating" })
    })
  })
})
