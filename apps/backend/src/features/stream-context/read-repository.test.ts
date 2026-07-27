import { describe, expect, it } from "bun:test"
import { StreamContextReadRepository, type StreamContextFeedFilters } from "./read-repository"

// SQL-shape tests, matching `repository.test.ts`: the fake Querier never reaches
// Postgres, so what is pinned here is the clause ORDER (filters inside `scoped`,
// collapse over the filtered set, keyset last) and the mapping of a returned row.
function fakeDb(rows: unknown[] = []) {
  const queries: Array<{ text: string; values: unknown[] }> = []
  const db = {
    async query(textOrConfig: any, values?: unknown[]) {
      const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text
      const vals = typeof textOrConfig === "string" ? (values ?? []) : (textOrConfig.values ?? [])
      queries.push({ text, values: vals })
      return { rows, rowCount: rows.length }
    },
  }
  return { db: db as any, queries }
}

const filters: StreamContextFeedFilters = {
  workspaceId: "ws_1",
  rootStreamId: "stream_root",
  streamId: "stream_thread",
  scope: "tree",
}

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sctx_1",
    stream_id: "stream_thread",
    category: "link",
    ref_kind: "url",
    ref_id: "https://example.com/a?utm_source=x",
    group_key: "https://example.com/a",
    source_message_id: "msg_1",
    author_id: "usr_1",
    occurred_at: new Date("2026-07-20T10:00:00.000Z"),
    sequence: "42",
    snippet: "look at this",
    detail: { url: "https://example.com/a?utm_source=x" },
    occurrence_count: 3,
    link_url: "https://example.com/a",
    link_title: "Example",
    link_description: "A page",
    link_site_name: "example.com",
    link_favicon_url: "https://example.com/f.ico",
    link_image_url: "https://example.com/i.png",
    link_preview_type: "github_pr",
    link_content_type: "website",
    link_status: "completed",
    attachment_id: null,
    attachment_filename: null,
    attachment_mime_type: null,
    attachment_size_bytes: null,
    attachment_width: null,
    attachment_height: null,
    memo_title: null,
    memo_knowledge_type: null,
    task_title: null,
    task_status: null,
    task_claimed_by_label: null,
    task_status_note: null,
    task_result_message_id: null,
    thread_name: null,
    thread_reply_count: null,
    thread_last_reply_at: null,
    thread_anchor_event_id: null,
    ...overrides,
  }
}

describe("StreamContextReadRepository.listFeed", () => {
  it("filters inside the scoped CTE, collapses per (category, group_key), then applies the keyset", async () => {
    const { db, queries } = fakeDb()

    await StreamContextReadRepository.listFeed(db, {
      ...filters,
      category: "link",
      cursor: { occurredAt: new Date("2026-07-19T00:00:00.000Z"), id: "sctx_9" },
      limit: 41,
    })

    const text = queries[0]!.text
    const scopedEnd = text.indexOf("grouped AS")
    const collapse = text.indexOf(
      "ROW_NUMBER() OVER (PARTITION BY category, group_key ORDER BY occurred_at DESC, id DESC)"
    )
    const keyset = text.indexOf("(occurred_at, id) <")
    expect(text.indexOf("sci.category =")).toBeLessThan(scopedEnd)
    expect(scopedEnd).toBeLessThan(collapse)
    expect(collapse).toBeLessThan(keyset)
    expect(text).toContain("COUNT(*) OVER (PARTITION BY category, group_key)")
    expect(text).toContain("WHERE rn = 1")
    expect(text).toContain("ORDER BY occurred_at DESC, id DESC")
    expect(queries[0]!.values).toContain("link")
    expect(queries[0]!.values).toContain("sctx_9")
    expect(queries[0]!.values).toContain(41)
  })

  it("joins link_previews on normalized_url, not through the per-message junction", async () => {
    const { db, queries } = fakeDb()

    await StreamContextReadRepository.listFeed(db, { ...filters, limit: 10 })

    const { text } = queries[0]!
    // message_link_previews caps at 5 previews per message, while the index
    // projects every url — joining through it would strip display data the
    // unique (workspace_id, normalized_url) index demonstrably holds.
    expect(text).not.toContain("message_link_previews")
    expect(text).toContain("LEFT JOIN link_previews lp")
    expect(text).toContain("lp.normalized_url = sci.group_key")
    expect(text).toContain("lp.preview_type AS link_preview_type")
    expect(text).toContain("lp.content_type AS link_content_type")
  })

  it("scopes tree reads on root_stream_id and stream reads on stream_id", async () => {
    const tree = fakeDb()
    await StreamContextReadRepository.listFeed(tree.db, { ...filters, scope: "tree", limit: 10 })
    const stream = fakeDb()
    await StreamContextReadRepository.listFeed(stream.db, { ...filters, scope: "stream", limit: 10 })

    const scopeValues = (q: { values: unknown[] }) => q.values.slice(0, 4)
    expect(tree.queries[0]!.text).toContain("sci.root_stream_id =")
    expect(tree.queries[0]!.text).toContain("sci.stream_id =")
    expect(scopeValues(tree.queries[0]!)).toEqual(["ws_1", true, "stream_root", false])
    expect(scopeValues(stream.queries[0]!)).toEqual(["ws_1", false, "stream_root", true])
  })

  it("narrows on free text, author, and both date bounds", async () => {
    const { db, queries } = fakeDb()

    await StreamContextReadRepository.listFeed(db, {
      ...filters,
      queryText: "budget",
      authorId: "usr_7",
      before: new Date("2026-07-01T00:00:00.000Z"),
      after: new Date("2026-06-01T00:00:00.000Z"),
      limit: 10,
    })

    const { text, values } = queries[0]!
    expect(text).toContain("sci.author_id =")
    expect(text).toContain("sci.occurred_at <")
    expect(text).toContain("sci.occurred_at >=")
    expect(text).toContain("lp.title ILIKE")
    expect(text).toContain("att.filename ILIKE")
    expect(text).toContain("mem.title ILIKE")
    expect(text).toContain("dt.title ILIKE")
    expect(text).toContain("sci.snippet ILIKE")
    expect(values).toContain("usr_7")
    expect(values).toContain("%budget%")
    const dates = values.filter((v) => v instanceof Date).map((v) => (v as Date).toISOString())
    expect(dates.slice(0, 2)).toEqual(["2026-07-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"])
  })

  it("maps a collapsed link row to the wire item, joining display data live", async () => {
    const { db } = fakeDb([dbRow()])

    const [item] = await StreamContextReadRepository.listFeed(db, { ...filters, limit: 10 })

    expect(item).toEqual({
      key: "link:https://example.com/a?utm_source=x:msg_1",
      category: "link",
      refKind: "url",
      refId: "https://example.com/a?utm_source=x",
      groupKey: "https://example.com/a",
      streamId: "stream_thread",
      sourceMessageId: "msg_1",
      authorId: "usr_1",
      occurredAt: "2026-07-20T10:00:00.000Z",
      sequence: "42",
      snippet: "look at this",
      occurrenceCount: 3,
      detail: {
        url: "https://example.com/a",
        title: "Example",
        description: "A page",
        siteName: "example.com",
        faviconUrl: "https://example.com/f.ico",
        imageUrl: "https://example.com/i.png",
        previewType: "github_pr",
        contentType: "website",
        previewStatus: "completed",
      },
      cursorOccurredAt: new Date("2026-07-20T10:00:00.000Z"),
      id: "sctx_1",
    })
  })

  it("maps a giphy media row from the stored detail when no attachment row exists", async () => {
    const { db } = fakeDb([
      dbRow({
        category: "media",
        ref_kind: "giphy",
        ref_id: "https://media.giphy.com/x.gif",
        group_key: "https://media.giphy.com/x.gif",
        detail: { giphyUrl: "https://media.giphy.com/x.gif", title: "dancing", width: 200, height: 100 },
        link_url: null,
        link_title: null,
        link_description: null,
        link_site_name: null,
        link_favicon_url: null,
        link_image_url: null,
        link_preview_type: null,
        link_content_type: null,
        link_status: null,
      }),
    ])

    const [item] = await StreamContextReadRepository.listFeed(db, { ...filters, limit: 10 })

    expect(item!.detail).toEqual({
      attachmentId: null,
      filename: null,
      mimeType: null,
      sizeBytes: null,
      width: 200,
      height: 100,
      mediaKind: "gif",
      giphyUrl: "https://media.giphy.com/x.gif",
      giphyTitle: "dancing",
    })
  })
})

describe("StreamContextReadRepository.countsByCategory", () => {
  it("counts distinct artifacts over the whole filtered scope, unpaged", async () => {
    const { db, queries } = fakeDb([
      { category: "link", count: 4 },
      { category: "media", count: 2 },
      { category: "not_a_category", count: 9 },
    ])

    const counts = await StreamContextReadRepository.countsByCategory(db, { ...filters, queryText: "budget" })

    expect(queries[0]!.text).toContain("COUNT(DISTINCT group_key)")
    expect(queries[0]!.text).not.toContain("ORDER BY")
    expect(queries[0]!.text).toContain("GROUP BY category")
    expect(queries[0]!.values).toContain("%budget%")
    expect(counts).toEqual({ link: 4, media: 2, file: 0, memo: 0, delegation: 0, thread: 0 })
  })
})

describe("StreamContextReadRepository.listOccurrences", () => {
  it("returns the uncollapsed rows for one group_key with the same keyset ordering", async () => {
    const { db, queries } = fakeDb([dbRow({ occurrence_count: 1 })])

    const [item] = await StreamContextReadRepository.listOccurrences(db, {
      workspaceId: "ws_1",
      rootStreamId: "stream_root",
      streamId: "stream_thread",
      scope: "tree",
      category: "link",
      groupKey: "https://example.com/a",
      cursor: { occurredAt: new Date("2026-07-19T00:00:00.000Z"), id: "sctx_9" },
      limit: 11,
    })

    const { text, values } = queries[0]!
    expect(text).toContain("sci.group_key =")
    expect(text).not.toContain("ROW_NUMBER()")
    expect(text).toContain("(occurred_at, id) <")
    expect(text).toContain("ORDER BY occurred_at DESC, id DESC")
    expect(values).toContain("https://example.com/a")
    expect(item!.occurrenceCount).toBe(1)
  })
})
