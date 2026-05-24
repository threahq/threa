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
