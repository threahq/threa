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
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined)

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
    const readStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(undefined)

    await applySparseRead(db, { workspaceId: "ws_1", streamId: "stream_1", memberId: "usr_1", messageIds: ["msg_1"] })

    expect(memberUpdate).not.toHaveBeenCalled()
    expect(readStateAdvance).not.toHaveBeenCalled()
  })
})

describe("applySparseUnread read-state shadow", () => {
  beforeEach(() => {
    spyOn(SparseReadRepository, "deleteReads").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "deleteAtOrAbove").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "pruneAtOrBelow").mockResolvedValue(undefined as never)
    spyOn(SparseReadRepository, "listOverlayIds").mockResolvedValue([])
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
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
