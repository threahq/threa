import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { StreamE2eKeyWrapsRepository, type InsertKeyWrapParams } from "./key-wrap-repository"

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

const WRAP: InsertKeyWrapParams = {
  workspaceId: "ws_1",
  streamId: "stream_01",
  keyGeneration: 0,
  recipientKeyId: "e2ek_owner",
  recipientKind: "user",
  wrapEnc: "ZW5j", // base64
  wrapCt: "Y3Q=", // base64
}

describe("StreamE2eKeyWrapsRepository.insertMany", () => {
  afterEach(() => mock.restore())

  it("no-ops on an empty batch without touching the DB", async () => {
    const captured: Captured = { text: null, values: null }
    const query = mock(async () => ({ rows: [] as unknown[], rowCount: 0 }) as QueryResult)
    await StreamE2eKeyWrapsRepository.insertMany({ query }, [])
    expect(query).not.toHaveBeenCalled()
    expect(captured.text).toBeNull()
  })

  it("batch-inserts via UNNEST, decodes base64 to BYTEA, and is idempotent per slot (INV-20/56)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await StreamE2eKeyWrapsRepository.insertMany(db, [WRAP])

    expect(captured.text).toContain("INSERT INTO stream_e2e_key_wraps")
    expect(captured.text).toContain("UNNEST")
    expect(captured.text).toContain("decode(wrap_enc_b64, 'base64')")
    expect(captured.text).toContain("decode(wrap_ct_b64, 'base64')")
    expect(captured.text).toContain("ON CONFLICT (workspace_id, stream_id, key_generation, recipient_key_id)")
    expect(captured.text).toContain("DO NOTHING")
    // Each column is bound as a UNNEST array param; ids are server-minted so we
    // assert the caller-supplied slot values flow through as their own arrays.
    expect(captured.values).toContainEqual(["ws_1"])
    expect(captured.values).toContainEqual(["stream_01"])
    expect(captured.values).toContainEqual([0])
    expect(captured.values).toContainEqual(["e2ek_owner"])
    expect(captured.values).toContainEqual(["user"])
    expect(captured.values).toContainEqual(["ZW5j"])
    expect(captured.values).toContainEqual(["Y3Q="])
  })
})

describe("StreamE2eKeyWrapsRepository.listForStream", () => {
  afterEach(() => mock.restore())

  it("scopes to workspace + stream, encodes BYTEA to base64, and maps snake_case", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [
      {
        key_generation: 0,
        recipient_key_id: "e2ek_owner",
        recipient_kind: "user",
        wrap_enc_b64: "ZW5j",
        wrap_ct_b64: "Y3Q=",
      },
    ])

    const result = await StreamE2eKeyWrapsRepository.listForStream(db, "ws_1", "stream_01")

    expect(captured.text).toContain("FROM stream_e2e_key_wraps")
    expect(captured.text).toContain("encode(wrap_enc, 'base64')")
    expect(captured.text).toContain("encode(wrap_ct, 'base64')")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("stream_id =")
    expect(captured.values).toEqual(["ws_1", "stream_01"])
    expect(result).toEqual([
      {
        keyGeneration: 0,
        recipientKeyId: "e2ek_owner",
        recipientKind: "user",
        wrapEnc: "ZW5j",
        wrapCt: "Y3Q=",
      },
    ])
  })
})
