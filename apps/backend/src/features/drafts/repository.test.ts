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
  superseded_write_ids: null,
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

  it("gates the update on version-or-own-lineage and liveness, and bumps the version (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await DraftsRepository.casUpdate(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "draft_01",
      expectedVersion: 3,
      ownWriteIds: ["write_2", "write_prior"],
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
    // Lost-ack escape hatch: a row last written by this device's own lineage
    // updates in place even when expectedVersion trails.
    expect(captured.text).toContain("last_client_write_id = ANY")
    expect(captured.values).toContain(3)
    expect(captured.values).toContain("write_2")
    expect(captured.values).toContainEqual(["write_2", "write_prior"])
  })

  it("returns null when the version no longer matches and the lineage is foreign (drift)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    const result = await DraftsRepository.casUpdate(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "draft_01",
      expectedVersion: 99,
      ownWriteIds: ["write_3"],
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

  it("tombstones on a matching version or superseded write id so unrelated drift survives", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await DraftsRepository.softDeleteCas(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "draft_01",
      expectedVersion: 2,
      supersededWriteIds: ["write_sent"],
    })

    expect(captured.text).toContain("deleted_at = NOW()")
    expect(captured.text).toContain("deleted_at IS NULL")
    expect(captured.text).toContain("version =")
    expect(captured.text).toContain("last_client_write_id = ANY")
    // The superseded ids are persisted on the tombstone so a write from that
    // lineage landing AFTER the resolve is dropped instead of zombie-split.
    expect(captured.text).toContain("superseded_write_ids =")
    expect(captured.values).toContain(2)
    expect(captured.values).toContainEqual(["write_sent"])
    expect(captured.values).toContain(JSON.stringify(["write_sent"]))
  })
})

describe("DraftsRepository.softDelete", () => {
  afterEach(() => mock.restore())

  it("plants a negative tombstone so a delete that wins the race against first insert still sticks", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await DraftsRepository.softDelete(db, "ws_1", "usr_1", "draft_01")

    expect(captured.text).toContain("INSERT INTO drafts")
    expect(captured.text).toContain("ON CONFLICT (id) DO UPDATE")
    expect(captured.text).toContain("deleted_at = NOW()")
    expect(captured.text).toContain("deleted_at IS NULL")
    expect(captured.text).not.toContain("AND version =")
    expect(captured.values).toContain("draft_01")
    expect(captured.values).toContain("ws_1")
    expect(captured.values).toContain("usr_1")
  })

  it("persists the discarding device's superseded write ids on the tombstone", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await DraftsRepository.softDelete(db, "ws_1", "usr_1", "draft_01", ["write_inflight"])

    expect(captured.text).toContain("superseded_write_ids")
    expect(captured.values).toContain(JSON.stringify(["write_inflight"]))
  })
})

describe("DraftsRepository.mergeTombstoneSupersededWriteIds", () => {
  afterEach(() => mock.restore())

  it("locks the tombstone, merges + dedupes the lineage, and writes the union", async () => {
    const queries: Captured[] = []
    const db: Querier = {
      query: mock(async (q) => {
        const config = q as QueryConfig
        queries.push({ text: config.text ?? null, values: config.values ?? [] })
        // First query is the FOR UPDATE read; second is the UPDATE.
        if (queries.length === 1) {
          return { rows: [{ superseded_write_ids: ["write_a"] }], rowCount: 1 } as QueryResult
        }
        return { rows: [], rowCount: 1 } as unknown as QueryResult
      }),
    }

    await DraftsRepository.mergeTombstoneSupersededWriteIds(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "draft_01",
      supersededWriteIds: ["write_b", "write_a"],
    })

    expect(queries[0]?.text).toContain("FOR UPDATE")
    expect(queries[0]?.text).toContain("deleted_at IS NOT NULL")
    expect(queries[1]?.text).toContain("UPDATE drafts SET superseded_write_ids")
    expect(queries[1]?.values).toContain(JSON.stringify(["write_a", "write_b"]))
  })

  it("no-ops on a live or absent row, and when there is nothing to merge", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    await DraftsRepository.mergeTombstoneSupersededWriteIds(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "draft_01",
      supersededWriteIds: [],
    })
    // Empty input never touches the database.
    expect(captured.text).toBeNull()

    await DraftsRepository.mergeTombstoneSupersededWriteIds(db, {
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "draft_01",
      supersededWriteIds: ["write_x"],
    })
    // Live/absent row: the FOR UPDATE read finds nothing and no UPDATE runs.
    expect(captured.text).toContain("FOR UPDATE")
  })
})

describe("DraftsRepository.rescopeByScope", () => {
  afterEach(() => mock.restore())

  it("re-scopes every owner's draft for a scope (no user filter) and bumps the version", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [
      { ...DRAFT_ROW, id: "draft_01", user_id: "usr_1", scope: "stream:thread_1", root_stream_id: "stream_root" },
      { ...DRAFT_ROW, id: "draft_02", user_id: "usr_2", scope: "stream:thread_1", root_stream_id: "stream_root" },
    ])

    const rows = await DraftsRepository.rescopeByScope(db, {
      workspaceId: "ws_1",
      fromScope: "thread:msg_1",
      toScope: "stream:thread_1",
      rootStreamId: "stream_root",
    })

    expect(captured.text).toContain("UPDATE drafts SET")
    expect(captured.text).toContain("scope =")
    expect(captured.text).toContain("root_stream_id =")
    expect(captured.text).toContain("version = version + 1")
    expect(captured.text).toContain("deleted_at IS NULL")
    // Multi-user: matches by workspace + scope only, never user_id — a shared
    // thread scope's drafts all follow the message regardless of author.
    expect(captured.text).not.toContain("user_id =")
    expect(captured.values).toContain("thread:msg_1")
    expect(captured.values).toContain("stream:thread_1")
    expect(captured.values).toContain("stream_root")
    // Returns each re-scoped row so the caller can emit one event per owner.
    expect(rows.map((row) => row.userId)).toEqual(["usr_1", "usr_2"])
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
    // Defensive cap — the bootstrap read is bounded so a pathological account
    // can't return an unbounded set.
    expect(captured.text).toContain("LIMIT")
    expect(captured.values).toContain(500)
  })
})
