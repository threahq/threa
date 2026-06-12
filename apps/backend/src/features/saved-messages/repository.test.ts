import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { SavedMessagesRepository } from "./repository"
import { SavedStatuses } from "@threa/types"

const NOW = new Date("2026-04-16T12:00:00.000Z")

const SAVED_ROW = {
  id: "saved_01",
  workspace_id: "ws_1",
  user_id: "usr_1",
  message_id: "msg_1",
  stream_id: "stream_1",
  status: SavedStatuses.SAVED,
  title: null,
  note: null,
  remind_at: null,
  reminder_sent_at: null,
  reminder_queue_message_id: null,
  saved_at: NOW,
  status_changed_at: NOW,
  created_at: NOW,
  updated_at: NOW,
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [SAVED_ROW], rowCount?: number): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return {
        rows,
        rowCount: rowCount ?? rows.length,
      } as QueryResult
    }),
  }
}

describe("SavedMessagesRepository.upsert", () => {
  afterEach(() => mock.restore())

  it("issues an INSERT ... ON CONFLICT race-safe upsert keyed on (workspace, user, message)", async () => {
    const captured: Captured = { text: null, values: null }
    const row = { ...SAVED_ROW, inserted: true, previous_reminder_queue_message_id: null }
    const db = createQuerier(captured, [row])

    await SavedMessagesRepository.upsert(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      messageId: "msg_1",
      streamId: "stream_1",
      remindAt: null,
    })

    expect(captured.text).toContain("INSERT INTO saved_messages")
    // The unique index is partial (standalone rows have NULL message_id), so
    // the conflict target must repeat the index predicate for Postgres to
    // match it.
    expect(captured.text).toContain(
      "ON CONFLICT (workspace_id, user_id, message_id) WHERE message_id IS NOT NULL DO UPDATE"
    )
    expect(captured.text).toContain("status = $")
    expect(captured.text).toContain("reminder_sent_at = NULL")
    expect(captured.text).toContain("reminder_queue_message_id = NULL")
    // bumps saved_at and status_changed_at only on status transition away from 'saved'
    expect(captured.text).toContain("CASE")
    expect(captured.text).toContain("(xmax = 0) AS inserted")
  })

  it("captures the previous queue message id in a CTE so RETURNING sees the pre-update value", async () => {
    // RETURNING on INSERT ... ON CONFLICT DO UPDATE reads post-update values,
    // but the UPDATE clause nulls `reminder_queue_message_id`. The CTE snapshots
    // the old value before the conflict path runs.
    const captured: Captured = { text: null, values: null }
    const row = { ...SAVED_ROW, inserted: false, previous_reminder_queue_message_id: "remq_old" }
    const db = createQuerier(captured, [row])

    await SavedMessagesRepository.upsert(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      messageId: "msg_1",
      streamId: "stream_1",
      remindAt: null,
    })

    expect(captured.text).toContain("WITH old AS (")
    expect(captured.text).toContain("SELECT reminder_queue_message_id")
    expect(captured.text).toContain("(SELECT reminder_queue_message_id FROM old) AS previous_reminder_queue_message_id")
    // And the CTE must run BEFORE the INSERT so we see the pre-update row.
    const cteIdx = captured.text!.indexOf("WITH old")
    const insertIdx = captured.text!.indexOf("INSERT INTO saved_messages")
    expect(cteIdx).toBeGreaterThanOrEqual(0)
    expect(cteIdx).toBeLessThan(insertIdx)
  })

  it("returns inserted=true on first insert with no previous queue message id", async () => {
    const row = { ...SAVED_ROW, inserted: true, previous_reminder_queue_message_id: null }
    const db = createQuerier({ text: null, values: null }, [row])

    const result = await SavedMessagesRepository.upsert(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      messageId: "msg_1",
      streamId: "stream_1",
      remindAt: null,
    })

    expect(result.inserted).toBe(true)
    expect(result.previousReminderQueueMessageId).toBeNull()
    expect(result.saved.status).toBe(SavedStatuses.SAVED)
  })

  it("returns inserted=false and surfaces previous queue id on conflict update", async () => {
    const row = {
      ...SAVED_ROW,
      inserted: false,
      previous_reminder_queue_message_id: "remq_old",
    }
    const db = createQuerier({ text: null, values: null }, [row])

    const result = await SavedMessagesRepository.upsert(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      messageId: "msg_1",
      streamId: "stream_1",
      remindAt: new Date("2026-04-16T13:00:00.000Z"),
    })

    expect(result.inserted).toBe(false)
    expect(result.previousReminderQueueMessageId).toBe("remq_old")
  })

  it("always resets status to 'saved' and clears reminder_sent_at on conflict (resave from done/archived)", async () => {
    const captured: Captured = { text: null, values: null }
    const row = { ...SAVED_ROW, inserted: false, previous_reminder_queue_message_id: null }
    const db = createQuerier(captured, [row])

    await SavedMessagesRepository.upsert(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      messageId: "msg_1",
      streamId: "stream_1",
      remindAt: null,
    })

    const update = captured.text!.slice(captured.text!.indexOf("DO UPDATE"))
    expect(update).toContain("reminder_sent_at = NULL")
    expect(update).toContain("reminder_queue_message_id = NULL")
    expect(captured.values).toContain(SavedStatuses.SAVED)
  })
})

describe("SavedMessagesRepository.insertStandalone", () => {
  afterEach(() => mock.restore())

  it("inserts a message-less row with title/note and no conflict clause", async () => {
    const captured: Captured = { text: null, values: null }
    const row = { ...SAVED_ROW, message_id: null, stream_id: null, title: "Call the landlord", note: "About the lease" }
    const db = createQuerier(captured, [row])

    const result = await SavedMessagesRepository.insertStandalone(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      title: "Call the landlord",
      note: "About the lease",
      remindAt: null,
    })

    expect(captured.text).toContain("INSERT INTO saved_messages")
    expect(captured.text).not.toContain("ON CONFLICT")
    expect(captured.values).toContain("Call the landlord")
    expect(result).toMatchObject({
      messageId: null,
      streamId: null,
      title: "Call the landlord",
      note: "About the lease",
      status: SavedStatuses.SAVED,
    })
  })
})

describe("SavedMessagesRepository.updateContent", () => {
  afterEach(() => mock.restore())

  it("updates only provided fields in a single owner-scoped UPDATE", async () => {
    const captured: Captured = { text: null, values: null }
    const row = { ...SAVED_ROW, note: "remember why" }
    const db = createQuerier(captured, [row])

    const result = await SavedMessagesRepository.updateContent(db, "ws_1", "usr_1", "saved_01", {
      note: "remember why",
    })

    expect(captured.text).toContain("UPDATE saved_messages")
    expect(captured.text).toContain("WHERE id = $")
    expect(captured.text).toContain("AND workspace_id = $")
    expect(captured.text).toContain("AND user_id = $")
    // Undefined title must leave the column untouched (CASE guard, not blind SET)
    expect(captured.values).toContain(false)
    expect(result?.note).toBe("remember why")
  })

  it("returns null when the row does not exist", async () => {
    const db = createQuerier({ text: null, values: null }, [], 0)
    const result = await SavedMessagesRepository.updateContent(db, "ws_1", "usr_1", "saved_missing", { note: "x" })
    expect(result).toBeNull()
  })
})

describe("SavedMessagesRepository.listByUser", () => {
  afterEach(() => mock.restore())

  it("orders the Saved tab by saved_at DESC", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    await SavedMessagesRepository.listByUser(db, "ws_1", "usr_1", { status: SavedStatuses.SAVED })

    expect(captured.text).toContain("ORDER BY saved_at DESC")
    expect(captured.text).not.toContain("ORDER BY status_changed_at")
  })

  it("orders the Done tab by status_changed_at DESC", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    await SavedMessagesRepository.listByUser(db, "ws_1", "usr_1", { status: SavedStatuses.DONE })

    expect(captured.text).toContain("ORDER BY status_changed_at DESC")
  })

  it("orders the Archived tab by status_changed_at DESC", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    await SavedMessagesRepository.listByUser(db, "ws_1", "usr_1", { status: SavedStatuses.ARCHIVED })

    expect(captured.text).toContain("ORDER BY status_changed_at DESC")
  })

  it("applies cursor keyset when provided", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    await SavedMessagesRepository.listByUser(db, "ws_1", "usr_1", {
      status: SavedStatuses.SAVED,
      cursor: "saved_prev",
    })

    expect(captured.text).toContain("saved_at < (")
    expect(captured.values).toContain("saved_prev")
  })
})

describe("SavedMessagesRepository.updateStatus", () => {
  afterEach(() => mock.restore())

  it("bumps status_changed_at only when status actually changes", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [SAVED_ROW])

    await SavedMessagesRepository.updateStatus(db, "ws_1", "usr_1", "saved_01", SavedStatuses.DONE)

    expect(captured.text).toContain("UPDATE saved_messages")
    expect(captured.text).toContain("status = $")
    expect(captured.text).toContain("CASE")
    expect(captured.text).toContain("WHEN status <> $")
  })

  it("scopes the UPDATE to the owner (workspace + user)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [SAVED_ROW])

    await SavedMessagesRepository.updateStatus(db, "ws_1", "usr_1", "saved_01", SavedStatuses.ARCHIVED)

    expect(captured.text).toContain("WHERE id = $")
    expect(captured.text).toContain("AND workspace_id = $")
    expect(captured.text).toContain("AND user_id = $")
  })

  it("returns null when the row does not exist", async () => {
    const db = createQuerier({ text: null, values: null }, [], 0)
    const result = await SavedMessagesRepository.updateStatus(db, "ws_1", "usr_1", "saved_missing", SavedStatuses.DONE)
    expect(result).toBeNull()
  })
})

describe("SavedMessagesRepository.updateReminder", () => {
  afterEach(() => mock.restore())

  it("sets remind_at, queue pointer, and clears reminder_sent_at", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [SAVED_ROW])

    await SavedMessagesRepository.updateReminder(db, "ws_1", "usr_1", "saved_01", {
      remindAt: new Date("2026-04-16T13:00:00.000Z"),
      queueMessageId: "remq_new",
    })

    expect(captured.text).toContain("remind_at = $")
    expect(captured.text).toContain("reminder_queue_message_id = $")
    expect(captured.text).toContain("reminder_sent_at = NULL")
    expect(captured.values).toContain("remq_new")
  })
})

describe("SavedMessagesRepository.markReminderSent", () => {
  afterEach(() => mock.restore())

  it("is idempotent via `reminder_sent_at IS NULL` guard and saved-status predicate", async () => {
    const captured: Captured = { text: null, values: null }
    const sentRow = { ...SAVED_ROW, reminder_sent_at: NOW }
    const db = createQuerier(captured, [sentRow], 1)

    const result = await SavedMessagesRepository.markReminderSent(db, "saved_01", NOW)

    expect(result).not.toBeNull()
    expect(result?.reminderSentAt).toEqual(NOW)
    expect(captured.text).toContain("WHERE id = $")
    expect(captured.text).toContain("AND reminder_sent_at IS NULL")
    expect(captured.text).toContain("AND status = $")
    expect(captured.text).toContain("RETURNING")
    expect(captured.values).toContain(SavedStatuses.SAVED)
  })

  it("returns null when the row was already sent or not in saved status", async () => {
    const db = createQuerier({ text: null, values: null }, [], 0)
    const result = await SavedMessagesRepository.markReminderSent(db, "saved_01", NOW)
    expect(result).toBeNull()
  })
})

describe("SavedMessagesRepository.findById", () => {
  afterEach(() => mock.restore())

  it("scopes the SELECT to (id, workspace, user)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [SAVED_ROW])

    const result = await SavedMessagesRepository.findById(db, "ws_1", "usr_1", "saved_01")

    expect(captured.text).toContain("WHERE id = $")
    expect(captured.text).toContain("AND workspace_id = $")
    expect(captured.text).toContain("AND user_id = $")
    expect(result?.id).toBe("saved_01")
  })

  it("returns null when no row matches", async () => {
    const db = createQuerier({ text: null, values: null }, [], 0)
    const result = await SavedMessagesRepository.findById(db, "ws_1", "usr_1", "saved_missing")
    expect(result).toBeNull()
  })
})

describe("SavedMessagesRepository.findByIdUnscoped", () => {
  afterEach(() => mock.restore())

  it("looks up by id only (worker path) without workspace/user filter", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [SAVED_ROW])

    await SavedMessagesRepository.findByIdUnscoped(db, "saved_01")

    expect(captured.text).toContain("WHERE id = $")
    expect(captured.text).not.toContain("workspace_id = $")
    expect(captured.text).not.toContain("user_id = $")
  })
})

describe("SavedMessagesRepository.findByMessageId", () => {
  afterEach(() => mock.restore())

  it("scopes by workspace + user + single message id", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [SAVED_ROW])

    const result = await SavedMessagesRepository.findByMessageId(db, "ws_1", "usr_1", "msg_1")

    expect(captured.text).toContain("workspace_id = $")
    expect(captured.text).toContain("user_id = $")
    expect(captured.text).toContain("message_id = $")
    expect(result?.messageId).toBe("msg_1")
  })
})

describe("SavedMessagesRepository.findByMessageIds", () => {
  afterEach(() => mock.restore())

  it("returns [] for an empty id list without querying", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])
    const result = await SavedMessagesRepository.findByMessageIds(db, "ws_1", "usr_1", [])
    expect(result).toEqual([])
    expect(captured.text).toBeNull()
  })

  it("filters by workspace, user, and batch message ids", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [SAVED_ROW])

    const result = await SavedMessagesRepository.findByMessageIds(db, "ws_1", "usr_1", ["msg_1", "msg_2"])

    expect(captured.text).toContain("WHERE workspace_id = $")
    expect(captured.text).toContain("AND user_id = $")
    expect(captured.text).toContain("AND message_id = ANY(")
    expect(result).toHaveLength(1)
    expect(result[0]!.messageId).toBe("msg_1")
  })
})

describe("SavedMessagesRepository.delete", () => {
  afterEach(() => mock.restore())

  it("scopes to the owner and returns true when a row was deleted", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 1)

    const deleted = await SavedMessagesRepository.delete(db, "ws_1", "usr_1", "saved_01")

    expect(deleted).toBe(true)
    expect(captured.text).toContain("DELETE FROM saved_messages")
    expect(captured.text).toContain("AND workspace_id = $")
    expect(captured.text).toContain("AND user_id = $")
  })

  it("returns false when no row was deleted", async () => {
    const db = createQuerier({ text: null, values: null }, [], 0)
    const deleted = await SavedMessagesRepository.delete(db, "ws_1", "usr_1", "saved_missing")
    expect(deleted).toBe(false)
  })
})
