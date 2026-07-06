import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db, type CachedEvent } from "@/db"
import { createDraftPanelId } from "@/contexts/panel-context"
import type { BoardViewPost } from "./use-stable-board-view"
import {
  useBoardCardMessages,
  useStableReplyWindow,
  __clearBoardRailRegistry,
  __boardRailRegistrySize,
  type BoardCardMessages,
} from "./use-board-card-messages"
import type { RenderableMessage } from "@/components/message/message-item"

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
  await db.streams.clear()
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
    const THREAD = "stream_thread2"
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

  it("subscribes to a thread resolved from db.streams even before it lands in the post's streamIds (no convert blink)", async () => {
    const THREAD = "stream_threadblink"
    // The thread off the opener exists in db.streams (created at promotion) but the
    // server projection's streamIds hasn't widened yet (message_assigned lags).
    await db.streams.put({
      id: THREAD,
      workspaceId: WS,
      type: "thread",
      parentMessageId: "m1",
      rootStreamId: STREAM,
      parentStreamId: STREAM,
    } as never)
    await db.events.bulkPut([msgEvent("m1", "the opening", 1, STREAM), msgEvent("r1", "thread reply", 2, THREAD)])
    const post = makePost({ messageIds: ["m1", "r1"], openingId: "m1", streamIds: [STREAM] })
    const { result } = renderHook(() => useBoardCardMessages(post))

    // The reply draws live from the discovered thread rail despite streamIds=[STREAM].
    await waitFor(() => expect(result.current.replies.map((m) => m.id)).toEqual(["r1"]))
    expect(result.current.replies[0]?.streamId).toBe(THREAD)
  })

  it("keeps rendering live events when a discovered thread is present but unsynced (no projection flip)", async () => {
    const THREAD = "stream_threadunsynced"
    // A thread off the opener exists in db.streams but has no events synced yet —
    // a discovered (non-gating) rail. The root rail IS synced, so the card must
    // keep its live view instead of flipping back to the projection.
    await db.streams.put({
      id: THREAD,
      workspaceId: WS,
      type: "thread",
      parentMessageId: "m1",
      rootStreamId: STREAM,
      parentStreamId: STREAM,
    } as never)
    await db.events.bulkPut([msgEvent("m1", "the opening", 1, STREAM), msgEvent("r1", "root reply", 2, STREAM)])
    const post = makePost({
      messageIds: ["m1", "r1"],
      openingId: "m1",
      streamIds: [STREAM],
      recentMessages: [projectionMessage("r1")],
    })
    const { result } = renderHook(() => useBoardCardMessages(post))

    await waitFor(() => expect(result.current.source).toBe("events"))
    expect(result.current.replies.map((m) => m.id)).toEqual(["r1"])
    expect(result.current.replies[0]?.contentMarkdown).toBe("root reply")
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

  it("bridges a convert-to-thread reply across the swap (no blink / no '1 more') until the real row renders", async () => {
    // Lone root post; the opener is synced in the root stream.
    await db.events.bulkPut([msgEvent("m1", "the opening", 1, STREAM)])
    const lone = makePost({ messageIds: ["m1"], openingId: "m1", streamIds: [STREAM] })
    const { result, rerender } = renderHook((p: BoardViewPost) => useBoardCardMessages(p, "channel"), {
      initialProps: lone,
    })

    // 1) Optimistic convert reply: tagged with the conversation, written under the
    //    draft-thread panel (a stream the card watches for a lone threadable post).
    const PANEL = "draft:" + STREAM + ":m1"
    await db.events.put({
      id: "temp_c",
      workspaceId: WS,
      streamId: PANEL,
      sequence: "1700000000001",
      _sequenceNum: 1700000000001,
      eventType: "message_created",
      payload: { messageId: "temp_c", contentMarkdown: "my convert reply", reactions: {}, conversationId: "conv_1" },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(3).toISOString(),
      _cachedAt: 3,
      _status: "pending",
    } as CachedEvent)
    // The card must subscribe to the draft panel for a lone channel post.
    rerender({ ...lone } as BoardViewPost)
    await waitFor(() =>
      expect([...result.current.replies, ...result.current.pendingReplies].map((m) => m.id)).toContain("temp_c")
    )

    // 2) The swap deletes the optimistic row (it moved to the real thread stream,
    //    which the card isn't subscribed to yet) AND messageIds now lists the real
    //    id — the gap where it belongs to no rail. The reply must NOT blink out and
    //    must NOT collapse under a "1 more" gap.
    await db.events.delete("temp_c")
    rerender(makePost({ messageIds: ["m1", "msg_real_c"], openingId: "m1", streamIds: [STREAM] }))
    await waitFor(() => expect(result.current.replies.map((m) => m.contentMarkdown)).toEqual(["my convert reply"]))
    expect(result.current.totalReplies).toBe(1)
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

// Frame-recording stability suite: every committed render is captured, so a
// transient regression (a projection flash, a reply blinking out for one frame)
// fails the test even though a final `waitFor` would have settled past it.
describe("useBoardCardMessages stability (no flicker, no hiding)", () => {
  function renderRecorded(initial: BoardViewPost, hostStreamType?: string) {
    const frames: BoardCardMessages[] = []
    const rendered = renderHook(
      (p: BoardViewPost) => {
        const view = useBoardCardMessages(p, hostStreamType)
        frames.push(view)
        return view
      },
      { initialProps: initial }
    )
    return { frames, ...rendered }
  }

  const shownBodies = (v: BoardCardMessages) => [...v.replies, ...v.pendingReplies].map((m) => m.contentMarkdown)

  it("never regresses to the projection when streamIds widen over an already-live thread", async () => {
    const THREAD = "stream_assign_churn"
    await db.streams.put({
      id: THREAD,
      workspaceId: WS,
      type: "thread",
      parentMessageId: "m1",
      rootStreamId: STREAM,
      parentStreamId: STREAM,
    } as never)
    await db.events.bulkPut([msgEvent("m1", "the opening", 1, STREAM), msgEvent("r1", "thread reply", 2, THREAD)])
    // No recentMessages naming THREAD: the thread must enter via db.streams
    // discovery (an EXTRA rail) so the widen below genuinely moves it into the
    // gating set and re-subscribes — a preview row would make it gating from the
    // first render and the test would never exercise the churn.
    const before = makePost({ messageIds: ["m1", "r1"], openingId: "m1", streamIds: [STREAM] })
    const { frames, result, rerender } = renderRecorded(before)
    await waitFor(() => expect(result.current.replies.map((m) => m.contentMarkdown)).toEqual(["thread reply"]))
    const from = frames.length

    // conversation:message_assigned lands: the thread moves from a discovered
    // (extra) rail to a server-known (gating) one. The re-subscription must not
    // tear the live rails down and flash the stale projection bodies.
    rerender(makePost({ messageIds: ["m1", "r1"], openingId: "m1", streamIds: [STREAM, THREAD] }))
    await waitFor(() => expect(result.current.replies.map((m) => m.contentMarkdown)).toEqual(["thread reply"]))

    for (const frame of frames.slice(from)) {
      expect(frame.source).toBe("events")
      expect(frame.replies.map((m) => m.contentMarkdown)).toEqual(["thread reply"])
      expect(frame.openingMessage?.contentMarkdown).toBe("the opening")
    }
  })

  it("keeps the first reply and the opening visible through every frame of the convert-to-thread hand-off", async () => {
    const THREAD = "stream_convert_thread"
    const PANEL = createDraftPanelId(STREAM, "m1")
    await db.events.bulkPut([msgEvent("m1", "the opening", 1, STREAM)])
    const lone = makePost({ messageIds: ["m1"], openingId: "m1", streamIds: [STREAM] })
    const { frames, result, rerender } = renderRecorded(lone, "channel")
    await waitFor(() => expect(result.current.source).toBe("events"))

    // 1) The viewer's optimistic convert reply, tagged, under the draft panel.
    await db.events.put({
      id: "temp_c",
      workspaceId: WS,
      streamId: PANEL,
      sequence: "1700000000001",
      _sequenceNum: 1700000000001,
      eventType: "message_created",
      payload: { messageId: "temp_c", contentMarkdown: "my convert reply", reactions: {}, conversationId: "conv_1" },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(3).toISOString(),
      _cachedAt: 3,
      _status: "pending",
    } as CachedEvent)
    await waitFor(() => expect(shownBodies(result.current)).toEqual(["my convert reply"]))
    const from = frames.length

    // 2) Promotion: the real thread stream exists; the optimistic event moves from
    //    the draft panel onto it (use-message-queue promoteDraft).
    await db.streams.put({
      id: THREAD,
      workspaceId: WS,
      type: "thread",
      parentMessageId: "m1",
      rootStreamId: STREAM,
      parentStreamId: STREAM,
    } as never)
    const optimistic = await db.events.get("temp_c")
    await db.events.put({ ...optimistic!, streamId: THREAD })
    await waitFor(() => expect(shownBodies(result.current)).toEqual(["my convert reply"]))

    // 3) Server echo (stream-sync swap): real event replaces the optimistic one in
    //    one transaction, tag carried forward. The echo names its optimistic twin
    //    via clientMessageId — that's how handleMessageCreated finds the temp row,
    //    and how the card suppresses a stale rail's leftover copy of it.
    await db.transaction("rw", db.events, async () => {
      await db.events.put({
        id: "msg_real_c",
        workspaceId: WS,
        streamId: THREAD,
        sequence: "2",
        _sequenceNum: 2,
        eventType: "message_created",
        payload: {
          messageId: "msg_real_c",
          contentMarkdown: "my convert reply",
          reactions: {},
          conversationId: "conv_1",
          clientMessageId: "temp_c",
        },
        actorId: "usr_1",
        actorType: "user",
        createdAt: new Date(4).toISOString(),
        _cachedAt: 4,
      } as CachedEvent)
      await db.events.delete("temp_c")
    })
    await waitFor(() =>
      expect([...result.current.replies, ...result.current.pendingReplies].map((m) => m.id)).toEqual(["msg_real_c"])
    )

    // 4) conversation:updated widens messageIds (drops the draft panel from the
    //    card's watched set) …
    rerender(makePost({ messageIds: ["m1", "msg_real_c"], openingId: "m1", streamIds: [STREAM] }))
    await waitFor(() => expect(result.current.replies.map((m) => m.id)).toEqual(["msg_real_c"]))

    // 5) … then conversation:message_assigned widens streamIds over the thread.
    rerender(makePost({ messageIds: ["m1", "msg_real_c"], openingId: "m1", streamIds: [STREAM, THREAD] }))
    await waitFor(() => expect(result.current.replies.map((m) => m.id)).toEqual(["msg_real_c"]))

    // The reply body renders in EVERY frame (exactly once — no double-render at
    // the echo hand-off), and the opening never flashes back to the projection.
    for (const frame of frames.slice(from)) {
      expect(frame.source).toBe("events")
      expect(shownBodies(frame)).toEqual(["my convert reply"])
      expect(frame.openingMessage?.contentMarkdown).toBe("the opening")
    }
  })

  it("never doubles a reply while its optimistic row and server echo are both visible", async () => {
    // The deterministic form of a race the liveQuery rails can produce: the echo
    // swap (put real + delete temp, one transaction) is atomic PER RAIL, but a
    // card merges several independent rails — the draft-panel rail can still be
    // on its pre-swap snapshot (temp row present) when the reply stream's rail
    // already shows the echo. Model that window literally: both rows in IDB at
    // once. The echo's clientMessageId names the temp row, so the card must
    // render the reply exactly once throughout.
    const PANEL = createDraftPanelId(STREAM, "m1")
    await db.events.bulkPut([msgEvent("m1", "the opening", 1, STREAM)])
    const lone = makePost({ messageIds: ["m1"], openingId: "m1", streamIds: [STREAM] })
    const { frames, result } = renderRecorded(lone, "channel")
    await waitFor(() => expect(result.current.source).toBe("events"))

    await db.events.put({
      id: "temp_d",
      workspaceId: WS,
      streamId: PANEL,
      sequence: "1700000000003",
      _sequenceNum: 1700000000003,
      eventType: "message_created",
      payload: { messageId: "temp_d", contentMarkdown: "my doubled reply", reactions: {}, conversationId: "conv_1" },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(3).toISOString(),
      _cachedAt: 3,
      _status: "pending",
    } as CachedEvent)
    await waitFor(() => expect(shownBodies(result.current)).toEqual(["my doubled reply"]))
    const from = frames.length

    // Echo lands on the anchor stream while the temp row still exists.
    await db.events.put({
      id: "msg_real_d",
      workspaceId: WS,
      streamId: STREAM,
      sequence: "2",
      _sequenceNum: 2,
      eventType: "message_created",
      payload: {
        messageId: "msg_real_d",
        contentMarkdown: "my doubled reply",
        reactions: {},
        conversationId: "conv_1",
        clientMessageId: "temp_d",
      },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(4).toISOString(),
      _cachedAt: 4,
    } as CachedEvent)
    await waitFor(() =>
      expect([...result.current.replies, ...result.current.pendingReplies].map((m) => m.id)).toEqual(["msg_real_d"])
    )

    // The swap's delete finally lands; nothing on screen may move.
    await db.events.delete("temp_d")
    await waitFor(() =>
      expect([...result.current.replies, ...result.current.pendingReplies].map((m) => m.id)).toEqual(["msg_real_d"])
    )

    for (const frame of frames.slice(from)) {
      expect(frame.source).toBe("events")
      expect(shownBodies(frame)).toEqual(["my doubled reply"])
    }
  })

  it("shows no phantom '1 more' gap when conversation:updated beats the message echo", async () => {
    // Live-observed order (dev repro): the server's conversation aggregate lands
    // BEFORE the echo swaps the optimistic row, so messageIds lists a real id the
    // rail hasn't seen while the same message is still on screen under its client
    // id. The card must not count that id as a hidden message above the very
    // reply it refers to.
    await db.events.bulkPut([msgEvent("m1", "the opening", 1, STREAM)])
    const lone = makePost({ messageIds: ["m1"], openingId: "m1", streamIds: [STREAM] })
    const { frames, result, rerender } = renderRecorded(lone, "channel")
    await waitFor(() => expect(result.current.source).toBe("events"))

    await db.events.put({
      id: "temp_p",
      workspaceId: WS,
      streamId: STREAM,
      sequence: "1700000000002",
      _sequenceNum: 1700000000002,
      eventType: "message_created",
      payload: { messageId: "temp_p", contentMarkdown: "my racing reply", reactions: {}, conversationId: "conv_1" },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(3).toISOString(),
      _cachedAt: 3,
      _status: "pending",
    } as CachedEvent)
    await waitFor(() => expect(shownBodies(result.current)).toEqual(["my racing reply"]))
    const from = frames.length

    // conversation:updated first: the real id joins messageIds, echo not yet in.
    rerender(makePost({ messageIds: ["m1", "msg_real_p"], openingId: "m1", streamIds: [STREAM] }))
    await waitFor(() => expect(shownBodies(result.current)).toEqual(["my racing reply"]))

    // Echo swap second.
    await db.transaction("rw", db.events, async () => {
      await db.events.put({
        id: "msg_real_p",
        workspaceId: WS,
        streamId: STREAM,
        sequence: "2",
        _sequenceNum: 2,
        eventType: "message_created",
        payload: {
          messageId: "msg_real_p",
          contentMarkdown: "my racing reply",
          reactions: {},
          conversationId: "conv_1",
        },
        actorId: "usr_1",
        actorType: "user",
        createdAt: new Date(4).toISOString(),
        _cachedAt: 4,
      } as CachedEvent)
      await db.events.delete("temp_p")
    })
    await waitFor(() => expect(result.current.replies.map((m) => m.id)).toEqual(["msg_real_p"]))

    // In every frame: the reply renders exactly once, and nothing reads as hidden
    // (a phantom gap would be totalReplies exceeding the rendered reply rows).
    for (const frame of frames.slice(from)) {
      expect(shownBodies(frame)).toEqual(["my racing reply"])
      expect(Math.max(0, frame.totalReplies - frame.replies.length)).toBe(0)
    }
  })

  it("keeps counting unsynced older history while a send is in flight (discount only covers episode arrivals)", async () => {
    // The conversation has a real reply the device never synced (r_old): the card
    // honestly shows "1 more". Sending a new reply must NOT discount r_old — only
    // an id that JOINS messageIds during the pending episode can be the pending
    // row's server identity.
    await db.events.bulkPut([msgEvent("m1", "the opening", 1, STREAM)])
    const before = makePost({ messageIds: ["m1", "r_old"], openingId: "m1", streamIds: [STREAM] })
    const { frames, result, rerender } = renderRecorded(before, "channel")
    await waitFor(() => expect(result.current.source).toBe("events"))
    expect(result.current.totalReplies).toBe(1)
    const from = frames.length

    // Viewer sends: optimistic pending row appears (tagged, not in messageIds).
    await db.events.put({
      id: "temp_q",
      workspaceId: WS,
      streamId: STREAM,
      sequence: "1700000000003",
      _sequenceNum: 1700000000003,
      eventType: "message_created",
      payload: { messageId: "temp_q", contentMarkdown: "my new reply", reactions: {}, conversationId: "conv_1" },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(5).toISOString(),
      _cachedAt: 5,
      _status: "pending",
    } as CachedEvent)
    await waitFor(() => expect(result.current.pendingReplies.map((m) => m.id)).toEqual(["temp_q"]))

    // conversation:updated for the new reply (echo race): its real id joins
    // messageIds while the rail hasn't seen it.
    rerender(makePost({ messageIds: ["m1", "r_old", "msg_new_q"], openingId: "m1", streamIds: [STREAM] }))
    await waitFor(() => expect([...result.current.replies, ...result.current.pendingReplies].length).toBeGreaterThan(0))

    // Echo swap.
    await db.transaction("rw", db.events, async () => {
      await db.events.put({
        id: "msg_new_q",
        workspaceId: WS,
        streamId: STREAM,
        sequence: "2",
        _sequenceNum: 2,
        eventType: "message_created",
        payload: { messageId: "msg_new_q", contentMarkdown: "my new reply", reactions: {}, conversationId: "conv_1" },
        actorId: "usr_1",
        actorType: "user",
        createdAt: new Date(6).toISOString(),
        _cachedAt: 6,
      } as CachedEvent)
      await db.events.delete("temp_q")
    })
    await waitFor(() => expect(result.current.replies.map((m) => m.id)).toEqual(["msg_new_q"]))

    // In every frame the unsynced older reply keeps its honest "1 more" slot:
    // total minus rendered replies is exactly 1 (r_old) — the in-flight send
    // never zeroes it out, and the new id never double-counts.
    for (const frame of frames.slice(from)) {
      expect(Math.max(0, frame.totalReplies - frame.replies.length)).toBe(1)
    }
  })

  it("tears a drained rail down once the grace elapses (no subscription leak)", async () => {
    await db.events.bulkPut([msgEvent("m1", "the opening", 1)])
    const post = makePost({ messageIds: ["m1"], openingId: "m1" })
    const { result, unmount } = renderHook(() => useBoardCardMessages(post))
    await waitFor(() => expect(result.current.source).toBe("events"))
    expect(__boardRailRegistrySize()).toBeGreaterThan(0)

    // Fake timers only around the unmount so the teardown setTimeout is
    // controllable; the async rail setup above ran under real timers.
    vi.useFakeTimers()
    try {
      unmount()
      // The grace holds the rail briefly after the last subscriber leaves…
      expect(__boardRailRegistrySize()).toBeGreaterThan(0)
      // …and the deadline actually drains it (the leak half of the contract).
      vi.advanceTimersByTime(60_000)
      expect(__boardRailRegistrySize()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("holds the last live view (not the projection) while a brand-new gating rail loads", async () => {
    const THREAD = "stream_fresh_gating"
    // The thread's reply is synced, but the thread is NOT discoverable from
    // db.streams (no stream row yet) — the card learns of it only when streamIds
    // widen, so the widened set brings in a never-before-subscribed gating rail.
    await db.events.bulkPut([msgEvent("m1", "the opening", 1, STREAM), msgEvent("r1", "thread reply", 2, THREAD)])
    // No recentMessages naming THREAD (that would gate it from the first render
    // and defeat the widen): the card knows nothing of the thread until the
    // rerender introduces it as a brand-new, never-subscribed gating rail.
    const before = makePost({ messageIds: ["m1", "r1"], openingId: "m1", streamIds: [STREAM] })
    const { frames, result, rerender } = renderRecorded(before)
    await waitFor(() => expect(result.current.source).toBe("events"))
    const from = frames.length

    rerender(makePost({ messageIds: ["m1", "r1"], openingId: "m1", streamIds: [STREAM, THREAD] }))
    await waitFor(() => expect(result.current.replies.map((m) => m.contentMarkdown)).toEqual(["thread reply"]))

    // While the fresh thread rail resolves, the card must keep its live view —
    // the opening body must never flash back to the stale projection copy.
    for (const frame of frames.slice(from)) {
      expect(frame.source).toBe("events")
      expect(frame.openingMessage?.contentMarkdown).toBe("the opening")
    }
  })
})

describe("useStableReplyWindow", () => {
  function reply(id: string): RenderableMessage {
    return {
      id,
      streamId: STREAM,
      authorId: "usr_1",
      authorType: "user",
      contentMarkdown: id,
      reactions: {},
      createdAt: new Date(0).toISOString(),
      editedAt: null,
    } as RenderableMessage
  }
  const ids = (messages: RenderableMessage[]) => messages.map((m) => m.id)

  function renderWindow(convId: string, replies: RenderableMessage[]) {
    return renderHook(
      (p: { convId: string; replies: RenderableMessage[] }) => useStableReplyWindow(p.convId, p.replies),
      {
        initialProps: { convId, replies },
      }
    )
  }

  it("previews the trailing cap at first reveal", () => {
    const { result } = renderWindow("conv_1", ["r1", "r2", "r3", "r4", "r5"].map(reply))
    expect(ids(result.current)).toEqual(["r3", "r4", "r5"])
  })

  it("grows on a new arrival instead of evicting the oldest visible reply", () => {
    const { result, rerender } = renderWindow("conv_1", ["r1", "r2", "r3", "r4", "r5"].map(reply))
    expect(ids(result.current)).toEqual(["r3", "r4", "r5"])

    rerender({ convId: "conv_1", replies: ["r1", "r2", "r3", "r4", "r5", "r6"].map(reply) })
    expect(ids(result.current)).toEqual(["r3", "r4", "r5", "r6"])

    rerender({ convId: "conv_1", replies: ["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map(reply) })
    expect(ids(result.current)).toEqual(["r3", "r4", "r5", "r6", "r7"])
  })

  it("re-anchors on the oldest surviving shown reply when the anchor is deleted", () => {
    const { result, rerender } = renderWindow("conv_1", ["r1", "r2", "r3", "r4", "r5"].map(reply))
    expect(ids(result.current)).toEqual(["r3", "r4", "r5"])

    rerender({ convId: "conv_1", replies: ["r1", "r2", "r4", "r5"].map(reply) })
    expect(ids(result.current)).toEqual(["r4", "r5"])
  })

  it("keeps a late-syncing older reply under the gap instead of pushing shown rows down", () => {
    const { result, rerender } = renderWindow("conv_1", ["r3", "r4", "r5"].map(reply))
    expect(ids(result.current)).toEqual(["r3", "r4", "r5"])

    rerender({ convId: "conv_1", replies: ["r2", "r3", "r4", "r5"].map(reply) })
    expect(ids(result.current)).toEqual(["r3", "r4", "r5"])
  })

  it("keeps a late-syncing mid-window reply under the gap instead of inserting between shown rows", () => {
    const { result, rerender } = renderWindow("conv_1", ["r3", "r5", "r6"].map(reply))
    expect(ids(result.current)).toEqual(["r3", "r5", "r6"])

    // r4 syncs late, landing BETWEEN shown rows — revealing it would push r5/r6
    // down. It stays under the "N more" gap; only rows after the last shown
    // reply may append.
    rerender({ convId: "conv_1", replies: ["r3", "r4", "r5", "r6"].map(reply) })
    expect(ids(result.current)).toEqual(["r3", "r5", "r6"])
  })

  it("resets the shown window when recycled onto another conversation", () => {
    const { result, rerender } = renderWindow("conv_1", ["r1", "r2", "r3", "r4"].map(reply))
    expect(ids(result.current)).toEqual(["r2", "r3", "r4"])

    rerender({ convId: "conv_2", replies: ["x1", "x2", "x3", "x4"].map(reply) })
    expect(ids(result.current)).toEqual(["x2", "x3", "x4"])
  })
})
