import { describe, expect, it } from "bun:test"
import { StreamContextRepository } from "./repository"
import type { NewStreamContextItem } from "./types"

// These assert the SQL each method emits, not its effect on rows — the fake
// Querier never reaches Postgres. Conflict/idempotence BEHAVIOUR is covered by
// the backfill's re-run test, which drives the same statements against a real
// schema; what is pinned here is that the clause targets the identity index and
// that every method stays set-based (INV-56).
function fakeDb() {
  const queries: Array<{ text: string; values: unknown[] }> = []
  const db = {
    async query(textOrConfig: any, values?: unknown[]) {
      const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text
      const vals = typeof textOrConfig === "string" ? (values ?? []) : (textOrConfig.values ?? [])
      queries.push({ text, values: vals })
      return { rows: [], rowCount: 0 }
    },
  }
  return { db: db as any, queries }
}

function makeRow(overrides: Partial<NewStreamContextItem> = {}): NewStreamContextItem {
  return {
    id: "sctx_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    rootStreamId: "stream_root",
    category: "link",
    refKind: "url",
    refId: "https://example.com/a",
    groupKey: "https://example.com/a",
    sourceMessageId: "msg_1",
    authorId: "usr_1",
    occurredAt: new Date("2026-07-20T10:00:00.000Z"),
    sequence: 7n,
    snippet: "hello",
    detail: { url: "https://example.com/a" },
    ...overrides,
  }
}

describe("StreamContextRepository.insertMany", () => {
  it("emits one set-based statement whose conflict clause targets the identity index", async () => {
    const { db, queries } = fakeDb()

    await StreamContextRepository.insertMany(db, [makeRow(), makeRow({ id: "sctx_2", refId: "attach_1" })])

    expect(queries).toHaveLength(1)
    expect(queries[0].text).toContain("UNNEST")
    expect(queries[0].text).toContain(
      "ON CONFLICT (workspace_id, stream_id, category, ref_id, COALESCE(source_message_id, '')) DO NOTHING"
    )
    expect(queries[0].values[0]).toEqual(["sctx_1", "sctx_2"])
  })

  it("issues no query for an empty batch", async () => {
    const { db, queries } = fakeDb()
    expect(await StreamContextRepository.insertMany(db, [])).toBe(0)
    expect(queries).toEqual([])
  })
})

describe("StreamContextRepository.replaceForMessage", () => {
  it("deletes the message's rows before inserting the rebuilt set", async () => {
    const { db, queries } = fakeDb()

    await StreamContextRepository.replaceForMessage(db, "ws_1", "msg_1", [makeRow({ refId: "https://example.com/b" })])

    expect(queries).toHaveLength(2)
    expect(queries[0].text).toContain("DELETE FROM stream_context_items")
    expect(queries[0].values).toEqual(["ws_1", "msg_1"])
    expect(queries[1].text).toContain("INSERT INTO stream_context_items")
    expect(queries[1].values[6]).toEqual(["https://example.com/b"])
  })

  it("still clears the rows when the edited content has none left", async () => {
    const { db, queries } = fakeDb()

    await StreamContextRepository.replaceForMessage(db, "ws_1", "msg_1", [])

    expect(queries.map((q) => q.text.includes("DELETE FROM stream_context_items"))).toEqual([true])
  })
})

describe("StreamContextRepository.reparentMessages", () => {
  it("scopes the UPDATE to the named messages and carries their destination sequences, in one statement", async () => {
    const { db, queries } = fakeDb()

    await StreamContextRepository.reparentMessages(
      db,
      "ws_1",
      [
        { messageId: "msg_1", sequence: 41n },
        { messageId: "msg_2", sequence: 42n },
      ],
      "stream_thread",
      "stream_root"
    )

    expect(queries).toHaveLength(1)
    expect(queries[0].text).toContain("sequence = moved.sequence")
    expect(queries[0].values).toEqual(["stream_thread", "stream_root", ["msg_1", "msg_2"], ["41", "42"], "ws_1"])
  })

  it("issues no query when nothing moved", async () => {
    const { db, queries } = fakeDb()
    expect(await StreamContextRepository.reparentMessages(db, "ws_1", [], "stream_thread", "stream_root")).toBe(0)
    expect(queries).toEqual([])
  })
})
