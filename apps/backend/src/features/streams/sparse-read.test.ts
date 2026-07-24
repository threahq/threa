import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { applySparseRead, applySparseUnread } from "./sparse-read"
import { StreamMemberRepository } from "./member-repository"
import { ReadStateRepository } from "./read-state-repository"
import { StreamEventRepository } from "./event-repository"
import { SparseReadRepository } from "./sparse-read-repository"
import { OutboxRepository } from "../../lib/outbox"

const db = {} as never

describe("applySparseRead read-state shadow", () => {
  beforeEach(() => {
    spyOn(SparseReadRepository, "insertReads").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "pruneAtOrBelow").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "listOverlayIds").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    // Default: no standalone row — the seed falls back to the membership row.
    spyOn(ReadStateRepository, "get").mockResolvedValue(null)
  })

  afterEach(() => mock.restore())

  it("advances read state on the same client when compaction moves the membership watermark", async () => {
    spyOn(StreamMemberRepository, "findByStreamAndMemberForUpdate").mockResolvedValue({
      streamId: "stream_1",
      memberId: "usr_1",
      lastReadEventId: "evt_old",
    } as never)
    // Old watermark resolves to sequence 10; compaction target sits above it at 20.
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 10n } as never)
    spyOn(SparseReadRepository, "findCompactionTarget").mockResolvedValue({
      eventId: "evt_new",
      sequence: 20n,
    } as never)
    spyOn(SparseReadRepository, "findTrailingDeletedRunEnd").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(2)
    const memberUpdate = spyOn(StreamMemberRepository, "update").mockResolvedValue(null)
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)

    await applySparseRead(db, { workspaceId: "ws_1", streamId: "stream_1", memberId: "usr_1", messageIds: ["msg_1"] })

    expect(memberUpdate).toHaveBeenCalledWith(db, "stream_1", "usr_1", { lastReadEventId: "evt_new" })
    expect(readStateAdvance).toHaveBeenCalledWith(db, "stream_1", "usr_1", "evt_new")
  })

  it("writes no read state when compaction leaves the watermark unchanged", async () => {
    spyOn(StreamMemberRepository, "findByStreamAndMemberForUpdate").mockResolvedValue({
      streamId: "stream_1",
      memberId: "usr_1",
      lastReadEventId: "evt_old",
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 10n } as never)
    spyOn(SparseReadRepository, "findCompactionTarget").mockResolvedValue(null)
    spyOn(SparseReadRepository, "findTrailingDeletedRunEnd").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
    const memberUpdate = spyOn(StreamMemberRepository, "update").mockResolvedValue(null)
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)

    await applySparseRead(db, { workspaceId: "ws_1", streamId: "stream_1", memberId: "usr_1", messageIds: ["msg_1"] })

    expect(memberUpdate).not.toHaveBeenCalled()
    expect(readStateAdvance).not.toHaveBeenCalled()
  })
})

describe("applySparseRead effective watermark seed", () => {
  beforeEach(() => {
    spyOn(SparseReadRepository, "insertReads").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "pruneAtOrBelow").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "listOverlayIds").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "findCompactionTarget").mockResolvedValue(null)
    spyOn(SparseReadRepository, "findTrailingDeletedRunEnd").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(1)
  })

  afterEach(() => mock.restore())

  it("seeds from the read-state row when it sits above a regressed membership, converging membership upward", async () => {
    spyOn(StreamMemberRepository, "findByStreamAndMemberForUpdate").mockResolvedValue({
      streamId: "stream_1",
      memberId: "usr_1",
      lastReadEventId: "evt_old",
    } as never)
    // A stale device regressed membership to evt_old (seq 10); the monotonic
    // read-state row still stands at evt_rs (seq 30).
    spyOn(ReadStateRepository, "get").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_rs",
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 30n } as never)
    const memberUpdate = spyOn(StreamMemberRepository, "update").mockResolvedValue(null)
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)

    const snapshot = await applySparseRead(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_1"],
    })

    // Membership pops UP to the effective frontier (never the reverse).
    expect(memberUpdate).toHaveBeenCalledWith(db, "stream_1", "usr_1", { lastReadEventId: "evt_rs" })
    expect(readStateAdvance).toHaveBeenCalledWith(db, "stream_1", "usr_1", "evt_rs")
    expect(snapshot.lastReadEventId).toBe("evt_rs")
    expect(snapshot.lastReadSequence).toBe("30")
  })

  it("a present read-state row with NULL watermark beats a non-null membership watermark", async () => {
    spyOn(StreamMemberRepository, "findByStreamAndMemberForUpdate").mockResolvedValue({
      streamId: "stream_1",
      memberId: "usr_1",
      lastReadEventId: "evt_old",
    } as never)
    // Explicit unread-to-zero: the row exists with a NULL watermark. Row
    // presence is authoritative — the non-null membership column is ignored.
    const readStateGet = spyOn(ReadStateRepository, "get").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: null,
    } as never)
    const ordinalForEvent = spyOn(StreamEventRepository, "getMessageOrdinalForEvent")
    const memberUpdate = spyOn(StreamMemberRepository, "update").mockResolvedValue(null)
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)

    const snapshot = await applySparseRead(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_1"],
    })

    expect(readStateGet).toHaveBeenCalledWith(db, "stream_1", "usr_1")
    // NULL seed: no watermark sequence to resolve from the event table.
    expect(ordinalForEvent).not.toHaveBeenCalled()
    expect(memberUpdate).toHaveBeenCalledWith(db, "stream_1", "usr_1", { lastReadEventId: null })
    // A null frontier can't advance the monotonic store.
    expect(readStateAdvance).not.toHaveBeenCalled()
    expect(snapshot.lastReadEventId).toBeNull()
    expect(snapshot.lastReadSequence).toBe("0")
  })

  it("a non-member leg seeds from its ensured+locked standalone row and compacts into it — never touching membership", async () => {
    spyOn(StreamMemberRepository, "findByStreamAndMemberForUpdate").mockResolvedValue(null)
    // The leg's standalone row (ensured + locked FOR UPDATE — the non-member's
    // serialization point) carries a NULL watermark: never read.
    const ensureForUpdate = spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
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
    const memberUpdate = spyOn(StreamMemberRepository, "update").mockResolvedValue(null)
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)
    const pruneAtOrBelow = spyOn(SparseReadRepository, "pruneAtOrBelow").mockResolvedValue(undefined)

    const snapshot = await applySparseRead(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_1"],
    })

    expect(ensureForUpdate).toHaveBeenCalledWith(db, "stream_1", "usr_1")
    // Membership is participation: never written on a non-member read (INV-62).
    expect(memberUpdate).not.toHaveBeenCalled()
    expect(readStateAdvance).toHaveBeenCalledWith(db, "stream_1", "usr_1", "evt_new")
    expect(pruneAtOrBelow).toHaveBeenCalledWith(db, "stream_1", "usr_1", 20n)
    expect(snapshot.lastReadEventId).toBe("evt_new")
    expect(snapshot.lastReadSequence).toBe("20")
  })

  it("a non-member leg with no compaction target leaves the standalone watermark where it stands", async () => {
    spyOn(StreamMemberRepository, "findByStreamAndMemberForUpdate").mockResolvedValue(null)
    spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: null,
    } as never)
    spyOn(SparseReadRepository, "findCompactionTarget").mockResolvedValue(null)
    spyOn(SparseReadRepository, "findTrailingDeletedRunEnd").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(0)
    spyOn(SparseReadRepository, "listOverlayIds").mockResolvedValue(["msg_3"])
    const memberUpdate = spyOn(StreamMemberRepository, "update").mockResolvedValue(null)
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)

    const snapshot = await applySparseRead(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_3"],
    })

    expect(memberUpdate).not.toHaveBeenCalled()
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

describe("applySparseUnread read-state shadow", () => {
  beforeEach(() => {
    spyOn(SparseReadRepository, "deleteReads").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "deleteAtOrAbove").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "pruneAtOrBelow").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "listOverlayIds").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
    // Default: no standalone row — the seed falls back to the membership row.
    spyOn(ReadStateRepository, "get").mockResolvedValue(null)
  })

  afterEach(() => mock.restore())

  it("regresses read state (set) on the same client when the watermark moves back", async () => {
    spyOn(StreamMemberRepository, "findByStreamAndMemberForUpdate").mockResolvedValue({
      streamId: "stream_1",
      memberId: "usr_1",
      lastReadEventId: "evt_5",
    } as never)
    // Watermark at sequence 50 sits past the earliest affected message (30), so it regresses.
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 50n } as never)
    spyOn(StreamEventRepository, "findEarliestMessageEvent").mockResolvedValue({ sequence: 30n } as never)
    spyOn(StreamEventRepository, "findPreviousMessageEvent").mockResolvedValue({ id: "evt_4", sequence: 25n } as never)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(2)
    const memberUpdate = spyOn(StreamMemberRepository, "update").mockResolvedValue(null)
    const readStateSet = spyOn(ReadStateRepository, "set").mockResolvedValue(undefined)

    await applySparseUnread(db, { workspaceId: "ws_1", streamId: "stream_1", memberId: "usr_1", messageIds: ["msg_5"] })

    expect(memberUpdate).toHaveBeenCalledWith(db, "stream_1", "usr_1", { lastReadEventId: "evt_4" })
    expect(readStateSet).toHaveBeenCalledWith(db, "stream_1", "usr_1", "evt_4")
  })

  it("seeds the regress decision from the read-state row when it sits above membership", async () => {
    spyOn(StreamMemberRepository, "findByStreamAndMemberForUpdate").mockResolvedValue({
      streamId: "stream_1",
      memberId: "usr_1",
      lastReadEventId: "evt_old",
    } as never)
    // Membership regressed to seq 10 during the shadow window; read-state
    // stands at seq 50, past the earliest affected message (30) — so the
    // explicit unread regresses BOTH stores to just before it.
    spyOn(ReadStateRepository, "get").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_rs",
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 50n } as never)
    spyOn(StreamEventRepository, "findEarliestMessageEvent").mockResolvedValue({ sequence: 30n } as never)
    spyOn(StreamEventRepository, "findPreviousMessageEvent").mockResolvedValue({
      id: "evt_prev",
      sequence: 25n,
    } as never)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(2)
    const memberUpdate = spyOn(StreamMemberRepository, "update").mockResolvedValue(null)
    const readStateSet = spyOn(ReadStateRepository, "set").mockResolvedValue(undefined)

    await applySparseUnread(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_5"],
    })

    expect(memberUpdate).toHaveBeenCalledWith(db, "stream_1", "usr_1", { lastReadEventId: "evt_prev" })
    expect(readStateSet).toHaveBeenCalledWith(db, "stream_1", "usr_1", "evt_prev")
  })

  it("regresses the standalone store for a non-member leg — never writing membership", async () => {
    spyOn(StreamMemberRepository, "findByStreamAndMemberForUpdate").mockResolvedValue(null)
    // The ensured+locked standalone row stands at seq 50, past the earliest
    // affected message (30) — the explicit unread regresses it.
    spyOn(ReadStateRepository, "ensureForUpdate").mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_5",
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 50n } as never)
    spyOn(StreamEventRepository, "findEarliestMessageEvent").mockResolvedValue({ sequence: 30n } as never)
    spyOn(StreamEventRepository, "findPreviousMessageEvent").mockResolvedValue({
      id: "evt_prev",
      sequence: 25n,
    } as never)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(2)
    const memberUpdate = spyOn(StreamMemberRepository, "update").mockResolvedValue(null)
    const readStateSet = spyOn(ReadStateRepository, "set").mockResolvedValue(undefined)
    const outboxInsert = spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    const snapshot = await applySparseUnread(db, {
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "usr_1",
      messageIds: ["msg_5"],
    })

    expect(memberUpdate).not.toHaveBeenCalled()
    expect(readStateSet).toHaveBeenCalledWith(db, "stream_1", "usr_1", "evt_prev")
    expect(snapshot.lastReadEventId).toBe("evt_prev")
    expect(snapshot.lastReadSequence).toBe("25")
    expect(outboxInsert).toHaveBeenCalledWith(
      db,
      "stream:read_set",
      expect.objectContaining({ streamId: "stream_1", authorId: "usr_1", lastReadEventId: "evt_prev" })
    )
  })

  it("sets read state to null when the target is the first message", async () => {
    spyOn(StreamMemberRepository, "findByStreamAndMemberForUpdate").mockResolvedValue({
      streamId: "stream_1",
      memberId: "usr_1",
      lastReadEventId: "evt_1",
    } as never)
    spyOn(StreamEventRepository, "getMessageOrdinalForEvent").mockResolvedValue({ sequence: 10n } as never)
    spyOn(StreamEventRepository, "findEarliestMessageEvent").mockResolvedValue({ sequence: 10n } as never)
    spyOn(StreamEventRepository, "findPreviousMessageEvent").mockResolvedValue(null)
    spyOn(StreamEventRepository, "countMessagesThrough").mockResolvedValue(0)
    spyOn(StreamMemberRepository, "update").mockResolvedValue(null)
    const readStateSet = spyOn(ReadStateRepository, "set").mockResolvedValue(undefined)

    await applySparseUnread(db, { workspaceId: "ws_1", streamId: "stream_1", memberId: "usr_1", messageIds: ["msg_1"] })

    expect(readStateSet).toHaveBeenCalledWith(db, "stream_1", "usr_1", null)
  })
})
