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

describe("AgentSessionRepository.listRunningByWorkspace", () => {
  afterEach(() => {
    mock.restore()
  })

  it("binds the workspace and running status and maps rows to the bootstrap shape", async () => {
    let capturedValues: unknown[] = []
    const db: Querier = {
      query: mock(async (queryTextOrConfig) => {
        capturedValues = (queryTextOrConfig as QueryConfig).values ?? []
        return {
          rows: [
            {
              session_id: "session_root",
              stream_id: "stream_channel",
              root_stream_id: "stream_channel",
              parent_anchor_id: null,
              trigger_message_id: "msg_root",
              persona_id: "persona_1",
              started_at: new Date("2026-06-10T10:00:00.000Z"),
              current_step_type: null,
            },
            {
              session_id: "session_thread",
              stream_id: "stream_thread",
              root_stream_id: "stream_channel",
              parent_anchor_id: "msg_anchor",
              trigger_message_id: "msg_thread",
              persona_id: "bot_1",
              started_at: new Date("2026-06-10T10:05:00.000Z"),
              current_step_type: "thinking",
            },
          ],
          rowCount: 2,
        } as QueryResult
      }),
    }

    const rows = await AgentSessionRepository.listRunningByWorkspace(db, "ws_1")

    expect(capturedValues).toEqual(["ws_1", SessionStatuses.RUNNING])

    expect(rows).toEqual([
      {
        sessionId: "session_root",
        streamId: "stream_channel",
        rootStreamId: "stream_channel",
        parentAnchorId: null,
        triggerMessageId: "msg_root",
        personaId: "persona_1",
        startedAt: new Date("2026-06-10T10:00:00.000Z"),
        currentStepType: null,
      },
      {
        sessionId: "session_thread",
        streamId: "stream_thread",
        rootStreamId: "stream_channel",
        parentAnchorId: "msg_anchor",
        triggerMessageId: "msg_thread",
        personaId: "bot_1",
        startedAt: new Date("2026-06-10T10:05:00.000Z"),
        currentStepType: "thinking",
      },
    ])
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

describe("AgentSessionRepository.setEpisodeSummary", () => {
  afterEach(() => {
    mock.restore()
  })

  it("guards the write on episode_summary IS NULL (CAS) and reports whether it wrote", async () => {
    const captured = { text: null as string | null, values: null as unknown[] | null }
    const db: Querier = {
      query: mock(async (queryTextOrConfig) => {
        const config = queryTextOrConfig as QueryConfig
        captured.text = config.text
        captured.values = config.values ?? []
        return { rows: [], rowCount: 1 } as unknown as QueryResult
      }),
    }

    const wrote = await AgentSessionRepository.setEpisodeSummary(db, "session_1", "did X, concluded Y")

    expect(captured.text).toContain("SET episode_summary =")
    expect(captured.text).toContain("WHERE id = $")
    expect(captured.text).toContain("AND episode_summary IS NULL")
    expect(captured.values).toEqual(["did X, concluded Y", "session_1"])
    expect(wrote).toBe(true)
  })

  it("reports no write when the CAS matched nothing (already summarized)", async () => {
    const db: Querier = {
      query: mock(async () => ({ rows: [], rowCount: 0 }) as unknown as QueryResult),
    }
    const wrote = await AgentSessionRepository.setEpisodeSummary(db, "session_1", "s")
    expect(wrote).toBe(false)
  })
})

describe("AgentSessionRepository.findRecentEpisodeSummariesByStream", () => {
  afterEach(() => {
    mock.restore()
  })

  it("selects non-null summaries of the stream's COMPLETED sessions for the persona, newest first", async () => {
    const captured = { text: null as string | null, values: null as unknown[] | null }
    const db: Querier = {
      query: mock(async (queryTextOrConfig) => {
        const config = queryTextOrConfig as QueryConfig
        captured.text = config.text
        captured.values = config.values ?? []
        return {
          rows: [
            {
              summary: "looked into the deploy cadence; concluded Fridays only",
              created_at: new Date("2026-06-10T09:59:00.000Z"),
              completed_at: new Date("2026-06-10T10:00:02.000Z"),
            },
          ],
          rowCount: 1,
        } as QueryResult
      }),
    }

    const rows = await AgentSessionRepository.findRecentEpisodeSummariesByStream(db, {
      streamId: "stream_1",
      personaId: "persona_1",
      limit: 3,
    })

    expect(captured.text).toContain("episode_summary AS summary")
    expect(captured.text).toContain("stream_id =")
    expect(captured.text).toContain("persona_id =")
    expect(captured.text).toContain("status =")
    expect(captured.text).toContain("episode_summary IS NOT NULL")
    expect(captured.text).toContain("ORDER BY created_at DESC, id DESC")
    expect(captured.values).toEqual(["stream_1", "persona_1", SessionStatuses.COMPLETED, 3])

    expect(rows).toEqual([
      {
        summary: "looked into the deploy cadence; concluded Fridays only",
        sessionCreatedAt: new Date("2026-06-10T09:59:00.000Z"),
        sessionCompletedAt: new Date("2026-06-10T10:00:02.000Z"),
      },
    ])
  })
})
