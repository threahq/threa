import { describe, it, expect, beforeEach } from "vitest"
import type { SavedMessageView } from "@threa/types"
import { db } from "@/db"
import { persistSavedRows, replaceSavedPage } from "./use-saved"

const WORKSPACE_ID = "ws_test"

function makeView(overrides: Partial<SavedMessageView> & { id: string; messageId: string }): SavedMessageView {
  const now = new Date().toISOString()
  return {
    workspaceId: WORKSPACE_ID,
    userId: "usr_me",
    streamId: "stream_1",
    status: "saved",
    title: null,
    note: null,
    remindAt: null,
    reminderSentAt: null,
    savedAt: now,
    statusChangedAt: now,
    message: null,
    unavailableReason: null,
    ...overrides,
  }
}

describe("replaceSavedPage", () => {
  beforeEach(async () => {
    await db.savedMessages.clear()
  })

  it("deletes cached rows that are missing from the server response", async () => {
    const fetchStartedAt = Date.now()
    // Seed a row that was cached before the fetch started (i.e. the server's
    // view of it should win).
    await db.savedMessages.put({
      id: "saved_stale",
      workspaceId: WORKSPACE_ID,
      userId: "usr_me",
      messageId: "msg_stale",
      streamId: "stream_1",
      status: "saved",
      title: null,
      note: null,
      remindAt: null,
      reminderSentAt: null,
      savedAt: new Date().toISOString(),
      statusChangedAt: new Date().toISOString(),
      message: null,
      unavailableReason: null,
      _savedAtMs: Date.now() - 60_000,
      _statusChangedAtMs: Date.now() - 60_000,
      _reminderFiredAtMs: 0,
      _cachedAt: fetchStartedAt - 1_000,
    })

    await replaceSavedPage(WORKSPACE_ID, "saved", [], fetchStartedAt, false)

    const remaining = await db.savedMessages.toArray()
    expect(remaining).toEqual([])
  })

  it("preserves rows written after fetchStartedAt (concurrent socket writes)", async () => {
    const fetchStartedAt = Date.now()
    // Simulate a socket write that lands while the list fetch is in flight.
    await db.savedMessages.put({
      id: "saved_concurrent",
      workspaceId: WORKSPACE_ID,
      userId: "usr_me",
      messageId: "msg_concurrent",
      streamId: "stream_1",
      status: "saved",
      title: null,
      note: null,
      remindAt: null,
      reminderSentAt: null,
      savedAt: new Date().toISOString(),
      statusChangedAt: new Date().toISOString(),
      message: null,
      unavailableReason: null,
      _savedAtMs: Date.now(),
      _statusChangedAtMs: Date.now(),
      _reminderFiredAtMs: 0,
      _cachedAt: fetchStartedAt + 10,
    })

    await replaceSavedPage(WORKSPACE_ID, "saved", [], fetchStartedAt, false)

    const remaining = await db.savedMessages.toArray()
    expect(remaining.map((r) => r.id)).toEqual(["saved_concurrent"])
  })

  it("bulkPuts the server response and deletes stale rows in one pass", async () => {
    const fetchStartedAt = Date.now()
    // Stale row the server no longer knows about.
    await db.savedMessages.put({
      id: "saved_stale",
      workspaceId: WORKSPACE_ID,
      userId: "usr_me",
      messageId: "msg_stale",
      streamId: "stream_1",
      status: "saved",
      title: null,
      note: null,
      remindAt: null,
      reminderSentAt: null,
      savedAt: new Date().toISOString(),
      statusChangedAt: new Date().toISOString(),
      message: null,
      unavailableReason: null,
      _savedAtMs: Date.now(),
      _statusChangedAtMs: Date.now(),
      _reminderFiredAtMs: 0,
      _cachedAt: fetchStartedAt - 1_000,
    })

    await replaceSavedPage(
      WORKSPACE_ID,
      "saved",
      [makeView({ id: "saved_fresh", messageId: "msg_fresh" })],
      fetchStartedAt,
      false
    )

    const remaining = await db.savedMessages.toArray()
    expect(remaining.map((r) => r.id)).toEqual(["saved_fresh"])
  })

  it("leaves rows in other statuses alone", async () => {
    const fetchStartedAt = Date.now()
    // A "done" row must survive reconciliation of the "saved" tab.
    await db.savedMessages.put({
      id: "saved_done",
      workspaceId: WORKSPACE_ID,
      userId: "usr_me",
      messageId: "msg_done",
      streamId: "stream_1",
      status: "done",
      title: null,
      note: null,
      remindAt: null,
      reminderSentAt: null,
      savedAt: new Date().toISOString(),
      statusChangedAt: new Date().toISOString(),
      message: null,
      unavailableReason: null,
      _savedAtMs: Date.now(),
      _statusChangedAtMs: Date.now(),
      _reminderFiredAtMs: 0,
      _cachedAt: fetchStartedAt - 1_000,
    })

    await replaceSavedPage(WORKSPACE_ID, "saved", [], fetchStartedAt, false)

    const remaining = await db.savedMessages.toArray()
    expect(remaining.map((r) => r.id)).toEqual(["saved_done"])
  })

  it("skips deletion entirely when the server has more pages (hasMore=true)", async () => {
    const fetchStartedAt = Date.now()
    // A row already cached from a previous page-2 fetch — must survive even
    // though it's absent from the page-1 response.
    await db.savedMessages.put({
      id: "saved_page2",
      workspaceId: WORKSPACE_ID,
      userId: "usr_me",
      messageId: "msg_page2",
      streamId: "stream_1",
      status: "saved",
      title: null,
      note: null,
      remindAt: null,
      reminderSentAt: null,
      savedAt: new Date().toISOString(),
      statusChangedAt: new Date().toISOString(),
      message: null,
      unavailableReason: null,
      _savedAtMs: Date.now() - 120_000,
      _statusChangedAtMs: Date.now() - 120_000,
      _reminderFiredAtMs: 0,
      _cachedAt: fetchStartedAt - 1_000,
    })

    await replaceSavedPage(
      WORKSPACE_ID,
      "saved",
      [makeView({ id: "saved_page1", messageId: "msg_page1" })],
      fetchStartedAt,
      true
    )

    const remaining = await db.savedMessages.toArray()
    expect(remaining.map((r) => r.id).sort()).toEqual(["saved_page1", "saved_page2"])
  })
})

describe("persistSavedRows -> _reminderFiredAtMs", () => {
  beforeEach(async () => {
    await db.savedMessages.clear()
  })

  it("derives the index field from reminderSentAt", async () => {
    const firedAt = "2026-04-17T09:00:00.000Z"
    await persistSavedRows(WORKSPACE_ID, [
      makeView({ id: "saved_pending", messageId: "msg_pending", remindAt: "2030-01-01T00:00:00.000Z" }),
      makeView({
        id: "saved_fired",
        messageId: "msg_fired",
        remindAt: firedAt,
        reminderSentAt: firedAt,
      }),
    ])

    const rows = await db.savedMessages.toArray()
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get("saved_pending")?._reminderFiredAtMs).toBe(0)
    expect(byId.get("saved_fired")?._reminderFiredAtMs).toBe(Date.parse(firedAt))
  })

  it("index-backed count returns only rows with fired reminders", async () => {
    const firedAt = "2026-04-17T09:00:00.000Z"
    await persistSavedRows(WORKSPACE_ID, [
      makeView({ id: "saved_a", messageId: "msg_a" }),
      makeView({ id: "saved_b", messageId: "msg_b", remindAt: "2030-01-01T00:00:00.000Z" }),
      makeView({
        id: "saved_c",
        messageId: "msg_c",
        remindAt: firedAt,
        reminderSentAt: firedAt,
      }),
    ])

    const count = await db.savedMessages
      .where("[workspaceId+status+_reminderFiredAtMs]")
      .between([WORKSPACE_ID, "saved", 1], [WORKSPACE_ID, "saved", Infinity], true, true)
      .count()

    expect(count).toBe(1)
  })
})
