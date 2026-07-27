import { describe, expect, it } from "vitest"
import type { CachedStreamContextItem } from "@/db"
import { collapseContextRows, countByCategory, filterContextRows } from "./filter"

function row(overrides: Partial<CachedStreamContextItem> = {}): CachedStreamContextItem {
  const category = overrides.category ?? "link"
  const groupKey = overrides.groupKey ?? "https://a.example"
  return {
    key: `${category}:${groupKey}:${overrides.sourceMessageId ?? "msg_1"}`,
    workspaceId: "ws_1",
    streamId: "stream_1",
    rootStreamId: "stream_1",
    category,
    refKind: "url",
    refId: groupKey,
    groupKey,
    groupRef: `${category}:${groupKey}`,
    sourceMessageId: "msg_1",
    authorId: "usr_1",
    occurredAt: "2026-06-24T10:00:00.000Z",
    sequence: "1",
    snippet: "",
    occurrenceCount: 1,
    detail: {},
    _cachedAt: 0,
    ...overrides,
  } as CachedStreamContextItem
}

describe("filterContextRows date bounds", () => {
  // The endpoint is `occurred_at >= after` and `occurred_at < before`; phase 1
  // has to match on the boundary instant or a row flickers out until the server
  // page lands.
  it("keeps a row exactly on the after bound and drops one exactly on before", () => {
    const onBound = row({ occurredAt: "2026-06-24T10:00:00.000Z" })

    expect(filterContextRows([onBound], { after: "2026-06-24T10:00:00.000Z" })).toEqual([onBound])
    expect(filterContextRows([onBound], { before: "2026-06-24T10:00:00.000Z" })).toEqual([])
  })
})

describe("collapseContextRows", () => {
  it("keeps one row per group, represented by its newest occurrence", () => {
    const older = row({ sourceMessageId: "msg_a", occurredAt: "2026-06-20T10:00:00.000Z", snippet: "first" })
    const newer = row({ sourceMessageId: "msg_b", occurredAt: "2026-06-24T10:00:00.000Z", snippet: "latest" })

    const collapsed = collapseContextRows([newer, older])

    expect(collapsed.map((r) => r.snippet)).toEqual(["latest"])
    expect(collapsed[0].occurrenceCount).toBe(2)
  })

  it("never under-reports a partially cached group", () => {
    const collapsed = collapseContextRows([row({ occurrenceCount: 7 })])
    expect(collapsed[0].occurrenceCount).toBe(7)
  })

  it("keeps distinct groups apart, including same refId in another category", () => {
    const collapsed = collapseContextRows([
      row({ groupKey: "https://a.example" }),
      row({ groupKey: "https://b.example" }),
      row({ category: "media", groupKey: "https://a.example" }),
    ])
    expect(collapsed).toHaveLength(3)
  })

  it("counts a repeatedly shared link once per category", () => {
    const counts = countByCategory(
      collapseContextRows([row({ sourceMessageId: "msg_a" }), row({ sourceMessageId: "msg_b" })])
    )
    expect(counts.link).toBe(1)
  })

  it("collapses the filtered set, not the raw one", () => {
    const rows = [
      row({ sourceMessageId: "msg_a", authorId: "usr_1" }),
      row({ sourceMessageId: "msg_b", authorId: "usr_2" }),
    ]
    const collapsed = collapseContextRows(filterContextRows(rows, { authorId: "usr_2" }))
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].occurrenceCount).toBe(1)
  })
})
