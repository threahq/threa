import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { StreamPoliciesRepository } from "./policy-repository"

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[], rowCount?: number): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rowCount ?? rows.length } as QueryResult
    }),
  }
}

describe("StreamPoliciesRepository.getToolPolicy", () => {
  afterEach(() => mock.restore())

  it("scopes the lookup to workspace_id and stream_id (INV-8) and returns the categories", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ allowed_tool_categories: ["web"] }])

    const result = await StreamPoliciesRepository.getToolPolicy(db, "ws_1", "stream_01")

    expect(captured.text).toContain("FROM stream_policies")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("stream_id =")
    expect(captured.values).toEqual(["ws_1", "stream_01"])
    expect(result).toEqual(["web"])
  })

  it("returns null (no restriction) when the stream has no policy row", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    const result = await StreamPoliciesRepository.getToolPolicy(db, "ws_1", "stream_01")
    expect(result).toBeNull()
  })

  it("returns an empty array as a real policy (no tools), distinct from no row", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [{ allowed_tool_categories: [] }])

    const result = await StreamPoliciesRepository.getToolPolicy(db, "ws_1", "stream_01")
    expect(result).toEqual([])
  })
})

describe("StreamPoliciesRepository.setToolPolicy", () => {
  afterEach(() => mock.restore())

  it("upserts a non-null policy race-safely, keyed on the stream PK (INV-20), asserting the workspace (INV-8)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 1)

    await StreamPoliciesRepository.setToolPolicy(db, "ws_1", "stream_01", ["web", "workspace"])

    expect(captured.text).toContain("INSERT INTO stream_policies")
    expect(captured.text).toContain("ON CONFLICT (stream_id)")
    expect(captured.text).toContain("DO UPDATE SET allowed_tool_categories = EXCLUDED.allowed_tool_categories")
    expect(captured.text).toContain("WHERE stream_policies.workspace_id = EXCLUDED.workspace_id")
    expect(captured.values).toEqual(["stream_01", "ws_1", ["web", "workspace"]])
  })

  it("persists an empty array as a real policy (no tools), still an upsert not a delete", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 1)

    await StreamPoliciesRepository.setToolPolicy(db, "ws_1", "stream_01", [])

    expect(captured.text).toContain("INSERT INTO stream_policies")
    expect(captured.values).toEqual(["stream_01", "ws_1", []])
  })

  it("fails loudly when the upsert matches no row (workspace mismatch, INV-11)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    await expect(StreamPoliciesRepository.setToolPolicy(db, "ws_1", "stream_01", ["web"])).rejects.toThrow(
      /workspace mismatch/i
    )
  })

  it("expresses 'no restriction' (null) by deleting the row, never storing NULL", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    await StreamPoliciesRepository.setToolPolicy(db, "ws_1", "stream_01", null)

    expect(captured.text).toContain("DELETE FROM stream_policies")
    expect(captured.text).not.toContain("INSERT")
    expect(captured.values).toEqual(["ws_1", "stream_01"])
  })
})
