import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import type { StreamContextItem } from "@threa/types"
import { contextItemsFromEvent } from "@/lib/stream-context/rows"
import type { CachedEvent } from "@/db"
import {
  deleteContextRowsForMessage,
  putLocalContextRows,
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
    expect(await db.streamContextItems.get(local[0].key)).toMatchObject({
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

    const row = await db.streamContextItems.get(local[0].key)
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

    const { result } = renderHook(() => useStreamContextOccurrences(WORKSPACE_ID, ROOT, "link:https://example.com/a"))
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.map((r) => r.key)).toEqual(["link:a:msg_2", "link:a:msg_1"])
  })

  it("scopes occurrences to the current workspace and root", async () => {
    await seedStreamContextItems(WORKSPACE_ID, ROOT, [serverItem({ key: "link:a:msg_1" })])
    await seedStreamContextItems("ws_other", ROOT, [serverItem({ key: "link:a:msg_other" })])
    await seedStreamContextItems(WORKSPACE_ID, "stream_other_root", [
      serverItem({ key: "link:a:msg_root2", streamId: "stream_other_root" }),
    ])

    const { result } = renderHook(() => useStreamContextOccurrences(WORKSPACE_ID, ROOT, "link:https://example.com/a"))
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.map((r) => r.key)).toEqual(["link:a:msg_1"])
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

    expect(await db.streamContextItems.get("link:a:msg_1")).toMatchObject({
      streamId: "stream_thread",
      rootStreamId: ROOT,
    })
    expect(await db.streamContextItems.get("link:a:msg_2")).toMatchObject({ streamId: ROOT })
  })
})
