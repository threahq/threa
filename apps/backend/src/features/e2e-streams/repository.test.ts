import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { E2eStreamsRepository } from "./repository"

const NOW = new Date("2026-05-26T12:00:00.000Z")

const ROW = {
  stream_id: "stream_01",
  workspace_id: "ws_1",
  enabled_at: NOW,
  owner_user_id: "usr_1",
  owner_user_key_id: "e2ek_01",
  current_key_generation: 0,
  allowed_tool_categories: ["web"],
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [ROW], rowCount?: number): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rowCount ?? rows.length } as QueryResult
    }),
  }
}

describe("E2eStreamsRepository.isE2eStream", () => {
  afterEach(() => mock.restore())

  it("returns true when the EXISTS check matches a workspace-scoped row (INV-8)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ exists: true }])

    const result = await E2eStreamsRepository.isE2eStream(db, "ws_1", "stream_01")

    expect(captured.text).toContain("FROM e2e_streams")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("stream_id =")
    expect(captured.values).toEqual(["ws_1", "stream_01"])
    expect(result).toBe(true)
  })

  it("returns false when no row exists", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ exists: false }])

    const result = await E2eStreamsRepository.isE2eStream(db, "ws_1", "stream_01")
    expect(result).toBe(false)
  })

  it("returns false on empty rows (defensive against driver quirks)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const result = await E2eStreamsRepository.isE2eStream(db, "ws_1", "stream_01")
    expect(result).toBe(false)
  })
})

describe("E2eStreamsRepository.getByStreamId", () => {
  afterEach(() => mock.restore())

  it("scopes lookup to workspace_id and stream_id, maps snake_case to camelCase", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    const result = await E2eStreamsRepository.getByStreamId(db, "ws_1", "stream_01")

    expect(captured.text).toContain("FROM e2e_streams")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("stream_id =")
    expect(captured.values).toEqual(["ws_1", "stream_01"])
    expect(result).toEqual({
      streamId: "stream_01",
      workspaceId: "ws_1",
      enabledAt: NOW,
      ownerUserId: "usr_1",
      ownerUserKeyId: "e2ek_01",
      currentKeyGeneration: 0,
      allowedToolCategories: ["web"],
      hasSealedName: false,
    })
  })

  it("returns null when no row matches", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const result = await E2eStreamsRepository.getByStreamId(db, "ws_1", "stream_01")
    expect(result).toBeNull()
  })
})

describe("E2eStreamsRepository.bumpKeyGeneration", () => {
  afterEach(() => mock.restore())

  it("guards the bump on the prior generation so concurrent rolls can't both win (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ ...ROW, current_key_generation: 1 }])

    const result = await E2eStreamsRepository.bumpKeyGeneration(db, {
      workspaceId: "ws_1",
      streamId: "stream_01",
      toGeneration: 1,
    })

    expect(captured.text).toContain("UPDATE e2e_streams")
    expect(captured.text).toContain("SET current_key_generation =")
    // bound values: toGeneration (set + new), guard = toGeneration - 1, scope
    expect(captured.values).toContain(1)
    expect(captured.values).toContain(0)
    expect(captured.values).toContain("ws_1")
    expect(captured.values).toContain("stream_01")
    expect(result?.currentKeyGeneration).toBe(1)
  })

  it("returns null when the guard matches no row (lost the race / stale generation)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const result = await E2eStreamsRepository.bumpKeyGeneration(db, {
      workspaceId: "ws_1",
      streamId: "stream_01",
      toGeneration: 2,
    })
    expect(result).toBeNull()
  })
})

describe("E2eStreamsRepository.markStreamE2e", () => {
  afterEach(() => mock.restore())

  it("inserts the row with all fields and returns the mapped result", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    const inserted = await E2eStreamsRepository.markStreamE2e(db, {
      streamId: "stream_01",
      workspaceId: "ws_1",
      ownerUserId: "usr_1",
      ownerUserKeyId: "e2ek_01",
    })

    expect(captured.text).toContain("INSERT INTO e2e_streams")
    expect(captured.text).toContain("RETURNING")
    expect(captured.values).toContain("stream_01")
    expect(captured.values).toContain("ws_1")
    expect(captured.values).toContain("usr_1")
    expect(captured.values).toContain("e2ek_01")
    expect(inserted.streamId).toBe("stream_01")
    expect(inserted.ownerUserKeyId).toBe("e2ek_01")
  })
})
