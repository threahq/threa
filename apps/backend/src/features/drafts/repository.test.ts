import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { DraftsRepository } from "./repository"

const NOW = new Date("2026-06-13T12:00:00.000Z")

const DRAFT_ROW = {
  id: "draft_01",
  workspace_id: "ws_1",
  user_id: "usr_1",
  scope: "stream:stream_1",
  root_stream_id: "stream_1",
  content_json: { type: "doc", content: [] },
  content_markdown: "hello",
  attachment_ids: [],
  command: null,
  context_refs: null,
  ciphertext: null,
  envelope: null,
  e2e_version: null,
  version: 1,
  last_client_write_id: "write_1",
  client_updated_at: NOW,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [DRAFT_ROW]): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rows.length } as QueryResult
    }),
  }
}

const INSERT_PARAMS = {
  id: "draft_01",
  workspaceId: "ws_1",
  userId: "usr_1",
  scope: "stream:stream_1",
  rootStreamId: "stream_1",
  contentJson: { type: "doc", content: [] },
  contentMarkdown: "hello",
  attachmentIds: [],
  command: null,
  contextRefs: null,
  ciphertext: null,
  envelope: null,
  e2eVersion: null,
  clientUpdatedAt: NOW,
  lastClientWriteId: "write_1",
}

describe("DraftsRepository.insertIfAbsent", () => {
  afterEach(() => mock.restore())

  it("inserts on a fresh id and does nothing on a PK collision", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await DraftsRepository.insertIfAbsent(db, INSERT_PARAMS)

    expect(captured.text).toContain("INSERT INTO drafts")
    expect(captured.text).toContain("ON CONFLICT (id) DO NOTHING")
    expect(captured.text).toContain("RETURNING")
    expect(captured.values).toContain("write_1")
    expect(captured.values).toContain("stream:stream_1")
  })

  it("returns null when the insert was a no-op (id already existed)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    const result = await DraftsRepository.insertIfAbsent(db, INSERT_PARAMS)

    expect(result).toBeNull()
  })
})

describe("DraftsRepository.findByIdForUpdate", () => {
  afterEach(() => mock.restore())

  it("locks the row by (id, workspace_id, user_id) and does not filter tombstones", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await DraftsRepository.findByIdForUpdate(db, "ws_1", "usr_1", "draft_01")

    expect(captured.text).toContain("WHERE id =")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("user_id =")
    expect(captured.text).toContain("FOR UPDATE")
    // Tombstones must remain visible so the service can serialize against them.
    expect(captured.text).not.toContain("deleted_at IS NULL")
  })
})

describe("DraftsRepository.casUpdate", () => {
  afterEach(() => mock.restore())

  it("gates the update on version and liveness, and bumps the version (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await DraftsRepository.casUpdate(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "draft_01",
      expectedVersion: 3,
      rootStreamId: "stream_1",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "edited",
      attachmentIds: ["att_1"],
      command: null,
      contextRefs: null,
      ciphertext: null,
      envelope: null,
      e2eVersion: null,
      clientUpdatedAt: NOW,
      lastClientWriteId: "write_2",
    })

    expect(captured.text).toContain("UPDATE drafts SET")
    expect(captured.text).toContain("version = version + 1")
    expect(captured.text).toContain("deleted_at IS NULL")
    expect(captured.text).toContain("version =")
    expect(captured.values).toContain(3)
    expect(captured.values).toContain("write_2")
  })

  it("returns null when the version no longer matches (drift)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    const result = await DraftsRepository.casUpdate(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "draft_01",
      expectedVersion: 99,
      rootStreamId: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "x",
      attachmentIds: [],
      command: null,
      contextRefs: null,
      ciphertext: null,
      envelope: null,
      e2eVersion: null,
      clientUpdatedAt: NOW,
      lastClientWriteId: "write_3",
    })

    expect(result).toBeNull()
  })
})

describe("DraftsRepository.softDeleteCas", () => {
  afterEach(() => mock.restore())

  it("tombstones only when the version matches so a drifted copy survives", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await DraftsRepository.softDeleteCas(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "draft_01",
      expectedVersion: 2,
    })

    expect(captured.text).toContain("deleted_at = NOW()")
    expect(captured.text).toContain("deleted_at IS NULL")
    expect(captured.text).toContain("version =")
    expect(captured.values).toContain(2)
  })
})

describe("DraftsRepository.softDelete", () => {
  afterEach(() => mock.restore())

  it("tombstones unconditionally (explicit discard) without a version guard", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await DraftsRepository.softDelete(db, "ws_1", "usr_1", "draft_01")

    expect(captured.text).toContain("deleted_at = NOW()")
    expect(captured.text).toContain("deleted_at IS NULL")
    expect(captured.text).not.toContain("AND version =")
  })
})

describe("DraftsRepository.listByUser", () => {
  afterEach(() => mock.restore())

  it("returns live drafts for a user, newest edit first (INV-8)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await DraftsRepository.listByUser(db, "ws_1", "usr_1")

    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("user_id =")
    expect(captured.text).toContain("deleted_at IS NULL")
    expect(captured.text).toContain("ORDER BY client_updated_at DESC")
  })
})
