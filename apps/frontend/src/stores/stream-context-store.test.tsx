import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import type { StreamContextItem } from "@threahq/types"
import { contextItemsFromEvent } from "@/lib/stream-context/rows"
import type { CachedEvent } from "@/db"
import {
  deleteContextRowsForMessage,
  putLocalContextRows,
  readStreamContextRows,
  reparentContextRows,
  replaceContextRowsForMessage,
  seedStreamContextItems,
  useStreamContextOccurrences,
  useStreamContextRows,
} from "./stream-context-store"

const WORKSPACE_ID = "ws_1"
const ROOT = "stream_root"

function serverItem(overrides: Partial<StreamContextItem> & { key: string }): StreamContextItem {
  return {
    category: "link",
    refKind: "url",
    anchorEventId: null,
    refId: "https://example.com/a",
    groupKey: "https://example.com/a",
    streamId: ROOT,
    sourceMessageId: "msg_1",
    authorId: "usr_1",
    occurredAt: "2026-07-01T10:00:00.000Z",
    sequence: "1",
    snippet: "hi",
    occurrenceCount: 1,
    detail: {
      url: "https://example.com/a",
      title: null,
      description: null,
      siteName: null,
      faviconUrl: null,
      imageUrl: null,
      previewType: null,
      contentType: null,
      previewStatus: null,
    },
    ...overrides,
  }
}

function messageEvent(messageId: string, href: string, createdAt: string, streamId = ROOT): CachedEvent {
  return {
    id: `event_${messageId}`,
    workspaceId: WORKSPACE_ID,
    streamId,
    sequence: "1",
    _sequenceNum: 1,
    eventType: "message_created",
    payload: {
      messageId,
      contentMarkdown: "hi",
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] }] },
        ],
      },
    },
    actorId: "usr_1",
    actorType: "user",
    createdAt,
    _cachedAt: 0,
  }
}

describe("stream-context-store", () => {
  beforeEach(async () => {
    await db.streamContextItems.clear()
  })

  it("live-reads seeded rows newest first, scoped to the root's tree", async () => {
    await seedStreamContextItems(WORKSPACE_ID, ROOT, [
      serverItem({ key: "link:a:msg_1", refId: "a", groupKey: "a", occurredAt: "2026-07-01T10:00:00.000Z" }),
      serverItem({
        key: "link:b:msg_2",
        refId: "b",
        groupKey: "b",
        occurredAt: "2026-07-02T10:00:00.000Z",
        streamId: "stream_thread",
      }),
    ])

    const { result } = renderHook(() => useStreamContextRows(WORKSPACE_ID, ROOT, ROOT, "tree"))
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.map((r) => r.key)).toEqual(["link:b:msg_2", "link:a:msg_1"])

    // `stream` scope sees only the rows filed on that stream.
    const streamScope = renderHook(() => useStreamContextRows(WORKSPACE_ID, ROOT, ROOT, "stream"))
    await waitFor(() => expect(streamScope.result.current).toBeDefined())
    expect(streamScope.result.current?.map((r) => r.key)).toEqual(["link:a:msg_1"])
  })

  it("resolves to [] for an empty store rather than staying in loading", async () => {
    const { result } = renderHook(() => useStreamContextRows(WORKSPACE_ID, ROOT, ROOT, "tree"))
    await waitFor(() => expect(result.current).toEqual([]))
  })

  it("collapses a local row and the server's row for the same key, keeping the server's groupKey", async () => {
    const local = contextItemsFromEvent(messageEvent("msg_1", "https://Example.com/a/", "2026-07-01T10:00:00.000Z"), {
      workspaceId: WORKSPACE_ID,
      streamId: ROOT,
      rootStreamId: ROOT,
    })
    await putLocalContextRows(local)
    expect(await db.streamContextItems.get([WORKSPACE_ID, local[0].key])).toMatchObject({
      _status: "pending",
      groupKey: "https://Example.com/a/",
    })

    await seedStreamContextItems(WORKSPACE_ID, ROOT, [
      serverItem({
        key: local[0].key,
        refId: "https://Example.com/a/",
        groupKey: "https://example.com/a",
        detail: { title: "Example", url: "https://Example.com/a/" } as StreamContextItem["detail"],
      }),
    ])

    const rows = await db.streamContextItems.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      groupKey: "https://example.com/a",
      groupRef: "link:https://example.com/a",
    })
    expect(rows[0]._status).toBeUndefined()
  })

  it("does not let a re-derived local row overwrite the reconciled server row", async () => {
    const local = contextItemsFromEvent(messageEvent("msg_1", "https://Example.com/a/", "2026-07-01T10:00:00.000Z"), {
      workspaceId: WORKSPACE_ID,
      streamId: ROOT,
      rootStreamId: ROOT,
    })
    await seedStreamContextItems(WORKSPACE_ID, ROOT, [
      serverItem({
        key: local[0].key,
        refId: "https://Example.com/a/",
        groupKey: "https://example.com/a",
        detail: { title: "Example", url: "https://Example.com/a/" } as StreamContextItem["detail"],
      }),
    ])

    // Event replay (catch-up, gate resume) re-derives the same local row.
    await putLocalContextRows(local)

    const row = await db.streamContextItems.get([WORKSPACE_ID, local[0].key])
    expect(row).toMatchObject({ groupKey: "https://example.com/a", detail: { title: "Example" } })
    expect(row?._status).toBeUndefined()
  })

  it("keeps reconciled fields across an edit's replace, and drops only what the edit removed", async () => {
    await seedStreamContextItems(WORKSPACE_ID, ROOT, [
      serverItem({
        key: "link:https://example.com/a:msg_1",
        groupKey: "https://example.com/a",
        detail: { title: "Example", url: "https://example.com/a" } as StreamContextItem["detail"],
      }),
      serverItem({
        key: "link:https://example.com/gone:msg_1",
        refId: "https://example.com/gone",
        groupKey: "https://example.com/gone",
      }),
    ])

    // The edit keeps the first link and adds a new one; the second is gone.
    const rebuilt = contextItemsFromEvent(messageEvent("msg_1", "https://example.com/a", "2026-07-01T10:00:00.000Z"), {
      workspaceId: WORKSPACE_ID,
      streamId: ROOT,
      rootStreamId: ROOT,
    })
    await replaceContextRowsForMessage(WORKSPACE_ID, "msg_1", rebuilt)

    const rows = await db.streamContextItems.toArray()
    expect(
      rows.map((r) => ({ key: r.key, groupKey: r.groupKey, title: (r.detail as { title?: string }).title }))
    ).toEqual([{ key: "link:https://example.com/a:msg_1", groupKey: "https://example.com/a", title: "Example" }])
  })

  it("lists every occurrence of a group, newest first", async () => {
    await seedStreamContextItems(WORKSPACE_ID, ROOT, [
      serverItem({ key: "link:a:msg_1", occurredAt: "2026-07-01T10:00:00.000Z" }),
      serverItem({ key: "link:a:msg_2", sourceMessageId: "msg_2", occurredAt: "2026-07-03T10:00:00.000Z" }),
      serverItem({ key: "link:z:msg_3", refId: "z", groupKey: "z", sourceMessageId: "msg_3" }),
    ])

    const { result } = renderHook(() =>
      useStreamContextOccurrences(WORKSPACE_ID, ROOT, ROOT, "tree", "link:https://example.com/a")
    )
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.map((r) => r.key)).toEqual(["link:a:msg_2", "link:a:msg_1"])
  })

  it("scopes occurrences to the current workspace and root", async () => {
    await seedStreamContextItems(WORKSPACE_ID, ROOT, [serverItem({ key: "link:a:msg_1" })])
    await seedStreamContextItems("ws_other", ROOT, [serverItem({ key: "link:a:msg_other" })])
    await seedStreamContextItems(WORKSPACE_ID, "stream_other_root", [
      serverItem({ key: "link:a:msg_root2", streamId: "stream_other_root" }),
    ])

    const { result } = renderHook(() =>
      useStreamContextOccurrences(WORKSPACE_ID, ROOT, ROOT, "tree", "link:https://example.com/a")
    )
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.map((r) => r.key)).toEqual(["link:a:msg_1"])
  })

  it("narrows occurrences to one thread under stream scope", async () => {
    await seedStreamContextItems(WORKSPACE_ID, ROOT, [
      serverItem({ key: "link:a:msg_1" }),
      serverItem({ key: "link:a:msg_t", sourceMessageId: "msg_t", streamId: "stream_thread" }),
    ])

    const { result } = renderHook(() =>
      useStreamContextOccurrences(WORKSPACE_ID, "stream_thread", ROOT, "stream", "link:https://example.com/a")
    )
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.map((r) => r.key)).toEqual(["link:a:msg_t"])
  })

  it("keeps a thread landmark anchored on an edited message", async () => {
    await seedStreamContextItems(WORKSPACE_ID, ROOT, [
      serverItem({ key: "link:https://example.com/a:msg_1" }),
      serverItem({
        key: "thread:stream_t1:msg_1",
        category: "thread",
        refKind: "thread",
        refId: "stream_t1",
        groupKey: "stream_t1",
        detail: { name: "Thread", replyCount: 2, lastReplyAt: null, anchorEventId: null },
      }),
    ])

    // Edited to drop the link entirely.
    await replaceContextRowsForMessage(WORKSPACE_ID, "msg_1", [])

    expect((await db.streamContextItems.toArray()).map((r) => r.key)).toEqual(["thread:stream_t1:msg_1"])
  })

  it("deletes every row a message contributed", async () => {
    await seedStreamContextItems(WORKSPACE_ID, ROOT, [
      serverItem({ key: "link:a:msg_1" }),
      serverItem({ key: "media:b:msg_1", category: "media", refKind: "attachment", refId: "b", groupKey: "b" }),
      serverItem({ key: "link:a:msg_2", sourceMessageId: "msg_2" }),
    ])
    await deleteContextRowsForMessage(WORKSPACE_ID, "msg_1")
    expect((await db.streamContextItems.toArray()).map((r) => r.key)).toEqual(["link:a:msg_2"])
  })

  it("re-homes moved messages' rows onto the destination thread", async () => {
    await seedStreamContextItems(WORKSPACE_ID, ROOT, [
      serverItem({ key: "link:a:msg_1" }),
      serverItem({ key: "link:a:msg_2", sourceMessageId: "msg_2" }),
    ])
    await reparentContextRows(WORKSPACE_ID, ["msg_1"], "stream_thread", ROOT)

    expect(await db.streamContextItems.get([WORKSPACE_ID, "link:a:msg_1"])).toMatchObject({
      streamId: "stream_thread",
      rootStreamId: ROOT,
    })
    expect(await db.streamContextItems.get([WORKSPACE_ID, "link:a:msg_2"])).toMatchObject({ streamId: ROOT })
  })
})

describe("stream-context-store workspace isolation — a copied stream keeps its message ids and context keys in the partner workspace", () => {
  const KEY = "link:https://example.com/a:msg_1"

  beforeEach(async () => {
    await db.streamContextItems.clear()
  })

  function localRows(workspaceId: string) {
    return contextItemsFromEvent(
      { ...messageEvent("msg_1", "https://example.com/a", "2026-07-01T10:00:00.000Z"), workspaceId },
      { workspaceId, streamId: ROOT, rootStreamId: ROOT }
    )
  }

  async function rowsByWorkspace() {
    return (await db.streamContextItems.toArray()).map((row) => ({
      workspaceId: row.workspaceId,
      key: row.key,
      status: row._status,
      snippet: row.snippet,
    }))
  }

  it("writes a pending local row in one workspace even when the other workspace holds the same key reconciled", async () => {
    await seedStreamContextItems("ws_a", ROOT, [serverItem({ key: KEY, snippet: "reconciled in a" })])

    await putLocalContextRows(localRows("ws_b"))

    expect(await rowsByWorkspace()).toEqual([
      { workspaceId: "ws_a", key: KEY, status: undefined, snippet: "reconciled in a" },
      { workspaceId: "ws_b", key: KEY, status: "pending", snippet: "hi" },
    ])
  })

  it("rebuilds a message's rows in its own workspace only, dropping a removed link there alone", async () => {
    await seedStreamContextItems("ws_a", ROOT, [serverItem({ key: KEY, snippet: "in a" })])
    await seedStreamContextItems("ws_b", ROOT, [serverItem({ key: KEY, snippet: "in b" })])

    await replaceContextRowsForMessage("ws_a", "msg_1", [])

    expect(await rowsByWorkspace()).toEqual([{ workspaceId: "ws_b", key: KEY, status: undefined, snippet: "in b" }])
  })

  it("deletes and re-homes a message's rows in its own workspace only", async () => {
    await seedStreamContextItems("ws_a", ROOT, [serverItem({ key: KEY })])
    await seedStreamContextItems("ws_b", ROOT, [serverItem({ key: KEY })])

    await reparentContextRows("ws_a", ["msg_1"], "stream_thread", ROOT)
    const afterReparent = (await db.streamContextItems.toArray()).map((row) => ({
      workspaceId: row.workspaceId,
      streamId: row.streamId,
    }))
    await deleteContextRowsForMessage("ws_b", "msg_1")
    const afterDelete = (await db.streamContextItems.toArray()).map((row) => row.workspaceId)

    expect({ afterReparent, afterDelete }).toEqual({
      afterReparent: [
        { workspaceId: "ws_a", streamId: "stream_thread" },
        { workspaceId: "ws_b", streamId: ROOT },
      ],
      afterDelete: ["ws_a"],
    })
  })

  it("reads the feed and a group's occurrences of one workspace when the root and keys are shared with another", async () => {
    await seedStreamContextItems("ws_a", ROOT, [serverItem({ key: KEY, snippet: "in a" })])
    await seedStreamContextItems("ws_b", ROOT, [serverItem({ key: KEY, snippet: "in b" })])

    const tree = renderHook(() => useStreamContextRows("ws_b", ROOT, ROOT, "tree"))
    const stream = renderHook(() => useStreamContextRows("ws_b", ROOT, ROOT, "stream"))
    const occurrences = renderHook(() =>
      useStreamContextOccurrences("ws_b", ROOT, ROOT, "tree", "link:https://example.com/a")
    )
    await waitFor(() => {
      expect(tree.result.current).toBeDefined()
      expect(stream.result.current).toBeDefined()
      expect(occurrences.result.current).toBeDefined()
    })

    expect({
      tree: tree.result.current?.map((row) => row.snippet),
      stream: stream.result.current?.map((row) => row.snippet),
      occurrences: occurrences.result.current?.map((row) => row.snippet),
      oneShotTree: (await readStreamContextRows("ws_b", ROOT, ROOT, "tree")).map((row) => row.snippet),
      oneShotStream: (await readStreamContextRows("ws_b", ROOT, ROOT, "stream")).map((row) => row.snippet),
    }).toEqual({
      tree: ["in b"],
      stream: ["in b"],
      occurrences: ["in b"],
      oneShotTree: ["in b"],
      oneShotStream: ["in b"],
    })
  })

  it("returns undefined from the feed and the occurrences in the render after the workspace changes, until the new workspace's rows resolve", async () => {
    await seedStreamContextItems("ws_a", ROOT, [serverItem({ key: KEY, snippet: "in a" })])
    await seedStreamContextItems("ws_b", ROOT, [serverItem({ key: KEY, snippet: "in b" })])

    const { result, rerender } = renderHook(
      ({ workspaceId }) => ({
        feed: useStreamContextRows(workspaceId, ROOT, ROOT, "tree"),
        occurrences: useStreamContextOccurrences(workspaceId, ROOT, ROOT, "tree", "link:https://example.com/a"),
      }),
      { initialProps: { workspaceId: "ws_a" } }
    )
    const snippets = () => ({
      feed: result.current.feed?.map((row) => row.snippet),
      occurrences: result.current.occurrences?.map((row) => row.snippet),
    })
    await waitFor(() => expect(snippets()).toEqual({ feed: ["in a"], occurrences: ["in a"] }))

    rerender({ workspaceId: "ws_b" })
    const rightAfterSwitch = snippets()
    await waitFor(() => expect(snippets()).toEqual({ feed: ["in b"], occurrences: ["in b"] }))

    expect({ rightAfterSwitch, settled: snippets() }).toEqual({
      rightAfterSwitch: { feed: undefined, occurrences: undefined },
      settled: { feed: ["in b"], occurrences: ["in b"] },
    })
  })
})
