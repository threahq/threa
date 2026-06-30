import { beforeEach, describe, expect, it } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db, type CachedEvent } from "@/db"
import type { BoardViewPost } from "./use-stable-board-view"
import { useBoardCardMessages, __clearBoardRailRegistry } from "./use-board-card-messages"

const WS = "ws_1"
const STREAM = "stream_1"

function msgEvent(messageId: string, contentMarkdown: string, seq: number, streamId = STREAM): CachedEvent {
  return {
    id: `evt_${messageId}`,
    workspaceId: WS,
    streamId,
    sequence: String(seq),
    _sequenceNum: seq,
    eventType: "message_created",
    payload: { messageId, contentMarkdown, reactions: {} },
    actorId: "usr_1",
    actorType: "user",
    createdAt: new Date(seq).toISOString(),
    _cachedAt: seq,
  } as CachedEvent
}

function projectionMessage(id: string, streamId = STREAM) {
  return {
    id,
    streamId,
    authorId: "usr_1",
    authorType: "user" as const,
    contentMarkdown: `projection ${id}`,
    reactions: {},
    attachments: [],
    linkPreviews: [],
    createdAt: new Date(0).toISOString(),
  }
}

function makePost(opts: {
  messageIds: string[]
  openingId: string | null
  recentMessages?: ReturnType<typeof projectionMessage>[]
  /** Streams the card reads — defaults to the anchor stream only. */
  streamIds?: string[]
  /** Server-projected reply count; defaults to the flat/thread derivation. */
  totalReplies?: number
}): BoardViewPost {
  const { messageIds, openingId, recentMessages = [], streamIds = [STREAM] } = opts
  return {
    id: "conv_1",
    workspaceId: WS,
    _lastActivityMs: 0,
    _cachedAt: 0,
    streamIds,
    conversation: {
      id: "conv_1",
      streamId: STREAM,
      messageIds,
      lastActivityAt: new Date(0).toISOString(),
    },
    openingMessage: openingId ? projectionMessage(openingId) : null,
    recentMessages,
    totalReplies:
      opts.totalReplies ?? (openingId && messageIds[0] === openingId ? messageIds.length - 1 : messageIds.length),
  } as unknown as BoardViewPost
}

beforeEach(async () => {
  __clearBoardRailRegistry()
  await db.events.clear()
})

describe("useBoardCardMessages", () => {
  it("reads a flat conversation's replies live from db.events when the stream is synced", async () => {
    await db.events.bulkPut([
      msgEvent("m1", "the opening", 1),
      msgEvent("r1", "first reply", 2),
      msgEvent("r2", "second reply", 3),
    ])
    const post = makePost({ messageIds: ["m1", "r1", "r2"], openingId: "m1" })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.source).toBe("events"))
    expect(result.current.openingMessage?.contentMarkdown).toBe("the opening")
    expect(result.current.replies.map((m) => m.id)).toEqual(["r1", "r2"])
    expect(result.current.replies.map((m) => m.contentMarkdown)).toEqual(["first reply", "second reply"])
    expect(result.current.totalReplies).toBe(2)
  })

  it("merges a conversation that spans its root + a thread (one root) into one chronological run", async () => {
    const THREAD = "thr_2"
    await db.events.bulkPut([
      msgEvent("m1", "the opening", 1, STREAM),
      // The reply lives in a thread under the same root — a cross-stream member.
      msgEvent("r1", "thread reply", 2, THREAD),
    ])
    const post = makePost({
      messageIds: ["m1", "r1"],
      openingId: "m1",
      streamIds: [STREAM, THREAD],
      recentMessages: [projectionMessage("r1", THREAD)],
    })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.source).toBe("events"))
    expect(result.current.openingMessage?.contentMarkdown).toBe("the opening")
    // The thread member draws live from its own stream's rail, merged in by time.
    expect(result.current.replies.map((m) => m.id)).toEqual(["r1"])
    expect(result.current.replies[0]?.contentMarkdown).toBe("thread reply")
    expect(result.current.replies[0]?.streamId).toBe(THREAD)
    expect(result.current.totalReplies).toBe(1)
  })

  it("surfaces a pending optimistic reply tagged with its conversation, before the id lands in messageIds", async () => {
    await db.events.bulkPut([msgEvent("m1", "the opening", 1), msgEvent("r1", "first reply", 2)])
    // The viewer's just-sent reply: an optimistic pending event tagged with the
    // target conversation, not yet a member of the conversation's messageIds.
    await db.events.put({
      id: "temp_x",
      workspaceId: WS,
      streamId: STREAM,
      sequence: "3",
      _sequenceNum: 3,
      eventType: "message_created",
      payload: { messageId: "temp_x", contentMarkdown: "my pending reply", reactions: {}, conversationId: "conv_1" },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(3).toISOString(),
      _cachedAt: 3,
      _status: "pending",
    } as CachedEvent)

    const post = makePost({ messageIds: ["m1", "r1"], openingId: "m1" })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.pendingReplies.map((m) => m.id)).toEqual(["temp_x"]))
    expect(result.current.pendingReplies[0]?.contentMarkdown).toBe("my pending reply")
    // Optimistic, so it doesn't inflate the rail replies (not yet in messageIds).
    expect(result.current.replies.map((m) => m.id)).toEqual(["r1"])
  })

  it("keeps a reply continuously visible across the optimistic→echo→messageIds hand-off (no blink-out)", async () => {
    await db.events.bulkPut([msgEvent("m1", "the opening", 1), msgEvent("r1", "first reply", 2)])
    const post = makePost({ messageIds: ["m1", "r1"], openingId: "m1" })
    const { result, rerender } = renderHook((p: typeof post) => useBoardCardMessages(p), { initialProps: post })
    const shown = () => [...result.current.replies, ...result.current.pendingReplies].map((m) => m.id)

    // 1) Optimistic insert: the reply (tagged with its conversation, not yet in
    //    messageIds) shows immediately.
    await db.events.put({
      id: "temp_z",
      workspaceId: WS,
      streamId: STREAM,
      sequence: "1700000000000",
      _sequenceNum: 1700000000000,
      eventType: "message_created",
      payload: { messageId: "temp_z", contentMarkdown: "my reply", reactions: {}, conversationId: "conv_1" },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(3).toISOString(),
      _cachedAt: 3,
      _status: "pending",
    } as CachedEvent)
    await waitFor(() => expect(shown()).toContain("temp_z"))

    // 2) Server echo (stream-sync swap): the real event replaces the optimistic
    //    one, carrying the conversationId tag forward. messageIds hasn't updated
    //    yet — the reply must NOT disappear in this window.
    await db.transaction("rw", db.events, async () => {
      await db.events.put({
        id: "msg_real",
        workspaceId: WS,
        streamId: STREAM,
        sequence: "3",
        _sequenceNum: 3,
        eventType: "message_created",
        payload: { messageId: "msg_real", contentMarkdown: "my reply", reactions: {}, conversationId: "conv_1" },
        actorId: "usr_1",
        actorType: "user",
        createdAt: new Date(3).toISOString(),
        _cachedAt: 4,
      } as CachedEvent)
      await db.events.delete("temp_z")
    })
    await waitFor(() => expect(shown()).toContain("msg_real"))
    expect(shown()).not.toContain("temp_z")

    // 3) conversation:updated lands: messageIds now lists the real id. The reply
    //    renders via `replies` and is deduped out of `pendingReplies` (shown once).
    rerender(makePost({ messageIds: ["m1", "r1", "msg_real"], openingId: "m1" }))
    await waitFor(() => expect(result.current.replies.map((m) => m.id)).toEqual(["r1", "msg_real"]))
    expect(result.current.pendingReplies).toEqual([])
    expect(shown().filter((id) => id === "msg_real")).toHaveLength(1)
  })

  it("keeps a failed (mid-backoff) optimistic reply visible instead of blinking it out", async () => {
    await db.events.put({
      id: "temp_y",
      workspaceId: WS,
      streamId: STREAM,
      sequence: "2",
      _sequenceNum: 2,
      eventType: "message_created",
      payload: { messageId: "temp_y", contentMarkdown: "retrying reply", reactions: {}, conversationId: "conv_1" },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(2).toISOString(),
      _cachedAt: 2,
      // The queue marks the row `failed` between retry-backoff attempts; the reply
      // must stay on the card across that window, not vanish until the retry lands.
      _status: "failed",
    } as CachedEvent)

    const post = makePost({ messageIds: ["m1"], openingId: "m1" })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.pendingReplies.map((m) => m.id)).toEqual(["temp_y"]))
  })

  it("falls back to the cached projection when the stream isn't in IDB (cold/offline)", async () => {
    const post = makePost({
      messageIds: ["m1", "r1"],
      openingId: "m1",
      recentMessages: [projectionMessage("r1")],
    })
    const { result } = renderHook(() => useBoardCardMessages(post))

    // Stays on the projection — there are no events for this stream locally.
    await waitFor(() => expect(result.current.replies.length).toBe(1))
    expect(result.current.source).toBe("projection")
    expect(result.current.replies[0]?.contentMarkdown).toBe("projection r1")
    expect(result.current.openingMessage?.contentMarkdown).toBe("projection m1")
  })

  it("treats a thread conversation's parent opening as non-member: all messageIds are replies", async () => {
    // Thread: the opening (parent message) is NOT in messageIds; the thread's own
    // messages are the replies.
    await db.events.bulkPut([msgEvent("t1", "thread reply one", 5), msgEvent("t2", "thread reply two", 6)])
    const post = makePost({ messageIds: ["t1", "t2"], openingId: "parent_msg" })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.source).toBe("events"))
    expect(result.current.replies.map((m) => m.id)).toEqual(["t1", "t2"])
    expect(result.current.totalReplies).toBe(2)
    // The parent opening lives in another stream we don't scan — cached projection.
    expect(result.current.openingMessage?.contentMarkdown).toBe("projection parent_msg")
  })

  it("reflects a live edit to a reply (the events rail patches in place)", async () => {
    await db.events.bulkPut([msgEvent("m1", "opening", 1), msgEvent("r1", "before", 2)])
    const post = makePost({ messageIds: ["m1", "r1"], openingId: "m1" })
    const { result } = renderHook(() => useBoardCardMessages(post))
    await waitFor(() => expect(result.current.replies[0]?.contentMarkdown).toBe("before"))

    await db.events
      .where("[streamId+eventType]")
      .equals([STREAM, "message_created"])
      .filter((e) => (e.payload as { messageId?: string }).messageId === "r1")
      .modify((e) => {
        ;(e.payload as { contentMarkdown?: string }).contentMarkdown = "after"
      })

    await waitFor(() => expect(result.current.replies[0]?.contentMarkdown).toBe("after"))
  })

  it("does not resurrect stale projection bodies when the conversation's replies are all tombstoned in the rail", async () => {
    const del = msgEvent("r1", "stale body", 2)
    ;(del.payload as { deletedAt?: string }).deletedAt = new Date().toISOString()
    await db.events.bulkPut([msgEvent("m1", "opening", 1), del])
    // The cached projection still carries the pre-deletion body (a stale snapshot).
    const post = makePost({ messageIds: ["m1", "r1"], openingId: "m1", recentMessages: [projectionMessage("r1")] })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.source).toBe("events"))
    // The rail has seen r1 (as a tombstone), so the deleted body is gone, not
    // resurrected from the projection.
    expect(result.current.replies).toEqual([])
    expect(result.current.openingMessage?.contentMarkdown).toBe("opening")
  })

  it("keeps the cached preview for a conversation whose ids aren't in the synced window", async () => {
    // The stream is synced (has other messages) but NOT this conversation's — its
    // ids are genuinely unseen, so the projection preview must survive.
    await db.events.bulkPut([msgEvent("unrelated", "another conversation", 10)])
    const post = makePost({ messageIds: ["m1", "r1"], openingId: "m1", recentMessages: [projectionMessage("r1")] })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.replies.length).toBe(1))
    expect(result.current.source).toBe("projection")
    expect(result.current.replies[0]?.contentMarkdown).toBe("projection r1")
  })

  it("trusts the server reply count when a flat conversation's opening was deleted", async () => {
    // The opening (messageIds[0]) was deleted, so post.openingMessage is null and
    // openingId is unknown. The server already excluded it (totalReplies = 1); the
    // hook must not recount the missing opening as a reply (which would give 2).
    await db.events.bulkPut([msgEvent("r1", "a reply", 2)])
    const post = makePost({ messageIds: ["m1_deleted", "r1"], openingId: null, totalReplies: 1 })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.source).toBe("events"))
    expect(result.current.totalReplies).toBe(1)
    expect(result.current.replies.map((m) => m.id)).toEqual(["r1"])
  })

  it("does not count a tombstoned reply toward the total once the conversation is fully synced", async () => {
    // r1 deleted, r2 live; the whole conversation is in the rail. The deleted
    // reply is "seen" but not displayable, so totalReplies must be 1 (not 2) —
    // otherwise the card shows a phantom "1 more message" gap for nothing hidden.
    const del = msgEvent("r1", "gone", 2)
    ;(del.payload as { deletedAt?: string }).deletedAt = new Date().toISOString()
    await db.events.bulkPut([msgEvent("m1", "opening", 1), del, msgEvent("r2", "here", 3)])
    const post = makePost({ messageIds: ["m1", "r1", "r2"], openingId: "m1" })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.source).toBe("events"))
    expect(result.current.replies.map((m) => m.id)).toEqual(["r2"])
    expect(result.current.totalReplies).toBe(1)
  })

  it("excludes soft-deleted messages from the rail", async () => {
    const deleted = msgEvent("r1", "gone", 2)
    ;(deleted.payload as { deletedAt?: string }).deletedAt = new Date().toISOString()
    await db.events.bulkPut([msgEvent("m1", "opening", 1), deleted, msgEvent("r2", "here", 3)])
    const post = makePost({ messageIds: ["m1", "r1", "r2"], openingId: "m1" })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.source).toBe("events"))
    expect(result.current.replies.map((m) => m.id)).toEqual(["r2"])
  })
})
