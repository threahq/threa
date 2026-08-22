import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { invalidatePointersForEvent, POINTER_INVALIDATED_EVENT } from "./outbox-handler"
import { SharedMessageRepository } from "./repository"
import { MessageRepository } from "../repository"
import { E2eStreamsRepository } from "../../e2e-streams"
import * as hydration from "./hydration"
import { sharedMessageSlotKey } from "@threa/types"

beforeEach(() => {
  spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
  // Echo each requested reference back as an ok slot under its own key, so the
  // assertions below read the keys the room would actually look up.
  spyOn(hydration, "hydrateSharedMessageRefsForRoom").mockImplementation(
    async (_db, _ws, _target, refs) =>
      Object.fromEntries(
        [...refs].map((ref) => [
          sharedMessageSlotKey(ref.messageId, ref.version, ref.range),
          {
            type: "sharedMessage",
            state: "ok",
            messageId: ref.messageId,
            streamId: "stream_src",
            version: ref.version ?? 1,
            currentRevision: 2,
            range: ref.range,
          },
        ])
      ) as any
  )
})

afterEach(() => {
  mock.restore()
})

interface ShareFixture {
  sourceMessageId: string
  targetStreamId: string
  /** Node attrs beyond `messageId`/`streamId` — the pin the room's message carries. */
  pin?: { version?: number; range?: { from: number; to: number } }
}

/**
 * Stub the share rows AND the share-carrying messages they name: the handler
 * hydrates the references those message bodies hold, not the bare source ids.
 */
function stubShares(fixtures: ShareFixture[]) {
  const rows = fixtures.map((f) => ({
    sourceMessageId: f.sourceMessageId,
    targetStreamId: f.targetStreamId,
    shareMessageId: `msg_share_${f.targetStreamId}`,
  }))
  spyOn(SharedMessageRepository, "listBySourceMessageIds").mockResolvedValue(rows as any)

  const bodies = new Map<string, unknown[]>()
  fixtures.forEach((f, index) => {
    const shareMessageId = rows[index].shareMessageId
    const nodes = bodies.get(shareMessageId) ?? []
    nodes.push({
      type: "sharedMessage",
      attrs: { messageId: f.sourceMessageId, streamId: "stream_src", ...(f.pin ?? {}) },
    })
    bodies.set(shareMessageId, nodes)
  })
  spyOn(MessageRepository, "findByIdsInWorkspace").mockImplementation(
    async (_db: unknown, _ws: string, ids: string[]) =>
      new Map(
        ids
          .filter((id) => bodies.has(id))
          .map((id) => [id, { id, contentJson: { type: "doc", content: bodies.get(id) } }])
      ) as any
  )
}

function fakeIo() {
  const emits: Array<{ room: string; event: string; payload: unknown }> = []
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emits.push({ room, event, payload })
        },
      }
    },
  }
  return { io: io as any, emits }
}

describe("invalidatePointersForEvent", () => {
  it("is a no-op for event types that don't affect pointer renders", async () => {
    const list = spyOn(SharedMessageRepository, "listBySourceMessageIds").mockResolvedValue([])
    const { io } = fakeIo()
    await invalidatePointersForEvent(
      { eventType: "stream:created", payload: { workspaceId: "ws_1" } } as any,
      {} as any,
      io
    )
    expect(list).not.toHaveBeenCalled()
  })

  it("is a no-op when no pointers reference the changed source", async () => {
    spyOn(SharedMessageRepository, "listBySourceMessageIds").mockResolvedValue([])
    const { io, emits } = fakeIo()
    await invalidatePointersForEvent(
      {
        eventType: "message:deleted",
        payload: { workspaceId: "ws_1", streamId: "stream_src", messageId: "msg_a" },
      } as any,
      {} as any,
      io
    )
    expect(emits).toEqual([])
  })

  it("emits pointer:invalidated once per distinct target stream when pointers exist", async () => {
    stubShares([
      { sourceMessageId: "msg_a", targetStreamId: "stream_t1" },
      { sourceMessageId: "msg_a", targetStreamId: "stream_t2" },
      { sourceMessageId: "msg_a", targetStreamId: "stream_t1" }, // duplicate → deduped
    ])
    const { io, emits } = fakeIo()
    await invalidatePointersForEvent(
      {
        eventType: "message:deleted",
        payload: { workspaceId: "ws_1", streamId: "stream_src", messageId: "msg_a" },
      } as any,
      {} as any,
      io
    )
    expect(emits.map((e) => e.room).sort()).toEqual(["ws:ws_1:stream:stream_t1", "ws:ws_1:stream:stream_t2"])
    expect(emits[0].event).toBe(POINTER_INVALIDATED_EVENT)
    expect(emits[0].payload).toMatchObject({
      workspaceId: "ws_1",
      sourceMessageId: "msg_a",
      // Dual-publish from one hydration result: canonical namespaced map plus the
      // temporary legacy bare-key map carry the identical value.
      slots: {
        "shared:msg_a": { type: "sharedMessage", state: "ok", messageId: "msg_a", streamId: "stream_src" },
      },
      sharedMessages: {
        msg_a: { type: "sharedMessage", state: "ok", messageId: "msg_a", streamId: "stream_src" },
      },
    })
  })

  it("emits the pinned slot key a pinned node in the room actually looks up", async () => {
    stubShares([
      { sourceMessageId: "msg_a", targetStreamId: "stream_t1", pin: { version: 1, range: { from: 1, to: 6 } } },
    ])
    const { io, emits } = fakeIo()
    await invalidatePointersForEvent(
      {
        eventType: "message:edited",
        payload: { workspaceId: "ws_1", streamId: "stream_src", event: { payload: { messageId: "msg_a" } } },
      } as any,
      {} as any,
      io
    )

    const slots = (emits[0].payload as { slots: Record<string, unknown> }).slots
    // The edit that triggered this bumped the source to revision 2; the pinned
    // card keeps its own body and learns the source moved on.
    expect(slots).toEqual({
      [sharedMessageSlotKey("msg_a", 1, { from: 1, to: 6 })]: {
        type: "sharedMessage",
        state: "ok",
        messageId: "msg_a",
        streamId: "stream_src",
        version: 1,
        currentRevision: 2,
        range: { from: 1, to: 6 },
      },
    })
    expect(slots["shared:msg_a"]).toBeUndefined()
  })

  it("keeps the bare key for a legacy unpinned node in the room", async () => {
    stubShares([{ sourceMessageId: "msg_a", targetStreamId: "stream_t1" }])
    const { io, emits } = fakeIo()
    await invalidatePointersForEvent(
      {
        eventType: "message:edited",
        payload: { workspaceId: "ws_1", streamId: "stream_src", event: { payload: { messageId: "msg_a" } } },
      } as any,
      {} as any,
      io
    )
    expect(Object.keys((emits[0].payload as { slots: Record<string, unknown> }).slots)).toEqual(["shared:msg_a"])
  })

  it("hydrates nothing for a target whose share-carrying message is gone", async () => {
    spyOn(SharedMessageRepository, "listBySourceMessageIds").mockResolvedValue([
      { sourceMessageId: "msg_a", targetStreamId: "stream_t1", shareMessageId: "msg_gone" },
    ] as any)
    spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map())
    const { io, emits } = fakeIo()
    await invalidatePointersForEvent(
      {
        eventType: "message:deleted",
        payload: { workspaceId: "ws_1", streamId: "stream_src", messageId: "msg_a" },
      } as any,
      {} as any,
      io
    )
    // The room still gets told to refetch; there is simply nothing to inline.
    expect(emits).toHaveLength(1)
    expect((emits[0].payload as { slots: Record<string, unknown> }).slots).toEqual({})
  })

  it("emits the full per-target hydration map, including nested entries (B4)", async () => {
    stubShares([{ sourceMessageId: "msg_a", targetStreamId: "stream_t1" }])
    // The one hydration call resolves the seed AND the nested pointer an edit
    // just added — the emit must carry every entry, not just the top-level
    // source, or the inner card skeletons until a REST replace.
    spyOn(hydration, "hydrateSharedMessageRefsForRoom").mockResolvedValue({
      "shared:msg_a": { type: "sharedMessage", state: "ok", messageId: "msg_a", streamId: "stream_src" },
      "shared:msg_nested": { type: "sharedMessage", state: "ok", messageId: "msg_nested", streamId: "stream_inner" },
    } as any)
    const { io, emits } = fakeIo()
    await invalidatePointersForEvent(
      {
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_src",
          event: { payload: { messageId: "msg_a" } },
        },
      } as any,
      {} as any,
      io
    )
    expect(emits).toHaveLength(1)
    expect(emits[0].payload).toMatchObject({
      workspaceId: "ws_1",
      targetStreamId: "stream_t1",
      sourceMessageId: "msg_a",
      slots: {
        "shared:msg_a": { type: "sharedMessage", state: "ok", messageId: "msg_a", streamId: "stream_src" },
        "shared:msg_nested": { type: "sharedMessage", state: "ok", messageId: "msg_nested", streamId: "stream_inner" },
      },
      sharedMessages: {
        msg_a: { type: "sharedMessage", state: "ok", messageId: "msg_a", streamId: "stream_src" },
        msg_nested: { type: "sharedMessage", state: "ok", messageId: "msg_nested", streamId: "stream_inner" },
      },
    })
  })

  it("reads the edited message id from the nested outbox payload for message:edited events", async () => {
    const list = spyOn(SharedMessageRepository, "listBySourceMessageIds").mockResolvedValue([])
    const { io } = fakeIo()
    await invalidatePointersForEvent(
      {
        eventType: "message:edited",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_src",
          event: { payload: { messageId: "msg_edited" } },
        },
      } as any,
      {} as any,
      io
    )
    expect(list).toHaveBeenCalledWith({}, "ws_1", ["msg_edited"])
  })

  it("fans out a per-source pointer:invalidated for each share when a messages:moved event lands", async () => {
    stubShares([
      { sourceMessageId: "msg_a", targetStreamId: "stream_t1" },
      { sourceMessageId: "msg_b", targetStreamId: "stream_t1" },
      { sourceMessageId: "msg_a", targetStreamId: "stream_t2" },
    ])
    const { io, emits } = fakeIo()
    await invalidatePointersForEvent(
      {
        eventType: "messages:moved",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_src",
          movedMessageIds: ["msg_a", "msg_b", "msg_c"],
        },
      } as any,
      {} as any,
      io
    )
    // One emit per (target, source) pair: (t1,a), (t1,b), (t2,a). msg_c has
    // no shares so it doesn't surface.
    expect(emits).toHaveLength(3)
    const pairs = emits.map((e) => `${e.room}|${(e.payload as { sourceMessageId: string }).sourceMessageId}`).sort()
    expect(pairs).toEqual([
      "ws:ws_1:stream:stream_t1|msg_a",
      "ws:ws_1:stream:stream_t1|msg_b",
      "ws:ws_1:stream:stream_t2|msg_a",
    ])
    expect(emits.every((e) => e.event === POINTER_INVALIDATED_EVENT)).toBe(true)
  })

  it("short-circuits before the share lookup when the source stream is end-to-end encrypted", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const list = spyOn(SharedMessageRepository, "listBySourceMessageIds").mockResolvedValue([])
    const { io, emits } = fakeIo()
    await invalidatePointersForEvent(
      {
        eventType: "message:deleted",
        payload: { workspaceId: "ws_1", streamId: "stream_src", messageId: "msg_a" },
      } as any,
      {} as any,
      io
    )
    expect(list).not.toHaveBeenCalled()
    expect(emits).toEqual([])
  })

  it("passes every moved message id to the share lookup when a messages:moved event lands", async () => {
    const list = spyOn(SharedMessageRepository, "listBySourceMessageIds").mockResolvedValue([])
    const { io } = fakeIo()
    await invalidatePointersForEvent(
      {
        eventType: "messages:moved",
        payload: {
          workspaceId: "ws_1",
          streamId: "stream_src",
          movedMessageIds: ["msg_a", "msg_b"],
        },
      } as any,
      {} as any,
      io
    )
    expect(list).toHaveBeenCalledWith({}, "ws_1", ["msg_a", "msg_b"])
  })
})
