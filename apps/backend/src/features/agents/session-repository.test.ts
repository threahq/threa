import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { AgentSessionRepository, SessionStatuses } from "./session-repository"

const SESSION_ROW = {
  id: "session_1",
  stream_id: "stream_1",
  persona_id: "persona_1",
  trigger_message_id: "msg_1",
  trigger_message_revision: null,
  supersedes_session_id: null,
  status: SessionStatuses.SUPERSEDED,
  current_step: 0,
  current_step_type: null,
  server_id: null,
  heartbeat_at: null,
  response_message_id: null,
  error: "Superseded by invoking message edit",
  last_seen_sequence: "5",
  sent_message_ids: ["msg_agent_1"],
  created_at: new Date("2026-02-19T20:00:00.000Z"),
  completed_at: new Date("2026-02-19T20:01:00.000Z"),
}

function createQuerierCapture(captured: { text: string | null; values: unknown[] | null }): Querier {
  return {
    query: mock(async (queryTextOrConfig) => {
      const config = queryTextOrConfig as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return {
        rows: [SESSION_ROW],
        rowCount: 1,
      } as QueryResult
    }),
  }
}

describe("AgentSessionRepository.insertRunningOrSkip", () => {
  afterEach(() => {
    mock.restore()
  })

  it("skips conflicts from both the running-session index and session primary key", async () => {
    const captured = { text: null as string | null, values: null as unknown[] | null }
    const db = createQuerierCapture(captured)

    await AgentSessionRepository.insertRunningOrSkip(db, {
      id: "binv_1",
      streamId: "stream_1",
      personaId: "bot_1",
      triggerMessageId: "msg_1",
      initialSequence: 5n,
    })

    expect(captured.text).not.toBeNull()
    expect(captured.text).toContain("ON CONFLICT DO NOTHING")
    expect(captured.text).not.toContain("ON CONFLICT (stream_id)")
  })
})

describe("AgentSessionRepository.updateStatus SQL guards", () => {
  afterEach(() => {
    mock.restore()
  })

  it("emits a valid onlyIfStatusIn predicate without fragment placeholders", async () => {
    const captured = { text: null as string | null, values: null as unknown[] | null }
    const db = createQuerierCapture(captured)

    await AgentSessionRepository.updateStatus(db, "session_1", SessionStatuses.SUPERSEDED, {
      error: "Superseded by invoking message edit",
      onlyIfStatusIn: [SessionStatuses.COMPLETED, SessionStatuses.FAILED],
    })

    expect(captured.text).not.toBeNull()
    expect(captured.text).toContain("WHERE id = $")
    expect(captured.text).toContain("AND status = ANY($")
    expect(captured.text).not.toMatch(/WHERE id = \$\d+\s+\$\d+/)
    expect(captured.values).toContainEqual([SessionStatuses.COMPLETED, SessionStatuses.FAILED])
  })

  it("omits status predicate when no guards are provided", async () => {
    const captured = { text: null as string | null, values: null as unknown[] | null }
    const db = createQuerierCapture(captured)

    await AgentSessionRepository.updateStatus(db, "session_1", SessionStatuses.FAILED, {
      error: "Agent loop completed without sending a message",
    })

    expect(captured.text).not.toBeNull()
    expect(captured.text).toContain("WHERE id = $")
    expect(captured.text).not.toContain("AND status = ANY(")
  })
})

describe("AgentSessionRepository.updateStep finalize-race guard", () => {
  afterEach(() => {
    mock.restore()
  })

  it("gates the update on a still-running step when requireRunning is set", async () => {
    const captured = { text: null as string | null, values: null as unknown[] | null }
    const db = createQuerierCapture(captured)

    await AgentSessionRepository.updateStep(db, "step_1", {
      contentCiphertext: "ct",
      contentEnvelope: { keyGeneration: 1 },
      requireRunning: true,
    })

    expect(captured.text).toContain("AND completed_at IS NULL")
  })

  it("updates unconditionally when requireRunning is not set (finalize path)", async () => {
    const captured = { text: null as string | null, values: null as unknown[] | null }
    const db = createQuerierCapture(captured)

    await AgentSessionRepository.updateStep(db, "step_1", { completedAt: new Date(), content: { done: true } })

    expect(captured.text).not.toContain("AND completed_at IS NULL")
  })
})

describe("AgentSessionRepository.findRecentDigestStepsByStream", () => {
  afterEach(() => {
    mock.restore()
  })

  it("selects turn_digest steps of the stream's COMPLETED sessions for the persona, newest session first", async () => {
    const captured = { text: null as string | null, values: null as unknown[] | null }
    const db: Querier = {
      query: mock(async (queryTextOrConfig) => {
        const config = queryTextOrConfig as QueryConfig
        captured.text = config.text
        captured.values = config.values ?? []
        return {
          rows: [
            {
              id: "step_digest",
              session_id: "session_1",
              step_number: 7,
              step_type: "turn_digest",
              content: '{"findings":"x"}',
              content_ciphertext: null,
              content_envelope: null,
              sources: null,
              message_id: null,
              tokens_used: null,
              started_at: new Date("2026-06-10T10:00:00.000Z"),
              completed_at: new Date("2026-06-10T10:00:01.000Z"),
              session_created_at: new Date("2026-06-10T09:59:00.000Z"),
              session_completed_at: new Date("2026-06-10T10:00:02.000Z"),
            },
          ],
          rowCount: 1,
        } as QueryResult
      }),
    }

    const rows = await AgentSessionRepository.findRecentDigestStepsByStream(db, {
      streamId: "stream_1",
      personaId: "persona_1",
      limit: 5,
    })

    expect(captured.text).toContain("JOIN agent_sessions s ON s.id = st.session_id")
    expect(captured.text).toContain("s.stream_id =")
    expect(captured.text).toContain("s.persona_id =")
    expect(captured.text).toContain("s.status =")
    expect(captured.text).toContain("st.step_type =")
    expect(captured.text).toContain("ORDER BY s.created_at DESC, st.step_number DESC")
    expect(captured.values).toEqual(["stream_1", "persona_1", SessionStatuses.COMPLETED, "turn_digest", 5])

    expect(rows).toEqual([
      {
        step: {
          id: "step_digest",
          sessionId: "session_1",
          stepNumber: 7,
          stepType: "turn_digest",
          content: '{"findings":"x"}',
          contentCiphertext: null,
          contentEnvelope: null,
          sources: null,
          messageId: null,
          tokensUsed: null,
          startedAt: new Date("2026-06-10T10:00:00.000Z"),
          completedAt: new Date("2026-06-10T10:00:01.000Z"),
        },
        sessionCreatedAt: new Date("2026-06-10T09:59:00.000Z"),
        sessionCompletedAt: new Date("2026-06-10T10:00:02.000Z"),
      },
    ])
  })
})
