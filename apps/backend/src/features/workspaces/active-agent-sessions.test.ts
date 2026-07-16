import { describe, expect, it } from "bun:test"
import { projectActiveAgentSessions, type RunningSessionRow } from "./active-agent-sessions"

const startedAt = new Date("2026-06-10T10:00:00.000Z")

function row(overrides: Partial<RunningSessionRow>): RunningSessionRow {
  return {
    sessionId: "session_1",
    streamId: "stream_channel",
    rootStreamId: "stream_channel",
    personaId: "persona_1",
    startedAt,
    ...overrides,
  }
}

describe("projectActiveAgentSessions", () => {
  it("projects accessible running sessions and resolves persona + bot names", () => {
    const sessions = [
      row({ sessionId: "s_persona", personaId: "persona_1", rootStreamId: "stream_a", streamId: "stream_a" }),
      row({ sessionId: "s_bot", personaId: "bot_1", rootStreamId: "stream_a", streamId: "stream_thread" }),
    ]
    const accessible = new Set(["stream_a"])
    const names = new Map([
      ["persona_1", "Ada"],
      ["bot_1", "Codey"],
    ])

    expect(projectActiveAgentSessions(sessions, accessible, names)).toEqual([
      {
        sessionId: "s_persona",
        streamId: "stream_a",
        rootStreamId: "stream_a",
        personaName: "Ada",
        startedAt: startedAt.toISOString(),
      },
      {
        sessionId: "s_bot",
        streamId: "stream_thread",
        rootStreamId: "stream_a",
        personaName: "Codey",
        startedAt: startedAt.toISOString(),
      },
    ])
  })

  it("drops a session whose root the viewer cannot access (INV-62)", () => {
    const sessions = [
      row({ sessionId: "s_visible", rootStreamId: "stream_public", streamId: "stream_public" }),
      // Running in a private stream (or a thread of one) the viewer is not a
      // member of: its root is absent from the accessible set, so it must not leak.
      row({ sessionId: "s_private", rootStreamId: "stream_private", streamId: "stream_private_thread" }),
    ]
    const accessible = new Set(["stream_public"])
    const names = new Map([["persona_1", "Ada"]])

    const result = projectActiveAgentSessions(sessions, accessible, names)
    expect(result.map((s) => s.sessionId)).toEqual(["s_visible"])
  })

  it("falls back to a generic name for an unresolved agent id", () => {
    const sessions = [row({ personaId: "persona_gone", rootStreamId: "stream_a", streamId: "stream_a" })]
    const result = projectActiveAgentSessions(sessions, new Set(["stream_a"]), new Map())
    expect(result[0]?.personaName).toBe("Agent")
  })
})
