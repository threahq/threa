import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { E2eStreamActorsRepository } from "./actor-repository"

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [], rowCount?: number): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rowCount ?? rows.length } as QueryResult
    }),
  }
}

describe("E2eStreamActorsRepository.listForStream", () => {
  afterEach(() => mock.restore())

  it("scopes the lookup to workspace + stream and maps snake_case to camelCase", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [
      { kind: "bot", key_id: "bkey_01" },
      { kind: "enclave", key_id: null },
    ])

    const result = await E2eStreamActorsRepository.listForStream(db, "ws_1", "stream_01")

    expect(captured.text).toContain("FROM e2e_stream_actors")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("stream_id =")
    expect(captured.values).toEqual(["ws_1", "stream_01"])
    expect(result).toEqual([
      { kind: "bot", keyId: "bkey_01" },
      { kind: "enclave", keyId: null },
    ])
  })
})

describe("E2eStreamActorsRepository.add", () => {
  afterEach(() => mock.restore())

  it("inserts idempotently (ON CONFLICT DO NOTHING) and returns true when a row is created", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 1)

    const added = await E2eStreamActorsRepository.add(db, "ws_1", "stream_01", "enclave", null)

    expect(captured.text).toContain("INSERT INTO e2e_stream_actors")
    expect(captured.text).toContain("ON CONFLICT")
    expect(captured.text).toContain("DO NOTHING")
    expect(captured.values).toEqual(["ws_1", "stream_01", "enclave", null])
    expect(added).toBe(true)
  })

  it("returns false when that kind was already invited (no row inserted)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const added = await E2eStreamActorsRepository.add(db, "ws_1", "stream_01", "enclave", null)
    expect(added).toBe(false)
  })
})

describe("E2eStreamActorsRepository.remove", () => {
  afterEach(() => mock.restore())

  it("deletes the actor scoped to workspace + stream + kind", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 1)

    await E2eStreamActorsRepository.remove(db, "ws_1", "stream_01", "bot")

    expect(captured.text).toContain("DELETE FROM e2e_stream_actors")
    expect(captured.values).toEqual(["ws_1", "stream_01", "bot"])
  })
})
