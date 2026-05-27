import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { invalidatePointersForEvent, POINTER_INVALIDATED_EVENT } from "./outbox-handler"
import { SharedMessageRepository } from "./repository"
import { E2eStreamsRepository } from "../../e2e-streams"

beforeEach(() => {
  spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
})

afterEach(() => {
  mock.restore()
})

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
    spyOn(SharedMessageRepository, "listBySourceMessageIds").mockResolvedValue([
      { sourceMessageId: "msg_a", targetStreamId: "stream_t1" },
      { sourceMessageId: "msg_a", targetStreamId: "stream_t2" },
      { sourceMessageId: "msg_a", targetStreamId: "stream_t1" }, // duplicate → deduped
    ] as any)
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
    spyOn(SharedMessageRepository, "listBySourceMessageIds").mockResolvedValue([
      { sourceMessageId: "msg_a", targetStreamId: "stream_t1" },
      { sourceMessageId: "msg_b", targetStreamId: "stream_t1" },
      { sourceMessageId: "msg_a", targetStreamId: "stream_t2" },
    ] as any)
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
