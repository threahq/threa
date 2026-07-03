import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { FollowUpStatuses } from "@threa/types"
import { AgentFollowUpRepository } from "./follow-up-repository"

const NOW = new Date("2026-07-02T12:00:00.000Z")
const SCHEDULED_FOR = new Date("2026-07-03T12:00:00.000Z")

const ROW = {
  id: "agfu_01",
  workspace_id: "ws_1",
  stream_id: "stream_1",
  persona_id: "persona_system_ariadne",
  session_id: "session_1",
  source_conversation_id: null,
  note: "check back on the deploy",
  scheduled_for: SCHEDULED_FOR,
  status: FollowUpStatuses.PENDING,
  queue_message_id: null,
  last_error: null,
  created_at: NOW,
  updated_at: NOW,
  status_changed_at: NOW,
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [ROW]): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rows.length } as QueryResult
    }),
  }
}

describe("AgentFollowUpRepository.insertIfUnderCap", () => {
  afterEach(() => mock.restore())

  it("guards the insert with a pending count-under-limit subquery (INV-20, not check-then-act)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await AgentFollowUpRepository.insertIfUnderCap(
      db,
      {
        id: "agfu_01",
        workspaceId: "ws_1",
        streamId: "stream_1",
        personaId: "persona_system_ariadne",
        sessionId: "session_1",
        sourceConversationId: null,
        note: "check back on the deploy",
        scheduledFor: SCHEDULED_FOR,
      },
      10
    )

    expect(captured.text).toContain("INSERT INTO agent_follow_ups")
    expect(captured.text).toContain("count(*)")
    expect(captured.text).toContain("RETURNING")
    // The cap and the pending-status filter both ride the guard.
    expect(captured.values).toContain(10)
    expect(captured.values).toContain(FollowUpStatuses.PENDING)
  })

  it("returns null when the guarded insert writes no row (cap already met)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    const result = await AgentFollowUpRepository.insertIfUnderCap(
      db,
      {
        id: "agfu_01",
        workspaceId: "ws_1",
        streamId: "stream_1",
        personaId: "persona_system_ariadne",
        sessionId: "session_1",
        sourceConversationId: null,
        note: "note",
        scheduledFor: SCHEDULED_FOR,
      },
      10
    )

    expect(result).toBeNull()
  })
})

describe("AgentFollowUpRepository CAS transitions", () => {
  afterEach(() => mock.restore())

  it("markFired only transitions a pending row (exactly-once fire)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await AgentFollowUpRepository.markFired(db, "ws_1", "agfu_01")

    expect(captured.text).toContain("UPDATE agent_follow_ups")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.values).toContain(FollowUpStatuses.FIRED)
    expect(captured.values).toContain(FollowUpStatuses.PENDING)
  })

  it("markCancelled only transitions a pending row (loses to a fire that already landed)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    const result = await AgentFollowUpRepository.markCancelled(db, "ws_1", "agfu_01")

    expect(result).toBeNull()
    expect(captured.values).toContain(FollowUpStatuses.CANCELLED)
    expect(captured.values).toContain(FollowUpStatuses.PENDING)
  })

  it("markFailed transitions from pending or fired", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await AgentFollowUpRepository.markFailed(db, "ws_1", "agfu_01", "boom")

    expect(captured.values).toContain(FollowUpStatuses.FAILED)
    expect(captured.values).toContain(FollowUpStatuses.PENDING)
    expect(captured.values).toContain(FollowUpStatuses.FIRED)
    expect(captured.values).toContain("boom")
  })
})

describe("AgentFollowUpRepository.acquireStreamCapLock", () => {
  afterEach(() => mock.restore())

  it("takes a transaction-scoped advisory lock keyed on workspace + stream", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    await AgentFollowUpRepository.acquireStreamCapLock(db, "ws_1", "stream_1")

    expect(captured.text).toContain("pg_advisory_xact_lock")
    expect(captured.values).toEqual(["ws_1", "stream_1"])
  })
})

describe("AgentFollowUpRepository.findById", () => {
  afterEach(() => mock.restore())

  it("selects the row scoped to workspace + id and maps it (INV-8)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [ROW])

    const result = await AgentFollowUpRepository.findById(db, "ws_1", "agfu_01")

    expect(captured.text).toContain("SELECT")
    expect(captured.text).toContain("FROM agent_follow_ups")
    expect(captured.values).toEqual(["agfu_01", "ws_1"])
    expect(result).toMatchObject({ id: "agfu_01", note: "check back on the deploy", scheduledFor: SCHEDULED_FOR })
  })

  it("returns null when no row matches", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    const result = await AgentFollowUpRepository.findById(db, "ws_1", "agfu_missing")

    expect(result).toBeNull()
  })
})

describe("AgentFollowUpRepository.countPending", () => {
  afterEach(() => mock.restore())

  it("counts only pending rows for the workspace + stream (INV-8)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ count: 3 }])

    const result = await AgentFollowUpRepository.countPending(db, "ws_1", "stream_1")

    expect(result).toBe(3)
    expect(captured.values).toEqual(["ws_1", "stream_1", FollowUpStatuses.PENDING])
  })
})

describe("AgentFollowUpRepository.setQueueMessageId", () => {
  afterEach(() => mock.restore())

  it("updates queue_message_id scoped to workspace + id", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    await AgentFollowUpRepository.setQueueMessageId(db, "ws_1", "agfu_01", "agfuq_1")

    expect(captured.text).toContain("UPDATE agent_follow_ups")
    expect(captured.values).toEqual(["agfuq_1", "agfu_01", "ws_1"])
  })
})

describe("AgentFollowUpRepository stream-scoped admin reads/writes", () => {
  afterEach(() => mock.restore())

  it("markCancelledInStream scopes the CAS to workspace + stream + id", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    await AgentFollowUpRepository.markCancelledInStream(db, "ws_1", "stream_1", "agfu_01")

    expect(captured.text).toContain("stream_id =")
    expect(captured.values).toContain("stream_1")
    expect(captured.values).toContain(FollowUpStatuses.CANCELLED)
    expect(captured.values).toContain(FollowUpStatuses.PENDING)
  })

  it("listPending selects a stream's pending rows soonest-first", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [ROW])

    const result = await AgentFollowUpRepository.listPending(db, "ws_1", "stream_1")

    expect(captured.text).toContain("ORDER BY scheduled_for ASC")
    expect(captured.values).toEqual(["ws_1", "stream_1", FollowUpStatuses.PENDING])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: "agfu_01", scheduledFor: SCHEDULED_FOR })
  })

  it("updatePending CASes note + time on a pending row scoped to workspace + stream + id", async () => {
    const captured: Captured = { text: null, values: null }
    const newTime = new Date("2026-07-10T09:00:00.000Z")
    const db = createQuerier(captured, [{ ...ROW, note: "new note", scheduled_for: newTime }])

    const result = await AgentFollowUpRepository.updatePending(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      id: "agfu_01",
      note: "new note",
      scheduledFor: newTime,
    })

    expect(captured.text).toContain("UPDATE agent_follow_ups")
    expect(captured.text).toContain("stream_id =")
    // Status is unchanged, so status_changed_at is not re-stamped in SET
    // (it still appears in the RETURNING column list).
    expect(captured.text).not.toContain("status_changed_at = NOW()")
    expect(captured.values).toContain(FollowUpStatuses.PENDING)
    expect(captured.values).toContain("new note")
    expect(result).toMatchObject({ note: "new note", scheduledFor: newTime })
  })

  it("markFired guards on scheduled_for <= NOW() so a rescheduled-to-later row can't fire early", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [ROW])

    await AgentFollowUpRepository.markFired(db, "ws_1", "agfu_01")

    expect(captured.text).toContain("scheduled_for <= NOW()")
  })
})
