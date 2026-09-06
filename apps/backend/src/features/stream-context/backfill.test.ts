import { describe, expect, it } from "bun:test"
import type { JSONContent } from "@threahq/types"
import { plan, processChunk, type StreamContextChunk } from "./backfill"
import { contextRowsForMessage } from "./extract"
import type { BackfillContext } from "../../lib/backfill"

/**
 * Fake pool that answers each query from a matcher list and applies the identity
 * index's `ON CONFLICT DO NOTHING` to `stream_context_items` inserts, so the
 * idempotence test observes the real conflict rule rather than a stub.
 *
 * What this suite covers is the chunk PROJECTION — which rows a given set of
 * database rows turns into. It cannot say whether the statements that produced
 * those rows are valid SQL; `tests/integration/stream-context-backfill.test.ts`
 * runs them against the real schema and owns that half.
 */
function fakePool(responses: Array<{ match: RegExp; rows: unknown[] }>) {
  const inserted = new Map<string, Record<string, unknown>>()
  const unmatched: string[] = []
  const queries: string[] = []
  const insertValues: unknown[][] = []
  const pool = {
    async query(config: any) {
      const text: string = typeof config === "string" ? config : config.text
      const values: unknown[] = (typeof config === "string" ? [] : config.values) ?? []
      queries.push(text)
      if (text.includes("INSERT INTO stream_context_items")) {
        insertValues.push(values)
        const [ids, , streamIds, , categories, , refIds, , sourceMessageIds] = values as string[][]
        let rowCount = 0
        ids.forEach((id, i) => {
          const key = `${streamIds[i]}:${categories[i]}:${refIds[i]}:${sourceMessageIds[i] ?? ""}`
          if (inserted.has(key)) return
          inserted.set(key, { id, key })
          rowCount += 1
        })
        return { rows: [], rowCount }
      }
      if (text.includes("DELETE FROM stream_context_items")) {
        const ids = new Set((values[1] as string[]) ?? [])
        let rowCount = 0
        for (const [key, row] of inserted) {
          if (!ids.has(row.id as string)) continue
          inserted.delete(key)
          rowCount += 1
        }
        return { rows: [], rowCount }
      }
      const response = responses.find((r) => r.match.test(text))
      if (!response) {
        unmatched.push(text)
        return { rows: [], rowCount: 0 }
      }
      return { rows: response.rows, rowCount: response.rows.length }
    },
  }
  return { ctx: { pool } as unknown as BackfillContext, inserted, unmatched, queries, insertValues }
}

const INSERT_COLUMNS = [
  "id",
  "workspaceId",
  "streamId",
  "rootStreamId",
  "category",
  "refKind",
  "refId",
  "groupKey",
  "sourceMessageId",
  "authorId",
  "occurredAt",
  "sequence",
  "snippet",
  "detail",
] as const

/** Rebuild the inserted rows from the UNNEST column arrays, minus the generated id. */
function insertedRows(values: unknown[]): Array<Record<string, unknown>> {
  const columns = values as unknown[][]
  return columns[0].map((_, i) =>
    Object.fromEntries(
      INSERT_COLUMNS.slice(1).map((name, col) => [
        name,
        name === "detail" ? JSON.parse(columns[col + 1][i] as string) : columns[col + 1][i],
      ])
    )
  )
}

const linkDoc = (href: string): JSONContent => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "look", marks: [{ type: "link", attrs: { href } }] }] },
  ],
})

describe("stream-context backfill plan", () => {
  it("chunks a stream's messages at 500 per chunk", async () => {
    const messageRows = [
      ...Array.from({ length: 501 }, (_, i) => ({ id: `msg_${String(i).padStart(4, "0")}`, stream_id: "stream_a" })),
      { id: "msg_b1", stream_id: "stream_b" },
    ]
    const { ctx } = fakePool([
      // The sealed stream is excluded by the plan query itself, so it never
      // reaches the chunk list.
      {
        match: /FROM streams s/,
        rows: [
          { id: "stream_a", root_stream_id: "stream_a" },
          { id: "stream_b", root_stream_id: "stream_a" },
        ],
      },
      { match: /SELECT id, stream_id FROM messages/, rows: messageRows },
      { match: /FROM memos mo/, rows: [{ stream_id: "stream_b" }] },
      { match: /FROM delegated_tasks/, rows: [{ stream_id: "stream_a" }] },
      { match: /SELECT DISTINCT parent_stream_id/, rows: [{ parent_stream_id: "stream_a" }] },
    ])

    const chunks = await plan(ctx, "ws_1")

    expect(
      chunks.map((chunk) => ({ ...chunk, ...(chunk.kind === "messages" ? { ids: chunk.ids.length } : {}) }))
    ).toEqual([
      { kind: "messages", streamId: "stream_a", rootStreamId: "stream_a", ids: 500 },
      { kind: "messages", streamId: "stream_a", rootStreamId: "stream_a", ids: 1 },
      { kind: "messages", streamId: "stream_b", rootStreamId: "stream_a", ids: 1 },
      { kind: "memos", streamId: "stream_b", rootStreamId: "stream_a" },
      { kind: "delegations", streamId: "stream_a", rootStreamId: "stream_a" },
      { kind: "threads", streamId: "stream_a", rootStreamId: "stream_a" },
    ])
  })

  it("plans one follow_ups chunk per stream with rows, and none for a sealed stream", async () => {
    const { ctx } = fakePool([
      // `stream_sealed` is absent from the plan query's result — sealed streams
      // are excluded there — so its follow-ups are never asked for either.
      {
        match: /FROM streams s/,
        rows: [
          { id: "stream_a", root_stream_id: "stream_a" },
          { id: "stream_b", root_stream_id: "stream_a" },
        ],
      },
      { match: /SELECT id, stream_id FROM messages/, rows: [] },
      { match: /FROM memos mo/, rows: [] },
      { match: /FROM delegated_tasks/, rows: [] },
      { match: /FROM agent_follow_ups/, rows: [{ stream_id: "stream_b" }] },
      { match: /SELECT DISTINCT parent_stream_id/, rows: [] },
    ])

    const chunks = await plan(ctx, "ws_1")

    expect(chunks).toEqual([{ kind: "follow_ups", streamId: "stream_b", rootStreamId: "stream_a" }])
  })

  it("plans nothing when the workspace has no indexable stream", async () => {
    const { ctx } = fakePool([{ match: /FROM streams s/, rows: [] }])

    expect(await plan(ctx, "ws_1")).toEqual([])
  })
})

describe("stream-context backfill — messages chunk", () => {
  const chunk: StreamContextChunk = {
    kind: "messages",
    streamId: "stream_a",
    rootStreamId: "stream_root",
    ids: ["msg_1"],
  }
  const messageCreatedAt = new Date("2026-07-20T09:00:00.000Z")

  function messagePool(overrides: Array<{ match: RegExp; rows: unknown[] }> = []) {
    return fakePool([
      ...overrides,
      {
        match: /SELECT id, author_id, created_at, sequence, content_json, content_markdown/,
        rows: [
          {
            id: "msg_1",
            author_id: "usr_1",
            created_at: messageCreatedAt,
            sequence: "11",
            content_json: linkDoc("https://example.com/a"),
            content_markdown: "look https://example.com/a",
            edited_at: null,
          },
        ],
      },
      {
        match: /FROM \(\s*SELECT id AS attachment_id/,
        rows: [{ message_id: "msg_1", attachment_id: "attach_1", mime_type: "image/png" }],
      },
      // Post-insert re-check: unchanged unless a test overrides it.
      { match: /SELECT id, edited_at FROM messages/, rows: [{ id: "msg_1", edited_at: null }] },
    ])
  }

  const expectedRows = () =>
    contextRowsForMessage({
      workspaceId: "ws_1",
      streamId: "stream_a",
      rootStreamId: "stream_root",
      messageId: "msg_1",
      authorId: "usr_1",
      occurredAt: messageCreatedAt,
      sequence: 11n,
      contentJson: linkDoc("https://example.com/a"),
      contentMarkdown: "look https://example.com/a",
      attachments: [{ id: "attach_1", mimeType: "image/png" }],
    }).map(({ id: _id, sequence, ...row }) => ({ ...row, sequence: sequence === null ? null : sequence.toString() }))

  it("produces exactly the rows the write path would for the same message", async () => {
    const { ctx, insertValues } = messagePool()

    await processChunk(ctx, "ws_1", chunk)

    expect(insertedRows(insertValues[0])).toEqual(expectedRows())
  })

  it("drops its own rows for a message edited between the read and the insert", async () => {
    // The live edit hook committed in the gap: it replaced nothing (no rows yet)
    // and wrote correct rows, so the backfill's pre-edit rows must not survive.
    const { ctx, inserted } = messagePool([
      {
        match: /SELECT id, edited_at FROM messages/,
        rows: [{ id: "msg_1", edited_at: new Date("2026-07-20T10:00:00.000Z") }],
      },
    ])

    const result = await processChunk(ctx, "ws_1", chunk)

    expect({ result, keys: [...inserted.keys()] }).toEqual({ result: { processed: 0 }, keys: [] })
  })

  it("drops its own rows for a message deleted between the read and the insert", async () => {
    const { ctx, inserted } = messagePool([{ match: /SELECT id, edited_at FROM messages/, rows: [] }])

    const result = await processChunk(ctx, "ws_1", chunk)

    expect({ result, keys: [...inserted.keys()] }).toEqual({ result: { processed: 0 }, keys: [] })
  })

  it("stamps occurred_at from the message, not the attachment upload time", async () => {
    // The attachment row carries a LATER created_at than the message; the
    // projection must ignore it entirely.
    const { ctx } = fakePool([
      {
        match: /SELECT id, author_id, created_at, sequence, content_json, content_markdown/,
        rows: [
          {
            id: "msg_1",
            author_id: "usr_1",
            created_at: messageCreatedAt,
            sequence: "11",
            content_json: null,
            content_markdown: "with a file",
            edited_at: null,
          },
        ],
      },
      { match: /SELECT id, edited_at FROM messages/, rows: [{ id: "msg_1", edited_at: null }] },
      {
        match: /FROM \(\s*SELECT id AS attachment_id/,
        rows: [
          {
            message_id: "msg_1",
            attachment_id: "attach_1",
            mime_type: "application/pdf",
            created_at: new Date("2026-07-21T12:00:00.000Z"),
          },
        ],
      },
    ])
    const captured: any[] = []
    const originalQuery = (ctx.pool as any).query.bind(ctx.pool)
    ;(ctx.pool as any).query = async (config: any) => {
      if (typeof config !== "string" && config.text.includes("INSERT INTO stream_context_items")) {
        captured.push(config.values)
      }
      return originalQuery(config)
    }

    await processChunk(ctx, "ws_1", chunk)

    const [values] = captured
    expect({ refIds: values[6], occurredAt: values[10] }).toEqual({
      refIds: ["attach_1"],
      occurredAt: [messageCreatedAt],
    })
  })

  it("inserts nothing on a second run of the same chunk", async () => {
    const { ctx, inserted } = messagePool()

    const first = await processChunk(ctx, "ws_1", chunk)
    const firstKeys = [...inserted.keys()]
    const second = await processChunk(ctx, "ws_1", chunk)

    expect({ first, second, keys: [...inserted.keys()] }).toEqual({
      first: { processed: 2 },
      second: { processed: 0 },
      keys: firstKeys,
    })
  })
})

describe("stream-context backfill — memos, delegations, threads", () => {
  /** Row shape `StreamRepository.findById` maps, for the memo-scope resolution. */
  const streamRow = (over: Record<string, unknown>) => ({
    id: "stream_a",
    workspace_id: "ws_1",
    type: "channel",
    visibility: "public",
    root_stream_id: null,
    created_by: "usr_1",
    ...over,
  })
  const streamMatch = /SELECT\s+s\.id, s\.workspace_id, s\.type/

  it("anchors a memo row at the LATEST source message", async () => {
    const { ctx, inserted } = fakePool([
      { match: streamMatch, rows: [streamRow({})] },
      {
        match: /SELECT DISTINCT mo\.id/,
        rows: [
          {
            id: "memo_1",
            title: "Decision",
            knowledge_type: "decision",
            source_message_ids: ["msg_1", "msg_2"],
            scope: "workspace",
          },
        ],
      },
      {
        match: /SELECT id, author_id, created_at, sequence, content_markdown/,
        rows: [
          {
            id: "msg_1",
            author_id: "usr_1",
            created_at: new Date("2026-07-20T09:00:00.000Z"),
            sequence: "11",
            content_markdown: "first",
          },
          {
            id: "msg_2",
            author_id: "usr_2",
            created_at: new Date("2026-07-20T09:30:00.000Z"),
            sequence: "12",
            content_markdown: "second",
          },
        ],
      },
    ])
    const captured: any[] = []
    const originalQuery = (ctx.pool as any).query.bind(ctx.pool)
    ;(ctx.pool as any).query = async (config: any) => {
      if (typeof config !== "string" && config.text.includes("INSERT INTO stream_context_items")) {
        captured.push(config.values)
      }
      return originalQuery(config)
    }

    await processChunk(ctx, "ws_1", { kind: "memos", streamId: "stream_a", rootStreamId: "stream_root" })

    const [values] = captured
    expect({
      streamId: values[2][0],
      rootStreamId: values[3][0],
      category: values[4][0],
      refId: values[6][0],
      sourceMessageId: values[8][0],
      authorId: values[9][0],
      occurredAt: values[10][0],
      sequence: values[11][0],
      snippet: values[12][0],
      detail: JSON.parse(values[13][0]),
      insertedKeys: [...inserted.keys()],
    }).toEqual({
      streamId: "stream_a",
      rootStreamId: "stream_root",
      category: "memo",
      refId: "memo_1",
      sourceMessageId: "msg_1",
      authorId: "usr_2",
      occurredAt: new Date("2026-07-20T09:30:00.000Z"),
      sequence: "12",
      snippet: "Decision",
      detail: { title: "Decision", knowledgeType: "decision" },
      insertedKeys: ["stream_a:memo:memo_1:msg_1"],
    })
  })

  it("does not index a user-scoped memo into a wider stream", async () => {
    // Same suppression the write path applies: the projection row carries the
    // memo title into a stream every member can read.
    const { ctx, inserted } = fakePool([
      { match: streamMatch, rows: [streamRow({})] },
      {
        match: /SELECT DISTINCT mo\.id/,
        rows: [
          {
            id: "memo_private",
            title: "Private",
            knowledge_type: "insight",
            source_message_ids: ["msg_1"],
            scope: "user",
          },
          {
            id: "memo_shared",
            title: "Shared",
            knowledge_type: "decision",
            source_message_ids: ["msg_1"],
            scope: "workspace",
          },
        ],
      },
      {
        match: /SELECT id, author_id, created_at, sequence, content_markdown/,
        rows: [
          {
            id: "msg_1",
            author_id: "usr_1",
            created_at: new Date("2026-07-20T09:00:00.000Z"),
            sequence: "11",
            content_markdown: "first",
          },
        ],
      },
    ])

    await processChunk(ctx, "ws_1", { kind: "memos", streamId: "stream_a", rootStreamId: "stream_a" })

    expect([...inserted.keys()]).toEqual(["stream_a:memo:memo_shared:msg_1"])
  })

  it("indexes a user-scoped memo when the stream's own tier is the same owner", async () => {
    const { ctx, inserted } = fakePool([
      { match: streamMatch, rows: [streamRow({ type: "scratchpad", visibility: "private" })] },
      {
        match: /SELECT DISTINCT mo\.id/,
        rows: [
          {
            id: "memo_private",
            title: "Private",
            knowledge_type: "insight",
            source_message_ids: ["msg_1"],
            scope: "user",
          },
        ],
      },
      {
        match: /SELECT id, author_id, created_at, sequence, content_markdown/,
        rows: [
          {
            id: "msg_1",
            author_id: "usr_1",
            created_at: new Date("2026-07-20T09:00:00.000Z"),
            sequence: "11",
            content_markdown: "first",
          },
        ],
      },
    ])

    await processChunk(ctx, "ws_1", { kind: "memos", streamId: "stream_a", rootStreamId: "stream_a" })

    expect([...inserted.keys()]).toEqual(["stream_a:memo:memo_private:msg_1"])
  })

  it("anchors a memo on a surviving source when the first one was deleted", async () => {
    // The delete hook unindexes by source_message_id; anchoring on the deleted
    // message would resurrect the row it removed.
    const { ctx, inserted } = fakePool([
      { match: streamMatch, rows: [streamRow({})] },
      {
        match: /SELECT DISTINCT mo\.id/,
        rows: [
          {
            id: "memo_1",
            title: "Decision",
            knowledge_type: "decision",
            source_message_ids: ["msg_deleted", "msg_2"],
            scope: "workspace",
          },
        ],
      },
      {
        match: /SELECT id, author_id, created_at, sequence, content_markdown/,
        rows: [
          {
            id: "msg_2",
            author_id: "usr_2",
            created_at: new Date("2026-07-20T09:30:00.000Z"),
            sequence: "12",
            content_markdown: "second",
          },
        ],
      },
    ])

    await processChunk(ctx, "ws_1", { kind: "memos", streamId: "stream_a", rootStreamId: "stream_a" })

    expect([...inserted.keys()]).toEqual(["stream_a:memo:memo_1:msg_2"])
  })

  it("indexes delegations at their created_at with a user author", async () => {
    const { ctx } = fakePool([
      {
        match: /FROM delegated_tasks/,
        rows: [
          {
            id: "deleg_1",
            title: "Ship it",
            created_by_kind: "user",
            created_by_id: "usr_1",
            created_at: new Date("2026-07-20T11:00:00.000Z"),
          },
        ],
      },
    ])
    const captured: any[] = []
    const originalQuery = (ctx.pool as any).query.bind(ctx.pool)
    ;(ctx.pool as any).query = async (config: any) => {
      if (typeof config !== "string" && config.text.includes("INSERT INTO stream_context_items")) {
        captured.push(config.values)
      }
      return originalQuery(config)
    }

    await processChunk(ctx, "ws_1", { kind: "delegations", streamId: "stream_a", rootStreamId: "stream_root" })

    const [values] = captured
    expect({
      category: values[4][0],
      refKind: values[5][0],
      refId: values[6][0],
      sourceMessageId: values[8][0],
      authorId: values[9][0],
      occurredAt: values[10][0],
      sequence: values[11][0],
      detail: JSON.parse(values[12 + 1][0]),
      snippet: values[12][0],
    }).toEqual({
      category: "delegation",
      refKind: "delegation",
      refId: "deleg_1",
      sourceMessageId: null,
      authorId: "usr_1",
      occurredAt: new Date("2026-07-20T11:00:00.000Z"),
      sequence: null,
      detail: { title: "Ship it" },
      snippet: "Ship it",
    })
  })

  it("indexes follow-ups at their created_at under the write path's identity key", async () => {
    const { ctx, inserted } = fakePool([
      {
        match: /FROM agent_follow_ups/,
        rows: [{ id: "agfu_1", note: "check the deploy", created_at: new Date("2026-07-20T12:00:00.000Z") }],
      },
    ])
    const captured: any[] = []
    const originalQuery = (ctx.pool as any).query.bind(ctx.pool)
    ;(ctx.pool as any).query = async (config: any) => {
      if (typeof config !== "string" && config.text.includes("INSERT INTO stream_context_items")) {
        captured.push(config.values)
      }
      return originalQuery(config)
    }

    await processChunk(ctx, "ws_1", { kind: "follow_ups", streamId: "stream_a", rootStreamId: "stream_root" })

    const [values] = captured
    expect({
      rootStreamId: values[3][0],
      category: values[4][0],
      refKind: values[5][0],
      refId: values[6][0],
      groupKey: values[7][0],
      sourceMessageId: values[8][0],
      authorId: values[9][0],
      occurredAt: values[10][0],
      sequence: values[11][0],
      snippet: values[12][0],
      detail: JSON.parse(values[13][0]),
    }).toEqual({
      rootStreamId: "stream_root",
      category: "follow_up",
      refKind: "follow_up",
      refId: "agfu_1",
      groupKey: "agfu_1",
      sourceMessageId: null,
      authorId: null,
      occurredAt: new Date("2026-07-20T12:00:00.000Z"),
      sequence: null,
      snippet: "check the deploy",
      // Status and scheduled_for are joined live on read, never stored.
      detail: { note: "check the deploy" },
    })
    // The identity key the write path produces: (stream, category, ref, "").
    expect([...inserted.keys()]).toEqual(["stream_a:follow_up:agfu_1:"])

    await processChunk(ctx, "ws_1", { kind: "follow_ups", streamId: "stream_a", rootStreamId: "stream_root" })
    expect([...inserted.keys()]).toEqual(["stream_a:follow_up:agfu_1:"])
  })

  it("places a thread row on the parent stream at its anchor message", async () => {
    const { ctx } = fakePool([
      { match: /SELECT id, parent_anchor_id/, rows: [{ id: "stream_thread", parent_anchor_id: "msg_1" }] },
      {
        match: /SELECT id, author_id, created_at, sequence, content_markdown/,
        rows: [
          {
            id: "msg_1",
            author_id: "usr_1",
            created_at: new Date("2026-07-20T08:00:00.000Z"),
            sequence: "7",
            content_markdown: "**anchor** message",
          },
        ],
      },
    ])
    const captured: any[] = []
    const originalQuery = (ctx.pool as any).query.bind(ctx.pool)
    ;(ctx.pool as any).query = async (config: any) => {
      if (typeof config !== "string" && config.text.includes("INSERT INTO stream_context_items")) {
        captured.push(config.values)
      }
      return originalQuery(config)
    }

    await processChunk(ctx, "ws_1", { kind: "threads", streamId: "stream_parent", rootStreamId: "stream_parent" })

    const [values] = captured
    expect({
      streamId: values[2][0],
      rootStreamId: values[3][0],
      category: values[4][0],
      refId: values[6][0],
      groupKey: values[7][0],
      sourceMessageId: values[8][0],
      authorId: values[9][0],
      occurredAt: values[10][0],
      sequence: values[11][0],
      snippet: values[12][0],
    }).toEqual({
      streamId: "stream_parent",
      rootStreamId: "stream_parent",
      category: "thread",
      refId: "stream_thread",
      groupKey: "stream_thread",
      sourceMessageId: "msg_1",
      authorId: "usr_1",
      occurredAt: new Date("2026-07-20T08:00:00.000Z"),
      sequence: "7",
      snippet: "anchor message",
    })
  })

  it("places a card-anchored thread row at its anchor event, with no source message", async () => {
    const { ctx } = fakePool([
      { match: /SELECT id, parent_anchor_id/, rows: [{ id: "stream_thread", parent_anchor_id: "event_9" }] },
      { match: /SELECT id, author_id, created_at, sequence, content_markdown/, rows: [] },
      {
        match: /SELECT id, actor_id, actor_type, created_at, sequence/,
        rows: [
          {
            id: "event_9",
            actor_id: "usr_2",
            actor_type: "user",
            created_at: new Date("2026-07-21T09:30:00.000Z"),
            sequence: "12",
          },
        ],
      },
    ])
    const captured: any[] = []
    const originalQuery = (ctx.pool as any).query.bind(ctx.pool)
    ;(ctx.pool as any).query = async (config: any) => {
      if (typeof config !== "string" && config.text.includes("INSERT INTO stream_context_items")) {
        captured.push(config.values)
      }
      return originalQuery(config)
    }

    await processChunk(ctx, "ws_1", { kind: "threads", streamId: "stream_parent", rootStreamId: "stream_parent" })

    const [values] = captured
    expect({
      streamId: values[2][0],
      category: values[4][0],
      refId: values[6][0],
      sourceMessageId: values[8][0],
      authorId: values[9][0],
      occurredAt: values[10][0],
      sequence: values[11][0],
      snippet: values[12][0],
      detail: values[13][0],
    }).toEqual({
      streamId: "stream_parent",
      category: "thread",
      refId: "stream_thread",
      sourceMessageId: null,
      authorId: "usr_2",
      occurredAt: new Date("2026-07-21T09:30:00.000Z"),
      sequence: "12",
      snippet: "",
      detail: JSON.stringify({ anchorEventId: "event_9" }),
    })
  })
})
