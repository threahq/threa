import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { StreamPoliciesRepository } from "./policy-repository"

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
