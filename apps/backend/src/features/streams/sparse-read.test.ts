import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { applySparseRead, applySparseUnread } from "./sparse-read"
import { ReadStateRepository } from "./read-state-repository"
import { StreamEventRepository } from "./event-repository"
import { SparseReadRepository } from "./sparse-read-repository"
import { OutboxRepository } from "../../lib/outbox"

const db = {} as never

describe("applySparseRead", () => {
  beforeEach(() => {
    spyOn(SparseReadRepository, "insertReads").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "pruneAtOrBelow").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "listOverlayIds").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
  })

  afterEach(() => mock.restore())

  it("advances the standalone frontier when compaction moves the watermark above the seed", async () => {
    // Seed (ensured + locked) stands at evt_old (seq 10); compaction target sits above it at 20.
    spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_old",
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 10n } as never)
    spyOn(SparseReadRepository, "findCompactionTarget").mockResolvedValue({
      eventId: "evt_new",
      sequence: 20n,
    } as never)
    spyOn(SparseReadRepository, "findTrailingDeletedRunEnd").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(2)
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)

    await applySparseRead(db, { workspaceId: "ws_1", streamId: "stream_1", memberId: "usr_1", messageIds: ["msg_1"] })

    expect(readStateAdvance).toHaveBeenCalledWith(db, "stream_1", "usr_1", "evt_new")
  })

  it("writes no read state when compaction leaves the watermark unchanged", async () => {
    spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_old",
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 10n } as never)
    spyOn(SparseReadRepository, "findCompactionTarget").mockResolvedValue(null)
    spyOn(SparseReadRepository, "findTrailingDeletedRunEnd").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)

    await applySparseRead(db, { workspaceId: "ws_1", streamId: "stream_1", memberId: "usr_1", messageIds: ["msg_1"] })

    expect(readStateAdvance).not.toHaveBeenCalled()
  })

  it("a present NULL watermark (explicit unread-to-zero) seeds at sequence 0 and never advances on a null frontier", async () => {
    const ensureForUpdate = spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: null,
    } as never)
    const ordinalForEvent = spyOn(StreamEventRepository, "getMessageOrdinalForEvent")
    spyOn(SparseReadRepository, "findCompactionTarget").mockResolvedValue(null)
    spyOn(SparseReadRepository, "findTrailingDeletedRunEnd").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)

    const snapshot = await applySparseRead(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_1"],
    })

    expect(ensureForUpdate).toHaveBeenCalledWith(db, "stream_1", "usr_1")
    // NULL seed: no watermark sequence to resolve from the event table.
    expect(ordinalForEvent).not.toHaveBeenCalled()
    // A null frontier can't advance the monotonic store.
    expect(readStateAdvance).not.toHaveBeenCalled()
    expect(snapshot.lastReadEventId).toBeNull()
    expect(snapshot.lastReadSequence).toBe("0")
  })

  it("compacts a contiguous overlay run above a null watermark into the standalone row", async () => {
    // The ensured + locked row carries a NULL watermark: never read.
    spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: null,
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue(null)
    // A contiguous overlay run above the null watermark compacts to evt_new (seq 20).
    spyOn(SparseReadRepository, "findCompactionTarget").mockResolvedValue({
      eventId: "evt_new",
      sequence: 20n,
    } as never)
    spyOn(SparseReadRepository, "findTrailingDeletedRunEnd").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(2)
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)
    const pruneAtOrBelow = spyOn(SparseReadRepository, "pruneAtOrBelow").mockResolvedValue(undefined)

    const snapshot = await applySparseRead(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_1"],
    })

    expect(readStateAdvance).toHaveBeenCalledWith(db, "stream_1", "usr_1", "evt_new")
    expect(pruneAtOrBelow).toHaveBeenCalledWith(db, "stream_1", "usr_1", 20n)
    expect(snapshot.lastReadEventId).toBe("evt_new")
    expect(snapshot.lastReadSequence).toBe("20")
  })

  it("with no compaction target leaves the watermark where it stands and emits the absolute overlay", async () => {
    spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: null,
    } as never)
    spyOn(SparseReadRepository, "findCompactionTarget").mockResolvedValue(null)
    spyOn(SparseReadRepository, "findTrailingDeletedRunEnd").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(0)
    spyOn(SparseReadRepository, "listOverlayIds").mockResolvedValue(["msg_3"])
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)

    const snapshot = await applySparseRead(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_3"],
    })

    expect(readStateAdvance).not.toHaveBeenCalled()
    expect(snapshot).toEqual({
      streamId: "stream_1",
      readMessageIds: ["msg_3"],
      lastReadEventId: null,
      lastReadSequence: "0",
      lastReadOrdinal: 0,
      markedMessageIds: ["msg_3"],
    })
  })
})

describe("applySparseUnread", () => {
  beforeEach(() => {
    spyOn(SparseReadRepository, "deleteReads").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "deleteAtOrAbove").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "pruneAtOrBelow").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "listOverlayIds").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
  })

  afterEach(() => mock.restore())

  it("regresses the standalone frontier (set) when the watermark sits past the earliest affected message", async () => {
    // Watermark at sequence 50 sits past the earliest affected message (30), so it regresses.
    spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_5",
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 50n } as never)
    spyOn(StreamEventRepository, "findEarliestMessageEvent").mockResolvedValue({ sequence: 30n } as never)
    spyOn(StreamEventRepository, "findPreviousMessageEvent").mockResolvedValue({ id: "evt_4", sequence: 25n } as never)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(2)
    const readStateSet = spyOn(ReadStateRepository, "set").mockResolvedValue(undefined)
    const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const snapshot = await applySparseUnread(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_5"],
    })

    expect(readStateSet).toHaveBeenCalledWith(db, "stream_1", "usr_1", "evt_4")
    expect(snapshot.lastReadEventId).toBe("evt_4")
    expect(snapshot.lastReadSequence).toBe("25")
    expect(outboxInsert).toHaveBeenCalledWith(
      db,
      "stream:read_set",
      expect.objectContaining({ streamId: "stream_1", authorId: "usr_1", lastReadEventId: "evt_4" })
    )
  })

  it("sets the frontier to null when the target is the first message", async () => {
    spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_1",
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 10n } as never)
    spyOn(StreamEventRepository, "findEarliestMessageEvent").mockResolvedValue({ sequence: 10n } as never)
    spyOn(StreamEventRepository, "findPreviousMessageEvent").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(0)
    const readStateSet = spyOn(ReadStateRepository, "set").mockResolvedValue(undefined)

    await applySparseUnread(db, { workspaceId: "ws_1", streamId: "stream_1", memberId: "usr_1", messageIds: ["msg_1"] })

    expect(readStateSet).toHaveBeenCalledWith(db, "stream_1", "usr_1", null)
  })

  it("leaves the frontier untouched when it already sits behind the affected run", async () => {
    // Watermark at sequence 10 is behind the earliest affected message (30): the
    // overlay delete alone suffices, no regress, absolute snapshot emitted.
    spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_old",
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 10n } as never)
    spyOn(StreamEventRepository, "findEarliestMessageEvent").mockResolvedValue({ sequence: 30n } as never)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    spyOn(SparseReadRepository, "listOverlayIds").mockResolvedValue(["msg_9"])
    const readStateSet = spyOn(ReadStateRepository, "set").mockResolvedValue(undefined)
    const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const snapshot = await applySparseUnread(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_5"],
    })

    expect(readStateSet).not.toHaveBeenCalled()
    expect(snapshot.lastReadEventId).toBe("evt_old")
    expect(outboxInsert).toHaveBeenCalledWith(
      db,
      "stream:read_messages",
      expect.objectContaining({ streamId: "stream_1", readMessageIds: ["msg_9"] })
    )
  })
})
