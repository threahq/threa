import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { StreamBriefRepository } from "./brief-repository"

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[]): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rows.length } as QueryResult
    }),
  }
}

const briefRow = {
  id: "sbrf_01",
  workspace_id: "ws_1",
  stream_id: "stream_1",
  content: "Goal: ship v2",
  version: 3,
  updated_by_kind: "user",
  updated_by_id: "usr_1",
  created_at: new Date("2026-07-01T00:00:00Z"),
  updated_at: new Date("2026-07-05T00:00:00Z"),
}

describe("StreamBriefRepository.findByStreamId", () => {
  afterEach(() => mock.restore())

  it("scopes the lookup to workspace_id and stream_id (INV-8) and maps the row", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [briefRow])

    const result = await StreamBriefRepository.findByStreamId(db, "ws_1", "stream_1")

    expect(captured.text).toContain("FROM stream_briefs")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("stream_id =")
    expect(captured.values).toEqual(["ws_1", "stream_1"])
    expect(result).toEqual({
      id: "sbrf_01",
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "Goal: ship v2",
      version: 3,
      updatedByKind: "user",
      updatedById: "usr_1",
      createdAt: briefRow.created_at,
      updatedAt: briefRow.updated_at,
    })
  })

  it("returns null when the stream has no brief", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])
    expect(await StreamBriefRepository.findByStreamId(db, "ws_1", "stream_1")).toBeNull()
  })
})

describe("StreamBriefRepository.insertFirstVersion", () => {
  afterEach(() => mock.restore())

  it("inserts version 1 with ON CONFLICT DO NOTHING so a create race is a single statement (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ ...briefRow, version: 1 }])

    const result = await StreamBriefRepository.insertFirstVersion(db, {
      id: "sbrf_01",
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "Goal: ship v2",
      updatedByKind: "user",
      updatedById: "usr_1",
    })

    expect(captured.text).toContain("INSERT INTO stream_briefs")
    expect(captured.text).toContain("ON CONFLICT (stream_id) DO NOTHING")
    expect(result?.version).toBe(1)
  })

  it("returns null when a brief already exists (lost the create race)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])
    const result = await StreamBriefRepository.insertFirstVersion(db, {
      id: "sbrf_01",
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "x",
      updatedByKind: "user",
      updatedById: "usr_1",
    })
    expect(result).toBeNull()
  })
})

describe("StreamBriefRepository.updateAtVersion", () => {
  afterEach(() => mock.restore())

  it("guards on the expected version and workspace/stream scope (INV-20, INV-8)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ ...briefRow, version: 4 }])

    const result = await StreamBriefRepository.updateAtVersion(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "Goal: ship v3",
      expectedVersion: 3,
      updatedByKind: "persona",
      updatedById: "persona_ariadne",
    })

    expect(captured.text).toContain("UPDATE stream_briefs")
    expect(captured.text).toContain("version = version + 1")
    expect(captured.text).toContain("AND version =")
    expect(captured.values).toContain(3)
    expect(captured.values).toContain("ws_1")
    expect(captured.values).toContain("stream_1")
    expect(result?.version).toBe(4)
  })

  it("returns null when the stored version moved (or no brief exists)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])
    const result = await StreamBriefRepository.updateAtVersion(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      content: "x",
      expectedVersion: 2,
      updatedByKind: "user",
      updatedById: "usr_1",
    })
    expect(result).toBeNull()
  })
})

describe("StreamBriefRepository.insertRevision", () => {
  afterEach(() => mock.restore())

  it("writes the audit row with the accepted version and author", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    await StreamBriefRepository.insertRevision(db, {
      id: "sbrv_01",
      workspaceId: "ws_1",
      briefId: "sbrf_01",
      streamId: "stream_1",
      version: 4,
      content: "Goal: ship v3",
      updatedByKind: "persona",
      updatedById: "persona_ariadne",
    })

    expect(captured.text).toContain("INSERT INTO stream_brief_revisions")
    expect(captured.values).toEqual([
      "sbrv_01",
      "ws_1",
      "sbrf_01",
      "stream_1",
      4,
      "Goal: ship v3",
      "persona",
      "persona_ariadne",
    ])
  })
})
