import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { ScheduledMessagesRepository } from "./repository"
import { ScheduledMessageStatuses } from "@threahq/types"

const NOW = new Date("2026-05-03T12:00:00.000Z")
const SCHEDULED_FOR = new Date("2026-05-03T13:00:00.000Z")

const SCHEDULED_ROW = {
  id: "sched_01",
  workspace_id: "ws_1",
  user_id: "usr_1",
  stream_id: "stream_1",
  parent_anchor_id: null,
  content_json: { type: "doc", content: [] },
  content_markdown: "hello",
  attachment_ids: [],
  metadata: null,
  conversation_directive: null,
  scheduled_for: SCHEDULED_FOR,
  status: ScheduledMessageStatuses.PENDING,
  sent_message_id: null,
  last_error: null,
  queue_message_id: null,
  edit_active_until: null,
  client_message_id: null,
  retry_count: 0,
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  status_changed_at: NOW,
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [SCHEDULED_ROW], rowCount?: number): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rowCount ?? rows.length } as QueryResult
    }),
  }
}

describe("ScheduledMessagesRepository.insert", () => {
  afterEach(() => mock.restore())

  it("inserts a pending scheduled message and stores client_message_id when present", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.insert(db, {
      id: "sched_01",
      workspaceId: "ws_1",
      userId: "usr_1",
      streamId: "stream_1",
      parentMessageId: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "hello",
      attachmentIds: [],
      metadata: null,
      conversationDirective: null,
      scheduledFor: SCHEDULED_FOR,
      clientMessageId: "cli_1",
    })

    expect(captured.text).toContain("INSERT INTO scheduled_messages")
    expect(captured.text).toContain("conversation_directive")
    expect(captured.text).toContain("RETURNING")
    expect(captured.values).toContain("cli_1")
  })

  it("serializes the conversation directive into the row when armed for 'Reply in conversation'", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.insert(db, {
      id: "sched_02",
      workspaceId: "ws_1",
      userId: "usr_1",
      streamId: "stream_1",
      parentMessageId: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "hello",
      attachmentIds: [],
      metadata: null,
      conversationDirective: { intent: "existing", conversationId: "conv_7" },
      scheduledFor: SCHEDULED_FOR,
      clientMessageId: null,
    })

    expect(captured.values).toContain(JSON.stringify({ intent: "existing", conversationId: "conv_7" }))
  })
})

describe("ScheduledMessagesRepository.findById", () => {
  afterEach(() => mock.restore())

  it("filters by id, workspace_id, and user_id (INV-8)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.findById(db, "ws_1", "usr_1", "sched_01")

    expect(captured.text).toContain("WHERE id =")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("user_id =")
  })
})

describe("ScheduledMessagesRepository.findByIdScoped (worker entry)", () => {
  afterEach(() => mock.restore())

  it("filters by id and workspace_id even when looking up the primary key (INV-8)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.findByIdScoped(db, "ws_1", "sched_01")

    expect(captured.text).toContain("WHERE id =")
    expect(captured.text).toContain("workspace_id =")
  })
})

describe("ScheduledMessagesRepository.listByUser cursor pagination", () => {
  afterEach(() => mock.restore())

  it("uses tuple comparison and a secondary id sort so timestamp-tied rows aren't skipped", async () => {
    // Without (timestamp, id) tuple comparison + secondary order key, page 2
    // would skip every sibling sharing scheduled_for with the cursor anchor.
    // CodeRabbit caught this: the cursor anchor row's siblings would silently
    // disappear on the next page.
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.listByUser(db, "ws_1", "usr_1", {
      status: ScheduledMessageStatuses.PENDING,
      cursor: "sched_anchor",
    })

    expect(captured.text).toContain("(scheduled_for, id) >")
    expect(captured.text).toContain("ORDER BY scheduled_for ASC, id ASC")
  })

  it("orders sent rows by (status_changed_at, id) DESC tuple", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.listByUser(db, "ws_1", "usr_1", {
      status: ScheduledMessageStatuses.SENT,
      cursor: "sched_anchor",
    })

    expect(captured.text).toContain("(status_changed_at, id) <")
    expect(captured.text).toContain("ORDER BY status_changed_at DESC, id DESC")
  })
})

describe("ScheduledMessagesRepository.bumpEditFence", () => {
  afterEach(() => mock.restore())

  it("bumps edit_active_until via GREATEST so concurrent editors can't race the fence backwards", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.bumpEditFence(db, {
      workspaceId: "ws_1",
      id: "sched_01",
      ttlSeconds: 60,
    })

    expect(captured.text).toContain("UPDATE scheduled_messages")
    expect(captured.text).toContain("edit_active_until = GREATEST")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("status =")
  })

  it("does NOT bump version or updated_at (fence is metadata; bumping either invalidates the editor's expectedVersion)", async () => {
    // The fence is "is anyone editing right now?" — pure metadata. If the
    // bump touched `version`, every concurrent device's open dialog would
    // see its `expectedVersion` invalidated and the next save would 409
    // STALE_VERSION even though no content changed. Same hazard for
    // `updated_at` if anything client-side ever read it as a version.
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.bumpEditFence(db, {
      workspaceId: "ws_1",
      id: "sched_01",
      ttlSeconds: 60,
    })

    expect(captured.text).not.toContain("updated_at = NOW()")
    expect(captured.text).not.toContain("version = version + 1")
  })

  it("only bumps pending rows so a sending/sent/cancelled row doesn't accidentally hide from the worker", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.bumpEditFence(db, {
      workspaceId: "ws_1",
      id: "sched_01",
      ttlSeconds: 60,
    })

    expect(captured.values).toContain(ScheduledMessageStatuses.PENDING)
  })
})

describe("ScheduledMessagesRepository.tryStartSend (worker CAS)", () => {
  afterEach(() => mock.restore())

  it("flips status to sending only when pending, due now, and no editor session active", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.tryStartSend(db, {
      workspaceId: "ws_1",
      id: "sched_01",
      ttlSeconds: 10,
    })

    expect(captured.text).toContain("UPDATE scheduled_messages")
    expect(captured.text).toContain("status =")
    expect(captured.text).toContain("scheduled_for <= NOW()")
    expect(captured.text).toContain("edit_active_until IS NULL")
    expect(captured.text).toContain("edit_active_until <= NOW()")
    expect(captured.values).toContain(ScheduledMessageStatuses.SENDING)
  })

  it("bypasses the fence check when bypassFence=true so a user-initiated save/sendNow isn't blocked by their own dialog lock", async () => {
    // The deadlock this prevents: user opens edit dialog (lockForEdit
    // sets the fence for 10 min), wire time passes, user hits Save with
    // past `scheduled_for` → past-time save path calls tryStartSend,
    // which would normally see edit_active_until in the future and
    // refuse — leaving the row stuck in pending while the worker also
    // defers because of the same fence. The fence's job is to keep the
    // *worker* out while the *user* is editing; user-initiated writes
    // bypass it.
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.tryStartSend(db, {
      workspaceId: "ws_1",
      id: "sched_01",
      ttlSeconds: 10,
      bypassFence: true,
    })

    expect(captured.values).toContain(true)
  })

  it("drops the scheduled_for guard when force=true so Send Now fires a still-future row regardless of clock skew", async () => {
    // Send Now must not depend on scheduled_for <= NOW(): the row is
    // future-scheduled and the user asked to send it now. `force` short-
    // circuits the schedule check in SQL (the OR branch) rather than the
    // service rewriting scheduled_for to a JS `new Date()` and racing DB
    // clock skew.
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.tryStartSend(db, {
      workspaceId: "ws_1",
      id: "sched_01",
      ttlSeconds: 10,
      force: true,
    })

    // The guard survives only as an OR branch behind the force flag.
    expect(captured.text).toContain("OR scheduled_for <= NOW()")
    // force=true is passed (bypassFence defaults false), so a `true` appears.
    expect(captured.values).toContain(true)
  })
})

describe("ScheduledMessagesRepository.releaseEditFence", () => {
  afterEach(() => mock.restore())

  it("clears edit_active_until on dialog close so the worker isn't stranded behind a 10-minute lock", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.releaseEditFence(db, "ws_1", "sched_01")

    expect(captured.text).toContain("UPDATE scheduled_messages")
    expect(captured.text).toContain("edit_active_until = NULL")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("status =")
    // No version bump — the fence is metadata. Bumping it would
    // invalidate any concurrent device's expectedVersion.
    expect(captured.text).not.toContain("version = version + 1")
  })
})

describe("ScheduledMessagesRepository.update", () => {
  afterEach(() => mock.restore())

  it("CASes on version = expectedVersion and increments version atomically so concurrent saves don't trample each other (first write wins)", async () => {
    // Why an integer version and not updated_at: PG TIMESTAMPTZ stores
    // microseconds (.789456) but pg-node truncates to JS Date ms (.789), so
    // the wire/IDB never see the same value the column holds. A timestamp-
    // based CAS would 409 the very first save every time (no race for the
    // user to point at). An integer version round-trips losslessly through
    // every layer.
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.update(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "sched_01",
      expectedVersion: 7,
      contentMarkdown: "updated",
    })

    expect(captured.text).toContain("UPDATE scheduled_messages")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("user_id =")
    expect(captured.text).toContain("status =")
    expect(captured.text).toContain("AND version =")
    expect(captured.text).toContain("version = version + 1")
    expect(captured.values).toContain(7)
  })
})

describe("ScheduledMessagesRepository.markSent", () => {
  afterEach(() => mock.restore())

  it("transitions sending → sent atomically and clears the fence", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.markSent(db, {
      workspaceId: "ws_1",
      id: "sched_01",
      sentMessageId: "msg_42",
    })

    expect(captured.text).toContain("UPDATE scheduled_messages")
    expect(captured.text).toContain("sent_message_id =")
    expect(captured.text).toContain("edit_active_until = NULL")
    expect(captured.text).toContain("workspace_id =")
    // The status guard on the WHERE clause makes the transition idempotent —
    // a second call to markSent for an already-sent row no-ops.
    expect(captured.text).toContain("AND status =")
  })
})

describe("ScheduledMessagesRepository.cancel", () => {
  afterEach(() => mock.restore())

  it("only cancels rows in pending status (worker can still finish a row that won the CAS)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.cancel(db, "ws_1", "usr_1", "sched_01")

    expect(captured.text).toContain("UPDATE scheduled_messages")
    expect(captured.text).toContain("status =")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("user_id =")
    expect(captured.values).toContain(ScheduledMessageStatuses.CANCELLED)
    expect(captured.values).toContain(ScheduledMessageStatuses.PENDING)
  })
})

describe("ScheduledMessagesRepository.listByUser", () => {
  afterEach(() => mock.restore())

  it("orders pending rows by scheduled_for ASC (worker queue + To send tab share this index)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.listByUser(db, "ws_1", "usr_1", {
      status: ScheduledMessageStatuses.PENDING,
    })

    expect(captured.text).toContain("ORDER BY scheduled_for ASC")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("user_id =")
  })

  it("orders sent/failed/cancelled by status_changed_at DESC", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.listByUser(db, "ws_1", "usr_1", {
      status: ScheduledMessageStatuses.SENT,
    })

    expect(captured.text).toContain("ORDER BY status_changed_at DESC")
  })

  it("filters cursor lookups by workspace_id+user_id so a forged cursor can't read across workspaces", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await ScheduledMessagesRepository.listByUser(db, "ws_1", "usr_1", {
      status: ScheduledMessageStatuses.PENDING,
      cursor: "sched_other",
    })

    // The subquery resolving the cursor anchor must include workspace_id
    // AND user_id so a forged cursor id doesn't leak data across tenancy
    // boundaries (INV-8).
    expect(captured.text).toContain("WHERE id =")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("user_id =")
  })
})
