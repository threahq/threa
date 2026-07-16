import { describe, expect, it, beforeEach } from "vitest"
import type { ActiveAgentSession } from "@threa/types"
import {
  seedAgentActivity,
  upsertAgentSession,
  removeAgentSession,
  getAgentActivityForStream,
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

  it("seeds by root and reads back the running sessions", () => {
    seedAgentActivity(WS, [session({ sessionId: "s1", rootStreamId: "stream_a" })])
    expect(getAgentActivityForStream(WS, "stream_a").map((s) => s.sessionId)).toEqual(["s1"])
    expect(getAgentActivityForStream(WS, "stream_b")).toEqual([])
  })

  it("re-seed replaces the set, dropping entries whose end was missed (reconnect)", () => {
    seedAgentActivity(WS, [session({ sessionId: "s1", rootStreamId: "stream_a" })])
    // Reconnect bootstrap no longer lists s1 → it must clear.
    seedAgentActivity(WS, [session({ sessionId: "s2", rootStreamId: "stream_c" })])
    expect(getAgentActivityForStream(WS, "stream_a")).toEqual([])
    expect(getAgentActivityForStream(WS, "stream_c").map((s) => s.sessionId)).toEqual(["s2"])
  })

  it("orders multiple sessions on a root by most recently started", () => {
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

  it("moving a session to a new root clears the old root's snapshot", () => {
    upsertAgentSession(WS, session({ sessionId: "s1", rootStreamId: "stream_a" }))
    upsertAgentSession(WS, session({ sessionId: "s1", rootStreamId: "stream_b" }))
    expect(getAgentActivityForStream(WS, "stream_a")).toEqual([])
    expect(getAgentActivityForStream(WS, "stream_b").map((s) => s.sessionId)).toEqual(["s1"])
  })
})
