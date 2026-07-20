import { describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { FeatureFlagOverrideRepository } from "./repository"

const WORKSPACE_ID = "ws_1"
const WORKOS_USER_ID = "workos_user_1"

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

describe("FeatureFlagOverrideRepository.findLayers", () => {
  it("partitions workspace and user rows from one query, keeping both for the same flag", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [
      { subject_type: "workspace", flag_key: "calls", value: "off" },
      { subject_type: "user", flag_key: "calls", value: "on" },
      { subject_type: "user", flag_key: "newComposer", value: "on" },
    ])

    const layers = await FeatureFlagOverrideRepository.findLayers(db, WORKSPACE_ID, WORKOS_USER_ID)

    expect(layers).toEqual({
      workspace: { calls: "off" },
      user: { calls: "on", newComposer: "on" },
    })
    // One round trip: workspace_id, the workspace-scope subject_id (= workspace
    // id), and the user-scope subject_id (= workos user id).
    expect((db.query as ReturnType<typeof mock>).mock.calls.length).toBe(1)
    expect(captured.values).toEqual([WORKSPACE_ID, WORKSPACE_ID, WORKOS_USER_ID])
  })

  it("returns empty layers when the subject has no rows", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [])

    const layers = await FeatureFlagOverrideRepository.findLayers(db, WORKSPACE_ID, WORKOS_USER_ID)

    expect(layers).toEqual({ workspace: {}, user: {} })
  })
})
